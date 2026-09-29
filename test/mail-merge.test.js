'use strict';

/* =========================================================
 * 「合并发送」回归测试（零依赖，node test/mail-merge.test.js）
 *
 * 项目前端是无构建的原生 SPA，没有 npm 测试框架。这里沿用
 * test/compose-guard.test.js 的做法：用 Node 内置 vm 把 public/app.js
 * 中写信相关的**真实函数**原样抽出来执行，配一个极简 DOM 桩，
 * 从而在不引入任何依赖的前提下验证真实源码的行为。
 *
 * 覆盖：
 *   1. parseRecipients 纯函数（分隔符 / trim / 去空 / 大小写去重 / 边界）
 *   2. 前端 merge 分支：全部成功 -> 关窗 + toast
 *                      部分失败 -> 弹窗不关、#f-to 只剩失败者、toast 含地址与原因
 *                      全部失败 -> 同样不关窗、#f-to 等价于原输入
 *   3. 非 merge 分支：行为与改造前一致（一次请求、to 为数组）
 *   4. checkbox 重置：每次打开弹窗都是未勾选
 *   5. 脏检测：仅勾选 / 取消 checkbox 不产生脏状态
 *   6. hint 文案：勾选且 >1 收件人时显示人数，0/1 个收件人时不显示
 *   7. 模式隔离：.merge-row 只在写信模式显示；回复模式隐藏且 payload 绝不含 merge（硬防御）
 *   8. 去重：同一地址重复 100 次仍只算 1 人，不会触发后端动态上限
 *
 * 注意：后端 merge 循环（src/index.ts）是 TS 且项目无构建步骤，
 * 零依赖脚本无法 require，故不在此覆盖，由 QA 用真实 wrangler dev 做集成验证。
 * ========================================================= */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

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
  // 写信相关全部真实实现（含 parseRecipients / updateMergeHint / resetMergePick /
  // openComposer / openReplyComposer / 守卫块 / sendCompose）
  slice(
    'function plainToHtmlText(text) {',
    '\n\n/* ---------------- 搜索 / 键盘 / 事件 / 同步 ---------------- */',
    'compose 主体'
  ),
  // setupEvents 中与写信弹窗相关的事件接线（含 #f-merge / #f-to 的监听）
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
  get sendInFlight() { return sendInFlight; },
  get baseline() { return composerBaseline; },
  resetGuard() { discardConfirmPending = false; composerLastFocus = null; },
  clearBaseline() { composerBaseline = null; },
  setCurrentMessage(m) { currentMessage = m; },
  // 把当前表单重新快照为基线（与 openComposer 内同一表达式），
  // 用于隔离出「勾选 checkbox」这一个变量。
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
    this.checked = false; // checkbox 支持
    this.disabled = false;
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
  get innerText() { return this._text; }
  set innerText(v) { this._text = v; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = v; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this._text = this._html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;|&#xa0;/gi, '\u00a0')
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
const composerOpen = () => !modalMask.classList.contains('hidden');
const confirmShown = () => !confirmMask.classList.contains('hidden');
const lastToast = () => (toasts.length ? toasts[toasts.length - 1].msg : '');
const hint = () => el('#merge-hint').textContent;
const mergeRowHidden = () => el('.merge-row').classList.contains('hidden');
const MERGE_HINT = (n) => `将分别单独发送给 ${n} 位收件人`;

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

/** 走真实的 openComposer()，因此基线/勾选重置都由生产代码执行 */
function reset() {
  for (const e of Object.values(els)) e.focused = 0;
  toasts.length = 0;
  T.resetGuard();
  S.openComposer();
  T.resetGuard();
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

/** 记录每次 api 调用的 url/opts，并返回可手动兑现的控制器 */
function captureApi() {
  const calls = [];
  let resolveFn;
  let rejectFn;
  const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  S.__apiImpl = (url, opts) => { calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null }); return p; };
  return { calls, resolve: resolveFn, reject: rejectFn };
}

/* ---------------- 用例 ---------------- */

