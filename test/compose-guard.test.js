'use strict';

/* =========================================================
 * 写信弹窗「放弃确认」回归测试（零依赖，node test/compose-guard.test.js）
 *
 * 项目前端是无构建的原生 SPA，没有 npm 测试框架。这里用 Node 内置的 vm
 * 模块把 public/app.js 中写信相关的代码原样抽取出来执行，配合一个极简
 * DOM 桩，从而在不引入任何依赖的前提下验证真实源码的行为。
 *
 * 抽取的是真实函数（openComposer / openReplyComposer / insertQuote /
 * sendCompose / isComposerDirty ...），只把 IO 类依赖（api / showToast /
 * 列表刷新）换成桩，因此基线快照与发送中守卫都走的是生产代码路径。
 *
 * 抽取依赖源码中的注释标记；若标记被改动，脚本会直接报错提示。
 * ========================================================= */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// QA_APP_JS 仅用于「变异验证」：指向一份人工构造的缺陷版 app.js。
// 缺了这个钩子，变异脚本会「跑仓库原文件却以为跑的是变体」→ 变体恒不被抓（假阴性）。
const APP_JS_PATH = process.env.QA_APP_JS || path.join(__dirname, '..', 'public', 'app.js');
const SRC = fs.readFileSync(APP_JS_PATH, 'utf8');

function slice(startMarker, endMarker, label) {
  const s = SRC.indexOf(startMarker);
  if (s < 0) throw new Error(`未找到起始标记（${label}）：${startMarker}`);
  const e = SRC.indexOf(endMarker, s);
  if (e < 0) throw new Error(`未找到结束标记（${label}）：${endMarker}`);
  return SRC.slice(s, e);
}

const pieces = [
  slice('function esc(s) {', '\n}\n', 'esc') + '\n}\n',
  slice('function timeLong(sec) {', '\n}\n', 'timeLong') + '\n}\n',
  slice('function fmtSize(n) {', '\n}\n', 'fmtSize') + '\n}\n',
  // 写信相关全部真实实现（含 isRich / openComposer / openReplyComposer /
  // 守卫块 / insertQuote / toggleRich / sendCompose）
  slice(
    'function plainToHtmlText(text) {',
    '\n\n/* ---------------- 搜索 / 键盘 / 事件 / 同步 ---------------- */',
    'compose 主体'
  ),
  // setupEvents 中与写信弹窗相关的事件接线
  slice(
    "  $('#compose-btn').addEventListener('click', openComposer);",
    '\n\n  setupSearch();',
    '事件接线'
  ),
];

// 未被抽取、但会被引用到的符号
const stubs = `
const MAX_FILE_BYTES = 40 * 1024 * 1024;
let currentMessage = null;
function showToast(msg, isError) { globalThis.__toasts.push({ msg, isError: !!isError }); }
function api(...args) { return globalThis.__apiImpl(...args); }
function invalidateFolderCaches() {}
function refreshCounts() {}
function loadMailboxes() {}
function openFolder() {}
function loadFolder() {}
function isTypingTarget() { return false; }
function moveSelection() {}
`;

// 探针：把块级 let 绑定暴露出来，便于外部观测与复位（仅测试用）
const probe = `
globalThis.__t = {
  get pending() { return discardConfirmPending; },
  get lastFocus() { return composerLastFocus; },
  get baseline() { return composerBaseline; },
  get sendInFlight() { return sendInFlight; },
  resetGuard() { discardConfirmPending = false; composerLastFocus = null; },
  clearBaseline() { composerBaseline = null; },
  setCurrentMessage(m) { currentMessage = m; },
  // 把当前表单重新快照为基线（与 openComposer 内同一表达式）。
  // 用于隔离出「正文」单一变量：先填好收件人再重新基线，之后的差异只可能来自正文。
  rebaseline() {
    composerBaseline = {
      to: $('#f-to').value,
      subject: $('#f-subject').value,
      body: $('#f-body').value,
      richText: richPlainText($('#f-body-rich')),
      mailbox: $('#f-mailbox').value,
    };
  },
};
`;