async function main() {
  console.log('\n[1] parseRecipients：分隔符 / trim / 去空 / 大小写去重 / 边界');
  const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), `${msg} -> ${JSON.stringify(got)}`);
  eq(S.parseRecipients('a@x.com, b@y.com'), ['a@x.com', 'b@y.com'], '英文逗号分隔');
  eq(S.parseRecipients('a@x.com;b@y.com'), ['a@x.com', 'b@y.com'], '英文分号分隔');
  eq(S.parseRecipients('a@x.com，b@y.com；c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com'], '中文逗号 + 中文分号');
  eq(S.parseRecipients('a@x.com, b@y.com;c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com'], '混合分隔符');
  eq(S.parseRecipients('  a@x.com  \n\t b@y.com  '), ['a@x.com', 'b@y.com'], '空白分隔 + 两端 trim');
  eq(S.parseRecipients('a@x.com,,;;  ,,b@y.com'), ['a@x.com', 'b@y.com'], '连续/空段被丢弃');
  eq(S.parseRecipients('  ,  ;  '), [], '只有分隔符 -> 空数组');
  eq(S.parseRecipients('A@X.com, a@x.com, A@x.COM'), ['A@X.com'], '大小写去重且保留首次写法');
  eq(S.parseRecipients('a@x.com,a@x.com,a@x.com'), ['a@x.com'], '重复同一地址 -> 1 个');
  eq(S.parseRecipients('a@x.com'), ['a@x.com'], '单个地址');
  eq(S.parseRecipients(''), [], '空串 -> 空数组');
  eq(S.parseRecipients('   '), [], '仅空白 -> 空数组');
  eq(S.parseRecipients(null), [], 'null -> 空数组');
  eq(S.parseRecipients(undefined), [], 'undefined -> 空数组');
  // 唯一调用点是 input.value（永远是字符串）；此处只确认非字符串入参不抛错
  eq(S.parseRecipients(0), ['0'], '非字符串入参经 String() 归一化，不抛错');

  console.log('\n[2] hint 文案：勾选且 >1 收件人才显示人数');
  reset();
  ok(hint() === '', '刚打开 -> 无提示');
  el('#f-to').value = 'a@x.com';
  fire('#f-to', 'input', {});
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  ok(hint() === '', '1 位收件人 -> 不显示');
  el('#f-to').value = 'a@x.com, b@y.com';
  fire('#f-to', 'input', {});
  ok(hint() === MERGE_HINT(2), `改成 2 位 -> 显示「${MERGE_HINT(2)}」`);
  el('#f-to').value = 'a@x.com, b@y.com, c@z.com;d@w.com';
  fire('#f-to', 'input', {});
  ok(hint() === MERGE_HINT(4), '改成 4 位 -> 人数跟着变');
  el('#f-to').value = 'a@x.com, A@X.COM';
  fire('#f-to', 'input', {});
  ok(hint() === '', '去重后只剩 1 位 -> 不显示');
  el('#f-to').value = '';
  fire('#f-to', 'input', {});
  ok(hint() === '', '清空收件人 -> 不显示');
  el('#f-to').value = 'a@x.com, b@y.com';
  fire('#f-to', 'input', {});
  el('#f-merge').checked = false;
  fire('#f-merge', 'change', {});
  ok(hint() === '', '取消勾选 -> 清空提示');

  console.log('\n[3] checkbox 重置：每次打开弹窗都是未勾选');
  reset();
  el('#f-merge').checked = true;
  el('#f-to').value = 'a@x.com, b@y.com';
  fire('#f-merge', 'change', {});
  ok(hint() !== '', '先制造「已勾选 + 有提示」的残留状态');
  S.requestCloseComposer();
  reset();
  ok(el('#f-merge').checked === false, '重开写信弹窗 -> 未勾选');
  ok(hint() === '', '重开写信弹窗 -> 提示已清空');
  resetReply();
  ok(el('#f-merge').checked === false, '打开回复弹窗 -> 未勾选');
  ok(hint() === '', '打开回复弹窗 -> 提示已清空');
  el('#f-merge').checked = true;
  resetReply();
  ok(el('#f-merge').checked === false, '回复弹窗重开 -> 未勾选');

  console.log('\n[4] 脏检测：仅勾选 / 取消 checkbox 不产生脏状态');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-body').value = 'body';
  T.rebaseline(); // 把收件人/正文纳入基线，隔离出 checkbox 这一个变量
  ok(S.isComposerDirty() === false, '基线状态下 -> 不脏');
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  ok(S.isComposerDirty() === false, '勾选 checkbox -> 仍不脏');
  el('#f-merge').checked = false;
  fire('#f-merge', 'change', {});
  ok(S.isComposerDirty() === false, '取消勾选 -> 仍不脏');
  // 空表单上勾选后点外部：没有内容可丢，应直接关闭而不是弹「放弃确认」
  reset();
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  S.requestCloseComposer();
  ok(composerOpen() === false, '空表单勾选后点外部 -> 直接关闭');
  ok(confirmShown() === false, '空表单勾选后点外部 -> 不弹放弃确认');

  console.log('\n[5] 非 merge 分支：一次请求、to 为数组（其余行为不变）');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-subject').value = 's';
  el('#f-body').value = 'body';
  const c5 = captureApi();
  const s5 = S.sendCompose();
  ok(T.sendInFlight === true, '发送中 sendInFlight=true');
  c5.resolve({ ok: true, id: 'row-1', resend_id: 'rs-1' });
  await s5;
  ok(c5.calls.length === 1, '只发出 1 次请求');
  ok(c5.calls[0].url === '/api/messages', '打到 /api/messages');
  ok(Array.isArray(c5.calls[0].body.to), 'payload.to 是数组');
  ok(JSON.stringify(c5.calls[0].body.to) === JSON.stringify(['a@x.com', 'b@y.com']), 'payload.to 已切分为 2 个地址');
  ok(c5.calls[0].body.merge === undefined, '未勾选 -> payload 不含 merge');
  ok(lastToast() === '邮件已发送', 'toast 与改造前一致');
  ok(composerOpen() === false, '发送成功后关闭弹窗');
  ok(T.sendInFlight === false, 'sendInFlight 已复位');

  console.log('\n[5b] 非 merge 分支：单收件人也是数组；空收件人被拦下');
  reset();
  el('#f-to').value = 'a@x.com';
  el('#f-body').value = 'body';
  const c5b = captureApi();
  c5b.resolve({ ok: true, id: 'row-2' });
  await S.sendCompose();
  ok(JSON.stringify(c5b.calls[0].body.to) === JSON.stringify(['a@x.com']), '单收件人 -> ["a@x.com"]');
  reset();
  el('#f-to').value = '  , ;  ';
  el('#f-body').value = 'body';
  let calls5c = 0;
  S.__apiImpl = () => { calls5c++; return Promise.resolve({}); };
  toasts.length = 0;
  await S.sendCompose();
  ok(calls5c === 0, '仅分隔符 -> 不发请求');
  ok(lastToast() === '请填写收件人', '仅分隔符 -> 提示「请填写收件人」');
  ok(composerOpen() === true, '弹窗保持打开');

  console.log('\n[5c] 非 merge 分支：失败路径与改造前一致');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-body').value = 'body';
  const c5d = captureApi();
  const s5d = S.sendCompose();
  c5d.reject(new Error('网络错误'));
  await s5d;
  ok(composerOpen() === true, '失败 -> 弹窗不关');
  ok(st.composing !== null && el('#f-body').value === 'body', '失败 -> 内容保留');
  ok(lastToast().includes('发送失败'), '失败 -> 提示发送失败');
  ok(T.sendInFlight === false, '失败 -> sendInFlight 已复位');

  console.log('\n[6] merge 分支：全部成功 -> 关窗 + 正确 toast');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-subject').value = '通知';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c6 = captureApi();
  const s6 = S.sendCompose();
  c6.resolve({
    ok: true, merge: true, total: 2, sent_count: 2, failed_count: 0,
    sent: [{ to: 'a@x.com', id: 'r1', resend_id: 'x1' }, { to: 'b@y.com', id: 'r2', resend_id: 'x2' }],
    failed: [],
  });
  await s6;
  ok(c6.calls.length === 1, '只发出 1 次请求（由后端循环，附件只上传一次）');
  ok(c6.calls[0].body.merge === true, 'payload.merge=true');
  ok(JSON.stringify(c6.calls[0].body.to) === JSON.stringify(['a@x.com', 'b@y.com']), 'payload.to 为 2 个地址的数组');
  ok(lastToast() === '已分别发送给 2 位收件人', `toast = 「已分别发送给 2 位收件人」（实际：${lastToast()}）`);
  ok(composerOpen() === false, '全部成功 -> 关闭弹窗');
  ok(st.composing === null, '全部成功 -> 状态已清理');
  ok(T.sendInFlight === false, '全部成功 -> sendInFlight 已复位');

  console.log('\n[7] merge 分支：部分失败 -> 弹窗不关、#f-to 只剩失败者、toast 含地址与原因');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com, c@z.com';
  el('#f-subject').value = '通知';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c7 = captureApi();
  const s7 = S.sendCompose();
  c7.resolve({
    ok: true, merge: true, total: 3, sent_count: 2, failed_count: 1,
    sent: [{ to: 'a@x.com', id: 'r1', resend_id: 'x1' }, { to: 'b@y.com', id: 'r2', resend_id: 'x2' }],
    failed: [{ to: 'c@z.com', error: 'Resend 返回错误: invalid to' }],
  });
  await s7;
  ok(composerOpen() === true, '部分失败 -> 弹窗不关');
  ok(st.composing !== null, '部分失败 -> composing 状态保留');
  ok(el('#f-to').value === 'c@z.com', `#f-to 只剩失败者（实际：${el('#f-to').value}）`);
  ok(el('#f-subject').value === '通知', '主题保留');
  ok(el('#f-body').value === '正文', '正文保留');
  ok(el('#f-merge').checked === true, 'checkbox 保持勾选（重试仍是合并发送）');
  ok(lastToast().includes('已发送 2 封'), `toast 含已发送封数（实际：${lastToast()}）`);
  ok(lastToast().includes('1 封失败'), 'toast 含失败封数');
  ok(lastToast().includes('c@z.com'), 'toast 含失败地址');
  ok(lastToast().includes('Resend 返回错误: invalid to'), 'toast 含失败原因');
  ok(toasts[toasts.length - 1].isError === true, 'toast 以错误样式展示');
  ok(el('#composer-send').disabled === false, '部分失败后发送按钮已恢复可点');
  ok(T.sendInFlight === false, '部分失败 -> sendInFlight 已复位');
  ok(hint() === '', '只剩 1 位失败者 -> hint 清空');

  console.log('\n[7b] merge 分支：多失败者全部写回 #f-to，可再次重试');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com, c@z.com, d@w.com';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c7b = captureApi();
  const s7b = S.sendCompose();
  c7b.resolve({
    ok: true, merge: true, total: 4, sent_count: 2, failed_count: 2,
    sent: [{ to: 'a@x.com', id: 'r1' }, { to: 'b@y.com', id: 'r2' }],
    failed: [{ to: 'c@z.com', error: 'boom-c' }, { to: 'd@w.com', error: 'boom-d' }],
  });
  await s7b;
  ok(el('#f-to').value === 'c@z.com, d@w.com', `两个失败者都写回（实际：${el('#f-to').value}）`);
  ok(S.parseRecipients(el('#f-to').value).length === 2, '写回内容可被再次解析为 2 个地址');
  ok(hint() === MERGE_HINT(2), '写回后 hint 同步为 2 位');
  ok(lastToast().includes('c@z.com'), 'toast 展示第一个失败者');

  console.log('\n[8] merge 分支：全部失败 -> 仍 HTTP 200，前端不抛错、不关窗、不丢内容');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-subject').value = '通知';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c8 = captureApi();
  const s8 = S.sendCompose();
  // 关键契约：HTTP 200 + ok:false + failed 明细（api() 因此不会 throw，前端拿得到 failed）
  c8.resolve({
    ok: false, merge: true, total: 2, sent_count: 0, failed_count: 2,
    sent: [],
    failed: [{ to: 'a@x.com', error: 'boom-a' }, { to: 'b@y.com', error: 'boom-b' }],
  });
  await s8;
  ok(composerOpen() === true, '全失败 -> 弹窗不关');
  ok(confirmShown() === false, '全失败 -> 不弹放弃确认框');
  ok(st.composing !== null && el('#f-body').value === '正文', '全失败 -> 内容完整保留');
  ok(el('#f-to').value === 'a@x.com, b@y.com', `全失败 -> #f-to 等价于原输入（实际：${el('#f-to').value}）`);
  ok(el('#f-merge').checked === true, '全失败 -> checkbox 仍勾选');
  ok(lastToast().includes('已发送 0 封') && lastToast().includes('2 封失败'), `toast 反映全失败（实际：${lastToast()}）`);
  ok(!lastToast().includes('发送失败：'), '全失败不走「发送失败」异常分支（说明响应为 200）');
  ok(T.sendInFlight === false, '全失败 -> sendInFlight 已复位');
  // 全失败后仍可正常走放弃确认流程（内容确实没发出去）
  S.requestCloseComposer();
  ok(confirmShown() === true, '全失败后点外部 -> 正常弹出放弃确认');

  console.log('\n[9] merge 分支：后端 400（超上限）走异常分支，内容保留');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c9 = captureApi();
  const s9 = S.sendCompose();
  c9.reject(new Error('单次合并发送最多 22 位收件人'));
  await s9;
  ok(composerOpen() === true, '400 -> 弹窗不关');
  ok(lastToast().includes('发送失败') && lastToast().includes('最多 22 位'), `toast 透出后端错误（实际：${lastToast()}）`);
  ok(el('#f-to').value === 'a@x.com, b@y.com', '400 -> 收件人未被改写');
  ok(T.sendInFlight === false, '400 -> sendInFlight 已复位');

  console.log('\n[10] 发送中守卫不被破坏（merge 路径）');
  reset();
  el('#f-to').value = 'a@x.com, b@y.com';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c10 = captureApi();
  const s10 = S.sendCompose();
  ok(T.sendInFlight === true, 'merge 发送中 sendInFlight=true');
  toasts.length = 0;
  S.requestCloseComposer();
  ok(composerOpen() === true, 'merge 发送中请求关闭 -> 弹窗不关');
  ok(confirmShown() === false, 'merge 发送中 -> 不弹放弃确认');
  ok(lastToast().includes('正在发送中'), 'merge 发送中 -> 提示「邮件正在发送中」');
  c10.resolve({ ok: true, merge: true, total: 2, sent_count: 2, failed_count: 0, sent: [], failed: [] });
  await s10;
  ok(composerOpen() === false, 'merge 发送完成后正常关闭');
  ok(T.sendInFlight === false, 'merge 发送完成后 sendInFlight 已复位');

  console.log('\n[11] 回复模式：.merge-row 隐藏，且硬防御保证 payload 绝不含 merge');
  resetReply();
  ok(el('#f-to').value === 'alice@example.com', '收件人已预填');
  ok(mergeRowHidden() === true, '回复模式 -> .merge-row 带 hidden');
  ok(el('#f-merge').checked === false, '回复模式 -> checkbox 未勾选');
  el('#f-body').value = '收到';
  const c11 = captureApi();
  const s11 = S.sendCompose();
  c11.resolve({ ok: true, id: 'r-reply' });
  await s11;
  ok(c11.calls[0].url === '/api/messages/msg-1/reply', '打到回复接口');
  ok(Array.isArray(c11.calls[0].body.to) && c11.calls[0].body.to[0] === 'alice@example.com', '回复 payload.to 也是数组');
  ok(c11.calls[0].body.merge === undefined, '回复 payload 不含 merge');
  ok(lastToast() === '回复已发送', 'toast 与改造前一致');
  // 硬防御：即使 checkbox 被强行勾上（DOM 被改 / 残留状态），也绝不向 reply 接口发 merge
  resetReply();
  el('#f-to').value = 'alice@example.com, bob@example.com';
  el('#f-body').value = '收到';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c11b = captureApi();
  const s11b = S.sendCompose();
  c11b.resolve({ ok: true, id: 'r-reply' });
  await s11b;
  ok(c11b.calls[0].body.merge === undefined, '回复模式强行勾选 -> payload 仍不含 merge（硬防御生效）');
  ok(c11b.calls[0].body.to.length === 2, '回复模式 -> payload.to 仍按输入切分为 2 个地址');
  // 对照：写信模式同一份 DOM 状态下 merge 必须照常发出
  reset();
  ok(mergeRowHidden() === false, '写信模式 -> .merge-row 不带 hidden');
  el('#f-to').value = 'alice@example.com, bob@example.com';
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  const c11c = captureApi();
  const s11c = S.sendCompose();
  c11c.resolve({ ok: true, merge: true, total: 2, sent_count: 2, failed_count: 0, sent: [], failed: [] });
  await s11c;
  ok(c11c.calls[0].body.merge === true, '对照：写信模式勾选 -> payload.merge=true');

  console.log('\n[12] 去重：同一地址重复 100 次 -> 只算 1 人，不可能触发后端动态上限');
  const hundred = Array.from({ length: 100 }, () => 'a@x.com').join(', ');
  const deduped = S.parseRecipients(hundred);
  ok(deduped.length === 1, `100 次重复 -> 去重后 1 人（实际 ${deduped.length}）`);
  ok(deduped[0] === 'a@x.com', '保留原地址');
  ok(S.parseRecipients(hundred).length <= 22, '去重后远低于动态上限 -> 后端 mergeRecipientCap 不会触发');
  reset();
  el('#f-to').value = hundred;
  el('#f-body').value = '正文';
  el('#f-merge').checked = true;
  fire('#f-merge', 'change', {});
  ok(hint() === '', '100 次重复去重后仅 1 人 -> 不显示合并提示');
  const c12 = captureApi();
  const s12 = S.sendCompose();
  c12.resolve({ ok: true, merge: true, total: 1, sent_count: 1, failed_count: 0, sent: [], failed: [] });
  await s12;
  ok(c12.calls[0].body.to.length === 1, `payload.to 只带 1 个地址（实际 ${c12.calls[0].body.to.length}）`);
  ok(JSON.stringify(c12.calls[0].body.to) === JSON.stringify(['a@x.com']), 'payload.to = ["a@x.com"]');
  ok(lastToast() === '已分别发送给 1 位收件人', `只发 1 封（实际「${lastToast()}」）`);

  console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
  if (fail) console.log('失败用例：\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\n测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