/* ---------------- 极简 DOM 桩 ---------------- */

const els = {};
const listeners = {};

function on(sel, ev, fn) {
  (listeners[`${sel}:${ev}`] = listeners[`${sel}:${ev}`] || []).push(fn);
}
function fire(sel, ev, event = {}) {
  const fns = listeners[`${sel}:${ev}`] || [];
  if (!fns.length) throw new Error(`没有注册的监听器：${sel} / ${ev}`);
  for (const fn of fns) fn(event);
}

class El {
  constructor(id) {
    this.id = id;
    this.value = '';
    this._text = '';
    this._html = '';
    this.focused = 0;
    this.parent = null;
    this._classes = new Set();
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      contains: (c) => this._classes.has(c),
      toggle: (c, on2) => (on2 ? this._classes.add(c) : this._classes.delete(c)),
    };
  }
  // 模拟浏览器：块级标签 / <br> 产生换行，&nbsp; 读作 \u00a0
  get innerText() { return this._text; }
  set innerText(v) { this._text = v; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; }
  // 真实浏览器里 innerHTML 变化会同步影响 innerText，这里做等价换算
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this._text = this._html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;|&#xa0;/gi, '\u00a0') // 浏览器会把实体还原成真正的 U+00A0
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }
  focus() { this.focused++; }
  addEventListener(ev, fn) { on(this.id, ev, fn); }
  appendChild() {}
  contains(other) {
    let n = other;
    while (n) { if (n === this) return true; n = n.parent; }
    return false;
  }
}

function el(id) {
  if (!els[id]) els[id] = new El(id);
  return els[id];
}

const composer = el('#composer');
const modalMask = el('#modal-mask');
const confirmMask = el('#confirm-mask');
modalMask.classList.add('hidden');
confirmMask.classList.add('hidden');
composer.parent = modalMask;

const documentStub = {
  body: { contains: (n) => Object.values(els).includes(n) },
  querySelector: (s) => el(s),
  createElement: (tag) => new El(`<${tag}>`),
  addEventListener: (ev, fn) => on('#document', ev, fn),
};

const sandbox = {
  console,
  document: documentStub,
  state: {
    composing: null,
    canSend: true,
    fromName: '',
    fromAddress: 'me@example.com',
    fromEmail: 'me@example.com',
    mailbox: '',
    mailboxList: [],
    folder: 'inbox',
    cache: { countsAt: 0 },
  },
  $: (s) => el(s),
  __toasts: [],
  __apiImpl: () => Promise.reject(new Error('api 桩未被设置')),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`'use strict';\n${stubs}\n${pieces.join('\n')}\n${probe}\n`, sandbox);

const S = sandbox;
const T = S.__t;
const st = S.state;
const toasts = S.__toasts;

/* ---------------- 断言辅助 ---------------- */

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; failures.push(msg); console.log(`  FAIL  ${msg}`); }
}
const confirmShown = () => !confirmMask.classList.contains('hidden');
const composerOpen = () => !modalMask.classList.contains('hidden');
const pressEsc = () => fire('#document', 'keydown', { key: 'Escape', preventDefault() {} });
const clickMask = () => fire('#modal-mask', 'click', { target: modalMask, currentTarget: modalMask });
const lastToast = () => (toasts.length ? toasts[toasts.length - 1].msg : '');

const REPLY_MSG = {
  id: 'msg-1',
  direction: 'inbound',
  from_email: 'alice@example.com',
  from_name: 'Alice',
  subject: '会议纪要',
  mailbox: 'me@example.com',
  reply_to: [],
  received_at: 1700000000,
  body_text: '原文第一行\n原文第二行',
};

/** 走真实的 openComposer()，因此基线由生产代码记录 */
function reset() {
  for (const e of Object.values(els)) e.focused = 0;
  toasts.length = 0;
  T.resetGuard();
  S.openComposer();
  T.resetGuard(); // openComposer 内部也会清，这里再保证一次
}
/** 走真实的 openReplyComposer() */
function resetReply() {
  for (const e of Object.values(els)) e.focused = 0;
  toasts.length = 0;
  T.resetGuard();
  T.setCurrentMessage(REPLY_MSG);
  S.openReplyComposer();
  T.resetGuard();
}

/** 让 api 挂起，返回手动 resolve/reject 的控制器 */
function deferApi() {
  let resolveFn;
  let rejectFn;
  const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  S.__apiImpl = () => p;
  return { resolve: resolveFn, reject: rejectFn };
}

/* ---------------- 用例 ---------------- */

async function main() {
  console.log('\n[1] 空表单：不脏、不提示、直接关闭');
  reset();
  ok(S.isComposerDirty() === false, '全空 -> 不脏');
  ok(T.baseline !== null, 'openComposer 已记录基线');
  S.requestCloseComposer();
  ok(composerOpen() === false, '空表单请求关闭 -> 直接关闭');
  ok(confirmShown() === false, '空表单 -> 不弹确认');
  ok(st.composing === null, '状态已清理');
  ok(T.baseline === null, '基线已清理');

  console.log('\n[2] 脏检测：各字段单独触发');
  for (const [label, set] of [
    ['收件人', () => (el('#f-to').value = 'a@b.com')],
    ['主题', () => (el('#f-subject').value = 'hi')],
    ['正文(textarea)', () => (el('#f-body').value = 'hello')],
    ['附件', () => (st.composing.files = [{ name: 'a.txt' }])],
  ]) {
    reset();
    set();
    ok(S.isComposerDirty() === true, `${label} 非空 -> 脏`);
  }

  console.log('\n[2b] 输入后又改回原样 -> 不脏（无内容可丢）');
  reset();
  el('#f-subject').value = 'x';
  ok(S.isComposerDirty() === true, '输入 x -> 脏');
  el('#f-subject').value = '';
  ok(S.isComposerDirty() === false, '清空回到基线 -> 不脏');
  S.requestCloseComposer();
  ok(composerOpen() === false, '回到基线后请求关闭 -> 直接关闭，不弹确认');

  console.log('\n[3] 脏检测：富文本');
  reset();
  st.composing.rich = true;
  el('#f-body-rich').innerText = '\n';
  ok(S.isComposerDirty() === false, '富文本仅 <br> -> 不脏');
  el('#f-body-rich').innerText = '\u00a0';
  ok(S.isComposerDirty() === false, '富文本仅 &nbsp; -> 不脏');
  el('#f-body-rich').innerText = 'x';
  ok(S.isComposerDirty() === true, '富文本有文字 -> 脏');

  console.log('\n[4] 切换富文本本身不弄脏表单（走真实 toggleRich）');
  reset();
  S.toggleRich(); // 真实函数：空 textarea -> 富文本
  ok(st.composing.rich === true, '已切到富文本');
  ok(S.isComposerDirty() === false, '空表单切到富文本 -> 仍不脏');
  // 真实顺序：先切回纯文本输入，再切富文本，内容应被搬运且不丢
  S.toggleRich(); // 富文本 -> textarea
  ok(st.composing.rich === false, '已切回纯文本');
  el('#f-body').value = 'hello';
  S.toggleRich(); // textarea -> 富文本
  ok(st.composing.rich === true, '再次切到富文本');
  ok(el('#f-body-rich').innerHTML === 'hello', '内容已搬运到富文本');
  ok(S.isComposerDirty() === true, '有文字切到富文本 -> 脏');
  S.toggleRich(); // 富文本 -> textarea
  ok(st.composing.rich === false, '切回纯文本');
  ok(el('#f-body').value === 'hello', '来回切换未丢内容');
  ok(S.isComposerDirty() === true, '来回切换后仍脏');

  console.log('\n[5] 有内容时：遮罩/取消/Esc 三个入口都弹确认、且都不关闭');
  for (const [label, act] of [
    ['遮罩空白区', clickMask],
    ['取消按钮', () => fire('#composer-cancel', 'click', {})],
    ['Esc', pressEsc],
  ]) {
    reset();
    el('#f-subject').value = '草稿';
    act();
    ok(confirmShown() === true, `${label} -> 弹出确认框`);
    ok(composerOpen() === true, `${label} -> 写信弹窗仍打开`);
    ok(st.composing !== null && el('#f-subject').value === '草稿', `${label} -> 内容保留`);
    ok(T.pending === true, `${label} -> pending=true`);
  }

  console.log('\n[6] 防重入：确认框已弹出时重复触发');
  reset();
  el('#f-subject').value = '草稿';
  clickMask();
  ok(T.pending === true, '首次触发后 pending=true');
  clickMask();
  pressEsc();
  pressEsc();
  ok(confirmShown() === true, '重复触发后确认框仍显示');
  ok(composerOpen() === true, '重复触发后写信弹窗未被关闭');
  ok(st.composing !== null, '重复触发后内容未丢失');

  console.log('\n[7] 点确认框自身不算「点击外部」');
  reset();
  el('#f-subject').value = '草稿';
  S.requestCloseComposer();
  const box = new El('#confirm-box');
  fire('#confirm-mask', 'click', { target: box, currentTarget: confirmMask });
  ok(confirmShown() === true, '点确认框内部 -> 确认框不关闭');
  ok(st.composing !== null, '内容未丢失');
  fire('#confirm-mask', 'click', { target: confirmMask, currentTarget: confirmMask });
  ok(confirmShown() === false, '点确认框外空白 -> 收起确认框');
  ok(composerOpen() === true, '写信弹窗仍打开');

  console.log('\n[8] 「继续编辑」-> 保留内容 + 焦点归还');
  reset();
  el('#f-to').value = 'a@b.com';
  el('#f-body').value = 'draft body';
  const toEl = el('#f-to');
  fire('#composer', 'focusin', { target: toEl });
  const focusBefore = toEl.focused; // openComposer 已聚焦过一次
  S.requestCloseComposer();
  ok(confirmShown() === true, '弹出确认框');
  fire('#confirm-cancel', 'click', {});
  ok(confirmShown() === false, '确认框收起');
  ok(composerOpen() === true, '写信弹窗保留');
  ok(st.composing !== null && el('#f-body').value === 'draft body', '内容完整保留');
  ok(T.pending === false, 'pending 已复位');
  ok(toEl.focused === focusBefore + 1, '焦点回到原编辑元素');
  S.requestCloseComposer();
  ok(confirmShown() === true, '再次请求关闭 -> 重新弹出确认框（防重入未卡死）');

  console.log('\n[9] 「放弃」-> 真正关闭并丢弃');
  reset();
  el('#f-to').value = 'a@b.com';
  S.requestCloseComposer();
  fire('#confirm-ok', 'click', {});
  ok(confirmShown() === false, '确认框收起');
  ok(composerOpen() === false, '写信弹窗关闭');
  ok(st.composing === null, '内容已丢弃');
  ok(T.pending === false, 'pending 已复位（无残留状态）');

  console.log('\n[10] 发送成功路径：直接关闭、不弹确认');
  reset();
  el('#f-to').value = 'a@b.com';
  el('#f-subject').value = 's';
  el('#f-body').value = 'body';
  const okApi = deferApi();
  const okSend = S.sendCompose();
  ok(T.sendInFlight === true, '发送中 sendInFlight=true');
  okApi.resolve({ id: 'sent-1' });
  await okSend;
  ok(T.sendInFlight === false, '发送完成后 sendInFlight=false');
  ok(confirmShown() === false, '不弹放弃确认');
  ok(composerOpen() === false, '弹窗已关闭');
  ok(st.composing === null, '状态已清理');
  ok(lastToast() === '邮件已发送', '提示发送成功');

  console.log('\n[11] 发送失败路径：内容保留、弹窗不关');
  reset();
  el('#f-to').value = 'a@b.com';
  el('#f-body').value = 'body';
  const badApi = deferApi();
  const badSend = S.sendCompose();
  badApi.reject(new Error('网络错误'));
  await badSend;
  ok(T.sendInFlight === false, '失败后 sendInFlight=false');
  ok(composerOpen() === true, '弹窗仍打开');
  ok(confirmShown() === false, '不弹确认框');
  ok(st.composing !== null && el('#f-body').value === 'body', '内容保留');
  ok(lastToast().includes('发送失败'), '提示发送失败');

  console.log('\n[12] Esc：确认框打开时优先收起确认框');
  reset();
  el('#f-subject').value = '草稿';
  S.requestCloseComposer();
  ok(confirmShown() === true, '先弹出确认框');
  pressEsc();
  ok(confirmShown() === false, 'Esc 收起确认框');
  ok(composerOpen() === true, '写信弹窗未关闭');
  ok(st.composing !== null, '内容保留');

  console.log('\n[13] Esc：输入框内按 Esc 同样生效（不被 isTypingTarget 吞掉）');
  reset();
  el('#f-subject').value = '草稿';
  let prevented = false;
  fire('#document', 'keydown', {
    key: 'Escape',
    target: el('#f-subject'),
    preventDefault: () => (prevented = true),
  });
  ok(confirmShown() === true, '在输入框内按 Esc -> 弹确认框');
  ok(prevented === true, '已 preventDefault');

  console.log('\n[14] 遮罩 handler 只在 target===currentTarget 时触发');
  reset();
  el('#f-subject').value = 'x';
  const inner = new El('#composer-inner');
  fire('#modal-mask', 'click', { target: inner, currentTarget: modalMask });
  ok(confirmShown() === false, '点弹窗内部 -> 不弹确认框');
  ok(composerOpen() === true, '点弹窗内部 -> 不关闭');

  console.log('\n[15] 打开写信/回复时重置确认状态');
  reset();
  el('#f-subject').value = 'x';
  S.requestCloseComposer();
  ok(confirmShown() === true, '先制造残留确认框');
  reset();
  ok(confirmShown() === false, '重新 openComposer 后确认框隐藏');
  ok(T.pending === false, '重新 openComposer 后 pending=false');

  console.log('\n[16] 回复模式：预填的收件人/主题不算用户输入');
  resetReply();
  ok(composerOpen() === true, '回复弹窗打开');
  ok(el('#f-to').value === 'alice@example.com', '收件人已预填');
  ok(el('#f-subject').value === 'Re: 会议纪要', '主题已预填');
  ok(S.isComposerDirty() === false, '刚打开回复弹窗 -> 不脏');
  S.requestCloseComposer();
  ok(composerOpen() === false, '刚打开就点外部 -> 直接关闭，不弹确认');
  ok(confirmShown() === false, '未弹确认框');

  console.log('\n[17] 回复模式：点「引用原文」后算脏');
  resetReply();
  S.insertQuote(); // 真实函数，改写 #f-body.value
  ok(el('#f-body').value.length > 0, '引用原文已写入正文');
  ok(S.isComposerDirty() === true, '点引用原文 -> 脏');
  S.requestCloseComposer();
  ok(confirmShown() === true, '点引用原文后点外部 -> 弹确认');
  ok(composerOpen() === true, '弹窗未关闭');
  ok(st.composing !== null && el('#f-body').value.includes('原文第一行'), '引用内容保留');

  console.log('\n[18] 回复模式：手动删掉预填收件人也算脏');
  resetReply();
  el('#f-to').value = '';
  ok(S.isComposerDirty() === true, '清空预填收件人 -> 脏（与基线不同即脏）');

  console.log('\n[19] 基线为 null 的兜底：不抛错，退回「任一非空即脏」');
  reset();
  T.clearBaseline();
  ok(S.isComposerDirty() === false, '基线 null + 空表单 -> 不脏');
  el('#f-subject').value = '   ';
  ok(S.isComposerDirty() === false, '基线 null + 主题仅空格 -> 不脏');
  el('#f-subject').value = 'x';
  ok(S.isComposerDirty() === true, '基线 null + 主题非空 -> 脏');
  el('#f-subject').value = '';
  st.composing.rich = true;
  el('#f-body-rich').innerText = 'rich';
  ok(S.isComposerDirty() === true, '基线 null + 富文本非空 -> 脏');
  el('#f-body-rich').innerText = '';
  st.composing.rich = false;
  el('#f-body').value = 'plain';
  ok(S.isComposerDirty() === true, '基线 null + 纯文本非空 -> 脏');
  ok(S.norm(null) === '' && S.norm(undefined) === '' && S.norm('  x  ') === 'x', 'norm 归一化正确');

  console.log('\n[20] 发送中禁止放弃（成功路径）');
  reset();
  el('#f-to').value = 'a@b.com';
  el('#f-body').value = 'body';
  const d1 = deferApi();
  const s1 = S.sendCompose();
  ok(T.sendInFlight === true, '发送中 sendInFlight=true');
  toasts.length = 0;
  S.requestCloseComposer();
  ok(composerOpen() === true, '发送中请求关闭 -> 弹窗不关');
  ok(confirmShown() === false, '发送中 -> 不弹放弃确认');
  ok(st.composing !== null, '发送中 -> 内容保留');
  ok(lastToast().includes('正在发送中'), '提示「邮件正在发送中」');
  clickMask();
  ok(composerOpen() === true, '发送中点遮罩 -> 同样被挡住');
  pressEsc();
  ok(composerOpen() === true, '发送中按 Esc -> 同样被挡住');
  d1.resolve({});
  await s1;
  ok(composerOpen() === false, '发送成功后正常关闭');
  ok(T.sendInFlight === false, 'sendInFlight 已复位');

  console.log('\n[21] 发送中禁止放弃（失败路径 —— 修复前的数据丢失场景）');
  reset();
  el('#f-to').value = 'a@b.com';
  el('#f-body').value = 'body';
  const d2 = deferApi();
  const s2 = S.sendCompose();
  S.requestCloseComposer(); // 修复前这里会关掉弹窗
  ok(composerOpen() === true, '发送中无法放弃');
  d2.reject(new Error('boom'));
  await s2;
  ok(composerOpen() === true, '发送失败后弹窗仍在（内容未丢失）');
  ok(st.composing !== null && el('#f-body').value === 'body', '发送失败后内容完整保留');
  ok(T.sendInFlight === false, 'sendInFlight 已复位');
  // 失败后应恢复正常的放弃确认流程
  S.requestCloseComposer();
  ok(confirmShown() === true, '失败后再次请求关闭 -> 正常弹出放弃确认');

  console.log('\n[22] Fix1：正文只认当前可见的编辑器（消除「假提示」）');
  reset();
  el('#f-body').value = 'hi'; // 纯文本输入
  ok(S.isComposerDirty() === true, '纯文本输入 hi -> 脏');
  S.toggleRich(); // 切到富文本，内容被搬运
  ok(el('#f-body-rich').innerText === 'hi', '内容已搬到富文本');
  ok(S.isComposerDirty() === true, '富文本里仍可见 hi -> 脏');
  el('#f-body-rich').innerHTML = ''; // 在富文本里把可见内容删光
  ok(el('#f-body').value === 'hi', '隐藏的 #f-body 仍残留 hi');
  ok(S.isComposerDirty() === false, '富文本已删光 -> 不脏（不被隐藏残留误导）');
  S.requestCloseComposer();
  ok(composerOpen() === false, '点外部 -> 直接关闭，不弹确认');
  ok(confirmShown() === false, '未弹确认框');

  console.log('\n[23] Fix2：只敲空格不算输入（两种模式一致）');
  for (const [label, set] of [
    ['收件人', () => (el('#f-to').value = '   ')],
    ['主题', () => (el('#f-subject').value = '   ')],
    ['正文(textarea)', () => (el('#f-body').value = '   ')],
  ]) {
    reset();
    set();
    ok(S.isComposerDirty() === false, `${label} 仅空格 -> 不脏`);
  }
  reset();
  st.composing.rich = true;
  el('#f-body-rich').innerText = '\u00a0\u00a0';
  ok(S.isComposerDirty() === false, '富文本仅 &nbsp; -> 不脏');
  reset();
  el('#f-body').value = '  hi  ';
  ok(S.isComposerDirty() === true, '前后有空格但含文字 -> 仍脏');
  reset();
  el('#f-to').value = '   ';
  S.requestCloseComposer();
  ok(composerOpen() === false, '只敲空格后点外部 -> 直接关闭，不弹确认');

  console.log('\n[24] Fix3：改「发件人」下拉 -> 脏（不再静默丢失）');
  reset();
  const mbEl = el('#f-mailbox');
  ok(mbEl.value === 'me@example.com', '发件人已预选');
  ok(S.isComposerDirty() === false, '未改动 -> 不脏');
  mbEl.value = 'other@example.com';
  ok(S.isComposerDirty() === true, '改了发件人 -> 脏');
  S.requestCloseComposer();
  ok(confirmShown() === true, '改发件人后点外部 -> 弹确认');
  ok(composerOpen() === true, '弹窗未关闭');
  mbEl.value = 'me@example.com';
  ok(S.isComposerDirty() === false, '改回原值 -> 不脏');

  console.log('\n[25] N1：富文本仅 &nbsp; -> 点发送应被拦下（修复前会发出空白邮件）');
  reset();
  el('#f-to').value = 'a@b.com';
  st.composing.rich = true;
  T.rebaseline(); // 收件人纳入基线，隔离出正文这一个变量
  el('#f-body-rich').innerHTML = '<div>&nbsp;</div>';
  ok(S.isComposerDirty() === false, '守卫判「无内容」');
  let calls25 = 0;
  S.__apiImpl = () => { calls25++; return Promise.resolve({}); };
  toasts.length = 0;
  await S.sendCompose();
  ok(calls25 === 0, '未发出任何请求');
  ok(lastToast() === '请填写邮件内容', '提示「请填写邮件内容」');
  ok(composerOpen() === true, '弹窗未关闭，内容保留');

  console.log('\n[25b] 对照：富文本有真实文字 -> 正常发送（未改坏正常路径）');
  reset();
  el('#f-to').value = 'a@b.com';
  st.composing.rich = true;
  T.rebaseline();
  el('#f-body-rich').innerHTML = '<div>hi</div>';
  ok(S.isComposerDirty() === true, '守卫判「有内容」');
  let calls25b = 0;
  S.__apiImpl = () => { calls25b++; return Promise.resolve({}); };
  toasts.length = 0;
  await S.sendCompose();
  ok(calls25b === 1, '请求已发出');
  ok(lastToast() === '邮件已发送', '提示发送成功');
  ok(composerOpen() === false, '发送成功后关闭');

  console.log('\n[26] 守卫与发送校验对同一份富文本内容必须同判（方案 B 的目的）');
  for (const [label, richHtml, expect] of [
    ['仅 &nbsp;', '<div>&nbsp;</div>', false],
    ['仅 &#160;', '<div>&#160;</div>', false],
    ['仅 <br>', '<div><br></div>', false],
    ['仅空格', '<div> </div>', false],
    ['真实文字', '<div>hi</div>', true],
    ['文字夹 &nbsp;', '<div>&nbsp;hi&nbsp;</div>', true],
  ]) {
    reset();
    el('#f-to').value = 'a@b.com';
    st.composing.rich = true;
    T.rebaseline(); // 先固定除正文外的一切，再只改正文
    el('#f-body-rich').innerHTML = richHtml;
    const guardSaysContent = S.isComposerDirty();
    let called = 0;
    S.__apiImpl = () => { called++; return Promise.resolve({}); };
    toasts.length = 0;
    await S.sendCompose();
    const sendProceeded = called > 0;
    ok(sendProceeded === guardSaysContent, `[${label}] 守卫=${guardSaysContent} 与发送侧=${sendProceeded} 一致`);
    ok(guardSaysContent === expect, `[${label}] 判定符合预期（期望 ${expect}）`);
  }

  console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
  if (fail) console.log('失败用例：\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
