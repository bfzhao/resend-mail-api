'use strict';

/* =============================================================================
 * 独立验证：写信弹窗「放弃确认」守卫（真实 jsdom + 真实 DOM 事件派发）
 *
 * 运行：
 *   NODE_PATH=C:\Users\Bingfeng\.workbuddy-ai\binaries\node\workspace\node_modules \
 *     <node.exe> test/compose-guard.dom.test.js
 *
 * 退出码：0 = 全部通过；1 = 存在失败。
 * 本文件不修改 public/ 下任何源码，只读 index.html + app.js 并在 jsdom 中执行。
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
// QA_APP_JS 仅用于「变异验证」：指向一份人工构造的缺陷版 app.js，确认本测试确实能抓到缺陷。
// 没有这个钩子时，变异脚本会「跑的是仓库原文件却以为跑的是变体」→ 变体恒不被抓（假阴性）。
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const APP_CSS_PATH = path.join(ROOT, 'public', 'app.css');
const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');
const APP_CSS = fs.readFileSync(APP_CSS_PATH, 'utf8');

const FINGERPRINT = {
  md5: crypto.createHash('md5').update(APP_JS).digest('hex'),
  mtime: fs.statSync(APP_JS_PATH).mtime.toISOString(),
  bytes: Buffer.byteLength(APP_JS),
  path: APP_JS_PATH,
};

/* ---------------------------------------------------------------------------
 * fetch 打桩：只在注入 app.js 之前安装到 window，避免 init() 抛错
 * -------------------------------------------------------------------------*/

function makeFetchStub(opts = {}) {
  const calls = [];
  const mailboxes = opts.mailboxes || [];
  let pendingSend = null;

  const jsonRes = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  const fetchImpl = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const method = String((init && init.method) || 'GET').toUpperCase();
    calls.push({ url, method, body: init && init.body });

    if (url.startsWith('/api/account')) {
      return Promise.resolve(jsonRes({ can_send: true, from_name: 'Me', from_address: 'me@example.com' }));
    }
    if (url.startsWith('/api/mailboxes')) return Promise.resolve(jsonRes({ mailboxes }));
    if (url.startsWith('/api/counts')) {
      return Promise.resolve(jsonRes({ inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 }));
    }
    if (url.startsWith('/api/folders/')) return Promise.resolve(jsonRes({ items: [], total: 0 }));
    if (url.startsWith('/api/messages') && method === 'POST') {
      // 发送请求：挂起，由测试决定何时成功 / 失败
      return new Promise((resolve) => { pendingSend = { resolve, url }; });
    }
    if (url.startsWith('/api/messages')) return Promise.resolve(jsonRes({ message: null, items: [], total: 0 }));
    return Promise.resolve(jsonRes({}));
  };

  return {
    fetchImpl,
    calls,
    get pendingSend() { return pendingSend; },
    hasPendingSend() { return !!pendingSend; },
    settleSend(status = 200, payload = { ok: true }) {
      if (!pendingSend) throw new Error('没有处于挂起状态的发送请求');
      const p = pendingSend;
      pendingSend = null;
      p.resolve(jsonRes(payload, status));
    },
  };
}

/* ---------------------------------------------------------------------------
 * 启动一个「已跑完 init()」的应用实例
 * -------------------------------------------------------------------------*/

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }

async function boot(bootOpts = {}) {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  const stub = makeFetchStub(bootOpts);
  win.fetch = stub.fetchImpl; // 必须在注入 app.js 之前

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  // renderNav() 在 setupEvents() 前一行同步执行 -> 有子节点即代表 setupEvents 已跑完
  let ready = false;
  for (let i = 0; i < 400; i++) {
    const nav = win.document.querySelector('#folder-nav');
    if (nav && nav.children.length > 0 && typeof win.openComposer === 'function') { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);

  return {
    dom, win, doc: win.document, stub,
    close() { try { dom.window.close(); } catch { /* ignore */ } },
  };
}

/* ---------------------------------------------------------------------------
 * 事件 / 断言辅助
 * -------------------------------------------------------------------------*/

const clickEvt = (win) => new win.MouseEvent('click', { bubbles: true, cancelable: true });

function el(ctx, sel) { return ctx.doc.querySelector(sel); }
function clickEl(ctx, sel) { el(ctx, sel).dispatchEvent(clickEvt(ctx.win)); }
/** 点在遮罩空白区：target === currentTarget */
function clickMaskBlank(ctx) { el(ctx, '#modal-mask').dispatchEvent(clickEvt(ctx.win)); }
/** 点弹窗内部：从子元素冒泡到遮罩（target !== currentTarget） */
function clickComposerInside(ctx) { el(ctx, '#composer').dispatchEvent(clickEvt(ctx.win)); }
function clickConfirmInside(ctx) { el(ctx, '#confirm-box').dispatchEvent(clickEvt(ctx.win)); }
function clickConfirmBlank(ctx) { el(ctx, '#confirm-mask').dispatchEvent(clickEvt(ctx.win)); }

function pressEsc(ctx, targetSel) {
  const target = targetSel ? el(ctx, targetSel) : ctx.doc;
  const ev = new ctx.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

const composerOpen = (ctx) => !el(ctx, '#modal-mask').classList.contains('hidden');
const confirmShown = (ctx) => !el(ctx, '#confirm-mask').classList.contains('hidden');
const toastShown = (ctx) => !el(ctx, '#toast').classList.contains('hidden');
const toastText = (ctx) => el(ctx, '#toast').textContent;
const val = (ctx, sel) => el(ctx, sel).value;
const innerHtml = (ctx, sel) => el(ctx, sel).innerHTML;

const evalIn = (ctx, expr) => ctx.win.eval(expr);
const pendingFlag = (ctx) => evalIn(ctx, 'discardConfirmPending');
const baselineOf = (ctx) => evalIn(ctx, 'composerBaseline');
const composing = (ctx) => evalIn(ctx, 'state.composing');
const sendFlag = (ctx) => evalIn(ctx, 'sendInFlight');
const confirmBoxCount = (ctx) => ctx.doc.querySelectorAll('#confirm-box').length;
const confirmMaskCount = (ctx) => ctx.doc.querySelectorAll('#confirm-mask').length;

function setValue(ctx, sel, v) {
  const node = el(ctx, sel);
  node.value = v;
  node.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
}

async function openCompose(ctx) {
  clickEl(ctx, '#compose-btn');
  await ticks(ctx.win, 2);
}

function openReply(ctx, msg) {
  const m = Object.assign({
    id: 'm1', from_email: 'sender@example.com', from_name: 'Sender', reply_to: [],
    subject: 'Hello', mailbox: 'me@example.com', received_at: 1700000000,
    body_text: 'line1\nline2', direction: 'inbound', read: true,
  }, msg || {});
  evalIn(ctx, `currentMessage = ${JSON.stringify(m)};`);
  evalIn(ctx, 'openReplyComposer()');
}

async function addAttachment(ctx, name = 'a.txt', content = 'hello') {
  const input = el(ctx, '#f-attachments');
  if (typeof ctx.win.File !== 'function' || typeof ctx.win.FileReader !== 'function') {
    return { ok: false, reason: 'jsdom 缺少 File/FileReader' };
  }
  const file = new ctx.win.File([content], name, { type: 'text/plain' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
  await ticks(ctx.win, 25);
  Object.defineProperty(input, 'files', { value: [], configurable: true });
  const n = evalIn(ctx, 'state.composing ? state.composing.files.length : -1');
  return { ok: n === 1, count: n, reason: n === 1 ? '' : `附件数量=${n}` };
}

/** 把写信弹窗切到 HTML 富文本模式 */
async function toRich(ctx) {
  clickEl(ctx, '#f-mode');
  await ticks(ctx.win, 2);
  if (!evalIn(ctx, 'state.composing && state.composing.rich === true')) {
    throw new Error('切换富文本失败（rich !== true）');
  }
}

/* ---------------------------------------------------------------------------
 * 用例运行器
 * -------------------------------------------------------------------------*/

const results = [];
let currentTest = '(boot)';
let pass = 0;
let fail = 0;

function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  const tail = detail === undefined ? '' : `  [${detail}]`;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${tail}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }

async function test(name, fn, bootOpts) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot(bootOpts || {});
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    if (ctx) ctx.close();
  }
}

/* ===========================================================================
 * 用例
 * ===========================================================================*/

(async function main() {
  console.log('写信弹窗「放弃确认」守卫 —— 独立 jsdom 验证');
  console.log(`被测版本: md5=${FINGERPRINT.md5}  mtime=${FINGERPRINT.mtime}  bytes=${FINGERPRINT.bytes}`);
  console.log(`被测文件: ${FINGERPRINT.path}${process.env.QA_APP_JS ? '  ← QA_APP_JS 变异体' : ''}`);

  /* ---- T0 环境自检 ---- */
  await test('T0 测试环境自检（harness 可信度）', async (ctx) => {
    ok(typeof ctx.win.openComposer === 'function', 'app.js 已注入且 openComposer 为全局函数');
    ok(el(ctx, '#folder-nav').children.length === 4, 'renderNav 已执行（folder-nav 有 4 项）', el(ctx, '#folder-nav').children.length);
    ok(evalIn(ctx, 'typeof state') === 'object', 'eval 可访问全局词法绑定 state');
    ok(evalIn(ctx, 'typeof composerBaseline') !== 'undefined', 'eval 可访问 composerBaseline（改动 A 已落地）');
    ok(evalIn(ctx, 'typeof sendInFlight') !== 'undefined', 'eval 可访问 sendInFlight（改动 B 已落地）');
    ok(!composerOpen(ctx), '初始状态：写信弹窗隐藏');
    ok(!confirmShown(ctx), '初始状态：确认框隐藏');
    ok(confirmMaskCount(ctx) === 1, '页面中只有 1 个 #confirm-mask', confirmMaskCount(ctx));
    info(`jsdom #f-body-rich.innerText = ${String(evalIn(ctx, 'typeof document.querySelector("#f-body-rich").innerText'))}`);
  });

  /* ---- T1 无用户输入 -> 直接关闭，不弹确认 ---- */
  await test('T1 无输入：点遮罩空白区直接关闭', async (ctx) => {
    await openCompose(ctx);
    ok(composerOpen(ctx), '写信弹窗已打开');
    ok(pendingFlag(ctx) === false, '基线已建立且 pending=false', String(pendingFlag(ctx)));
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '无输入点遮罩 -> 不弹确认框');
    ok(!composerOpen(ctx), '无输入点遮罩 -> 弹窗直接关闭');
    ok(composing(ctx) === null, '无输入点遮罩 -> composing 已清理');
  });

  await test('T1b 无输入：点「取消」直接关闭', async (ctx) => {
    await openCompose(ctx);
    clickEl(ctx, '#composer-cancel');
    ok(!confirmShown(ctx), '无输入点取消 -> 不弹确认框');
    ok(!composerOpen(ctx), '无输入点取消 -> 弹窗直接关闭');
  });

  await test('T1c 无输入：按 Esc 直接关闭', async (ctx) => {
    await openCompose(ctx);
    pressEsc(ctx);
    ok(!confirmShown(ctx), '无输入按 Esc -> 不弹确认框');
    ok(!composerOpen(ctx), '无输入按 Esc -> 弹窗直接关闭');
  });

  await test('T1d 无输入：焦点在输入框内按 Esc 同样生效', async (ctx) => {
    await openCompose(ctx);
    const ev = pressEsc(ctx, '#f-to');
    ok(!composerOpen(ctx), '在 #f-to 内按 Esc -> 弹窗关闭（未被 isTypingTarget 吞掉）');
    ok(ev.defaultPrevented === true, 'Esc 已 preventDefault', String(ev.defaultPrevented));
  });

  await test('T1e 点弹窗内部不算「点外部」', async (ctx) => {
    await openCompose(ctx);
    clickComposerInside(ctx);
    ok(composerOpen(ctx), '点 #composer 内部 -> 弹窗不关闭');
    ok(!confirmShown(ctx), '点 #composer 内部 -> 不弹确认框');
  });

  /* ---- T2 有输入 -> 三入口只弹确认，不关闭 ---- */
  const dirtyCases = [
    ['收件人', async (ctx) => setValue(ctx, '#f-to', 'a@b.com'), 'mask'],
    ['主题', async (ctx) => setValue(ctx, '#f-subject', 'hi'), 'cancel'],
    ['正文(textarea)', async (ctx) => setValue(ctx, '#f-body', 'hello'), 'esc'],
    ['富文本内容', async (ctx) => { await toRich(ctx); evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "rich text"'); }, 'mask'],
    ['附件', async (ctx) => { const r = await addAttachment(ctx); if (!r.ok) throw new Error(`附件桩失败: ${r.reason}`); }, 'mask'],
  ];

  for (const [label, makeDirty, entry] of dirtyCases) {
    await test(`T2 有输入(${label})：入口=${entry} -> 只弹确认、不关闭`, async (ctx) => {
      await openCompose(ctx);
      await makeDirty(ctx);
      ok(evalIn(ctx, 'isComposerDirty()') === true, `脏检测：${label} 改动后 isComposerDirty()=true`);

      if (entry === 'mask') clickMaskBlank(ctx);
      else if (entry === 'cancel') clickEl(ctx, '#composer-cancel');
      else pressEsc(ctx);

      ok(confirmShown(ctx), `${label} + ${entry} -> 弹出确认框`);
      ok(composerOpen(ctx), `${label} + ${entry} -> 写信弹窗仍打开`);
      ok(composing(ctx) !== null, `${label} + ${entry} -> composing 未清空`);
      ok(pendingFlag(ctx) === true, `${label} + ${entry} -> pending=true`);
    });
  }

  await test('T2b 「继续编辑」-> 关确认框、弹窗保留、内容原样', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-subject', '主题A');
    setValue(ctx, '#f-body', '正文B');
    // 模拟用户此前聚焦在收件人
    el(ctx, '#f-to').dispatchEvent(new ctx.win.FocusEvent('focusin', { bubbles: true }));

    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '先弹出确认框');
    clickEl(ctx, '#confirm-cancel');

    ok(!confirmShown(ctx), '点「继续编辑」-> 确认框收起');
    ok(composerOpen(ctx), '点「继续编辑」-> 写信弹窗保留');
    ok(pendingFlag(ctx) === false, '点「继续编辑」-> pending 复位', String(pendingFlag(ctx)));
    ok(val(ctx, '#f-to') === 'a@b.com', '收件人原样保留', val(ctx, '#f-to'));
    ok(val(ctx, '#f-subject') === '主题A', '主题原样保留', val(ctx, '#f-subject'));
    ok(val(ctx, '#f-body') === '正文B', '正文原样保留', val(ctx, '#f-body'));
    ok(ctx.doc.activeElement === el(ctx, '#f-to'), '焦点归还到原编辑元素 #f-to', ctx.doc.activeElement && ctx.doc.activeElement.id);
    ok(evalIn(ctx, 'isComposerDirty()') === true, '收起确认框后仍判脏');

    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '再次请求关闭 -> 重新弹确认框（未卡死）');
  });

  await test('T2c 「放弃」-> 真正关闭并丢弃', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '先弹出确认框');
    clickEl(ctx, '#confirm-ok');
    ok(!confirmShown(ctx), '点「放弃」-> 确认框收起');
    ok(!composerOpen(ctx), '点「放弃」-> 写信弹窗关闭');
    ok(composing(ctx) === null, '点「放弃」-> composing 已清空');
    ok(pendingFlag(ctx) === false, '点「放弃」-> pending 无残留');
    ok(baselineOf(ctx) === null, '点「放弃」-> composerBaseline 无残留');
  });

  /* ---- T3 发送路径 ---- */
  await test('T3a 发送成功 -> 直接关闭、不弹确认', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-subject', 's');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    ok(sendFlag(ctx) === true, '发送中 sendInFlight=true', String(sendFlag(ctx)));
    ok(ctx.stub.hasPendingSend(), '发送请求已发出且挂起');
    ctx.stub.settleSend(200, { ok: true });
    await ticks(ctx.win, 20);
    ok(!confirmShown(ctx), '发送成功 -> 不弹确认框');
    ok(!composerOpen(ctx), '发送成功 -> 弹窗直接关闭');
    ok(composing(ctx) === null, '发送成功 -> composing 已清空');
    ok(toastText(ctx).includes('已发送'), '发送成功 toast', toastText(ctx));
    ok(sendFlag(ctx) === false, 'finally 中 sendInFlight 复位', String(sendFlag(ctx)));
  });

  await test('T3b 发送失败 -> 弹窗不关、内容保留、仅报错', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-subject', 's');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    ctx.stub.settleSend(500, { error: 'boom' });
    await ticks(ctx.win, 20);

    ok(composerOpen(ctx), '发送失败 -> 弹窗仍打开');
    ok(!confirmShown(ctx), '发送失败 -> 不弹确认框');
    ok(val(ctx, '#f-to') === 'a@b.com', '发送失败 -> 收件人保留', val(ctx, '#f-to'));
    ok(val(ctx, '#f-subject') === 's', '发送失败 -> 主题保留', val(ctx, '#f-subject'));
    ok(val(ctx, '#f-body') === 'body', '发送失败 -> 正文保留', val(ctx, '#f-body'));
    ok(toastText(ctx).includes('发送失败') && toastText(ctx).includes('boom'), '发送失败 toast 含原因', toastText(ctx));
    ok(sendFlag(ctx) === false, '发送失败 -> sendInFlight 已复位', String(sendFlag(ctx)));

    // 失败后内容仍在：点外部应弹确认（不是直接丢弃）
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '发送失败后再点外部 -> 弹确认框（内容未被静默丢弃）');
    ok(composerOpen(ctx), '发送失败后再点外部 -> 弹窗仍打开');
  });

  await test('T3c 发送进行中：遮罩 / 取消 / Esc 均被拦下', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    ok(sendFlag(ctx) === true, '发送中 sendInFlight=true', String(sendFlag(ctx)));

    clickMaskBlank(ctx);
    ok(composerOpen(ctx), '发送中点遮罩 -> 弹窗未被关闭');
    ok(!confirmShown(ctx), '发送中点遮罩 -> 不弹放弃确认框（区别于普通脏态）');
    ok(toastShown(ctx) && toastText(ctx).includes('发送'), '发送中点遮罩 -> toast 提示发送中', toastText(ctx));

    clickEl(ctx, '#composer-cancel');
    ok(composerOpen(ctx), '发送中点取消 -> 弹窗未被关闭');
    ok(!confirmShown(ctx), '发送中点取消 -> 不弹确认框');

    pressEsc(ctx);
    ok(composerOpen(ctx), '发送中按 Esc -> 弹窗未被关闭');
    ok(!confirmShown(ctx), '发送中按 Esc -> 不弹确认框');
    ok(evalIn(ctx, 'state.composing !== null') === true, '发送中 -> composing 未清空');

    ctx.stub.settleSend(200, { ok: true });
    await ticks(ctx.win, 20);
    ok(!composerOpen(ctx), '发送成功后弹窗关闭');
    ok(sendFlag(ctx) === false, 'sendInFlight 复位', String(sendFlag(ctx)));
  });

  await test('T3d 发送进行中：请求失败后内容仍在', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    clickMaskBlank(ctx); // 发送中被拦
    ok(composerOpen(ctx), '发送中遮罩点击被拦下');
    ctx.stub.settleSend(500, { error: 'network' });
    await ticks(ctx.win, 20);
    ok(composerOpen(ctx), '失败后弹窗仍打开');
    ok(val(ctx, '#f-body') === 'body', '失败后正文仍在', val(ctx, '#f-body'));
    ok(evalIn(ctx, 'isComposerDirty()') === true, '失败后仍判脏');
  });

  /* ---- T4 回复弹窗基线 ---- */
  await test('T4a 回复预填不算脏：点外部直接关闭', async (ctx) => {
    openReply(ctx);
    ok(composerOpen(ctx), '回复弹窗已打开');
    ok(val(ctx, '#f-to') === 'sender@example.com', '收件人已预填', val(ctx, '#f-to'));
    ok(val(ctx, '#f-subject') === 'Re: Hello', '主题已预填', val(ctx, '#f-subject'));
    ok(evalIn(ctx, 'isComposerDirty()') === false, '仅预填 -> isComposerDirty()=false');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '回复仅预填点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '回复仅预填点外部 -> 直接关闭');
  });

  await test('T4b 回复点「引用原文」改正文 -> 弹确认', async (ctx) => {
    openReply(ctx);
    clickEl(ctx, '#f-quote');
    ok(val(ctx, '#f-body').length > 0, '引用后正文非空', `len=${val(ctx, '#f-body').length}`);
    ok(evalIn(ctx, 'isComposerDirty()') === true, '引用原文后 -> isComposerDirty()=true');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '引用后点外部 -> 弹确认框');
    ok(composerOpen(ctx), '引用后点外部 -> 弹窗仍打开');
  });

  await test('T4c 回复中用户改动主题 -> 弹确认', async (ctx) => {
    openReply(ctx);
    setValue(ctx, '#f-subject', 'Re: Hello!');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '改动主题后判脏');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '改动主题后点外部 -> 弹确认框');
  });

  await test('T4d 回复中用户清空预填主题 -> 弹确认（与基线不同）', async (ctx) => {
    openReply(ctx);
    setValue(ctx, '#f-subject', '');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '清空预填主题 -> 判脏（与基线不同）');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '清空预填主题后点外部 -> 弹确认框');
  });

  /* ---- T5 打开/关闭的状态重置 ---- */
  await test('T5a 放弃关闭后重开：脏状态与确认框全部复位', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '草稿');
    clickMaskBlank(ctx);
    clickEl(ctx, '#confirm-ok');
    ok(!composerOpen(ctx), '已关闭');

    await openCompose(ctx);
    ok(composerOpen(ctx), '重新打开写信弹窗');
    ok(!confirmShown(ctx), '重开后确认框隐藏（无残留）');
    ok(pendingFlag(ctx) === false, '重开后 pending=false');
    ok(baselineOf(ctx) !== null, '重开后已建立新基线');
    ok(val(ctx, '#f-to') === '' && val(ctx, '#f-subject') === '' && val(ctx, '#f-body') === '', '重开后字段清空');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '重开后不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '重开后点外部 -> 直接关闭');
  });

  await test('T5b 确认框残留时调用 openComposer -> 重置确认状态', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '草稿');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '先制造残留确认框');
    evalIn(ctx, 'openComposer()'); // 等价于再次点「写信」
    ok(!confirmShown(ctx), 'openComposer 后确认框隐藏');
    ok(pendingFlag(ctx) === false, 'openComposer 后 pending=false');
    ok(evalIn(ctx, 'isComposerDirty()') === false, 'openComposer 后不脏（新基线）');
    ok(confirmMaskCount(ctx) === 1, '未产生重复确认框 DOM', confirmMaskCount(ctx));
  });

  /* ---- T6 富文本 ---- */
  await test('T6a 仅切换富文本按钮不弄脏表单', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    ok(evalIn(ctx, 'isComposerDirty()') === false, '空表单切到富文本 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '切富文本后点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '切富文本后点外部 -> 直接关闭');
  });

  await test('T6b 先有文字再切富文本 -> 仍判脏', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-body', 'hello');
    await toRich(ctx);
    ok(evalIn(ctx, 'document.querySelector("#f-body-rich").textContent') === 'hello', '切富文本后文字被搬进富文本编辑器', evalIn(ctx, 'document.querySelector("#f-body-rich").textContent'));
    ok(evalIn(ctx, 'isComposerDirty()') === true, '切富文本后仍判脏');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '切富文本后点外部 -> 弹确认框');
  });

  const richNotDirty = [
    ['<br>', '<br>'],
    ['<div></div>', '<div></div>'],
    ['&nbsp;', '&nbsp;'],
    ['<br><div></div>&nbsp;', '<br><div></div>&nbsp;'],
  ];
  for (const [label, markup] of richNotDirty) {
    await test(`T6c 富文本仅 ${label} 不算脏`, async (ctx) => {
      await openCompose(ctx);
      await toRich(ctx);
      evalIn(ctx, `document.querySelector("#f-body-rich").innerHTML = ${JSON.stringify(markup)}`);
      const pt = evalIn(ctx, 'richPlainText(document.querySelector("#f-body-rich"))');
      ok(pt === '', `richPlainText(${label}) 为空`, JSON.stringify(pt));
      ok(evalIn(ctx, 'isComposerDirty()') === false, `富文本仅 ${label} -> 不脏`);
      clickMaskBlank(ctx);
      ok(!confirmShown(ctx) && !composerOpen(ctx), `富文本仅 ${label} 点外部 -> 直接关闭`);
    });
  }

  await test('T6d 富文本有真实文字 -> 判脏', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "x"');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '富文本有文字 -> 脏');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '富文本有文字点外部 -> 弹确认框');
  });

  /* ---- T7 确认框层级 / 防重入 ---- */
  await test('T7a 点确认框内部不算「点外部」', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '草稿');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '确认框已弹出');
    clickConfirmInside(ctx);
    ok(confirmShown(ctx), '点 #confirm-box 内部 -> 确认框不收起');
    ok(composerOpen(ctx), '点 #confirm-box 内部 -> 弹窗不关闭');
    ok(composing(ctx) !== null, '点 #confirm-box 内部 -> 内容未丢');
  });

  await test('T7b 点确认框空白区 -> 收起确认框、弹窗保留', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '草稿');
    clickMaskBlank(ctx);
    clickConfirmBlank(ctx);
    ok(!confirmShown(ctx), '点确认框空白区 -> 确认框收起');
    ok(composerOpen(ctx), '点确认框空白区 -> 写信弹窗保留');
    ok(val(ctx, '#f-subject') === '草稿', '内容保留');
  });

  await test('T7c 防重入：确认框已显示时重复点遮罩不叠加', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '草稿');
    clickMaskBlank(ctx);
    ok(pendingFlag(ctx) === true, '首次触发 pending=true');
    clickMaskBlank(ctx);
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '重复点遮罩 -> 确认框仍显示');
    ok(composerOpen(ctx), '重复点遮罩 -> 弹窗未关闭');
    ok(confirmBoxCount(ctx) === 1, '未叠加确认框 DOM', `count=${confirmBoxCount(ctx)}`);
    ok(pendingFlag(ctx) === true, 'pending 仍为 true');

    clickEl(ctx, '#confirm-cancel');
    ok(!confirmShown(ctx), '一次「继续编辑」即可收起（无叠加残留）');
    ok(composerOpen(ctx), '弹窗仍打开');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '再次点遮罩仍能弹出（未卡死）');
  });

  await test('T7d Esc 层级：确认框显示时 Esc 收起确认框而非关闭弹窗', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '草稿');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '先弹出确认框');

    pressEsc(ctx);
    ok(!confirmShown(ctx), 'Esc -> 收起确认框');
    ok(composerOpen(ctx), 'Esc -> 写信弹窗未关闭');
    ok(val(ctx, '#f-subject') === '草稿', 'Esc -> 内容保留');
    ok(pendingFlag(ctx) === false, 'Esc -> pending=false');

    pressEsc(ctx);
    ok(confirmShown(ctx), '再按 Esc -> 重新弹出确认框（弹窗仍开）');
    pressEsc(ctx);
    ok(!confirmShown(ctx) && composerOpen(ctx), '再按 Esc -> 收起确认框，弹窗仍在');
  });

  /* ---- T8 边界用例 ---- */
  await test('T8a 只输入一个空格（纯文本正文）-> 不脏、直接关闭', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-body', ' ');
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`纯文本正文仅一个半角空格 -> isComposerDirty()=${dirty}`);
    ok(dirty === false, '纯文本仅空格 -> 不脏（Fix 2 norm() 归一化）');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '纯文本仅空格点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '纯文本仅空格点外部 -> 直接关闭');
  });

  await test('T8b 只输入一个空格（主题/收件人）-> 不脏、直接关闭', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', ' ');
    setValue(ctx, '#f-to', '  ');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '主题与收件人仅空格 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '主题/收件人仅空格点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '主题/收件人仅空格点外部 -> 直接关闭');
  });

  await test('T8c 只输入空格（富文本）-> 不脏（两种模式一致）', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "&nbsp;"');
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`富文本仅 &nbsp;（等价一个空格）-> isComposerDirty()=${dirty}`);
    ok(dirty === false, '富文本仅空格 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '富文本仅空格点外部 -> 直接关闭');
  });

  await test('T8h 反向保护：纯文本真的输入文字、不切换模式 -> 仍弹确认', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-body', 'hi');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '纯文本 "hi"（未切模式）-> 判脏');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '纯文本 "hi" 点外部 -> 弹确认框');
    ok(composerOpen(ctx), '纯文本 "hi" 点外部 -> 弹窗仍打开');
    clickEl(ctx, '#confirm-cancel');
    ok(val(ctx, '#f-body') === 'hi', '「继续编辑」后正文保留', val(ctx, '#f-body'));
  });

  await test('T8d 输入后又清空 -> 回到不脏、直接关闭', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '临时');
    setValue(ctx, '#f-to', 'x@y.com');
    setValue(ctx, '#f-body', 'temp');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '输入后判脏');
    setValue(ctx, '#f-subject', '');
    setValue(ctx, '#f-to', '');
    setValue(ctx, '#f-body', '');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '全部清空后 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '清空后点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '清空后点外部 -> 直接关闭');
  });

  await test('T8e 只加附件后点外部 -> 弹确认；继续编辑后附件仍在', async (ctx) => {
    await openCompose(ctx);
    const r = await addAttachment(ctx, 'only.txt');
    ok(r.ok, '附件已加入 state.composing.files', r.reason || `count=${r.count}`);
    ok(evalIn(ctx, 'isComposerDirty()') === true, '仅附件 -> 判脏');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '仅附件点外部 -> 弹确认框');
    clickEl(ctx, '#confirm-cancel');
    ok(evalIn(ctx, 'state.composing.files.length') === 1, '继续编辑后附件仍在', evalIn(ctx, 'state.composing.files.length'));
    ok(el(ctx, '#f-attach-list').children.length === 1, '附件 chip 仍渲染', el(ctx, '#f-attach-list').children.length);
    ok(composerOpen(ctx), '弹窗仍打开');
  });

  await test('T8f 移除附件后 -> 回到不脏', async (ctx) => {
    await openCompose(ctx);
    const r = await addAttachment(ctx, 'only.txt');
    if (!r.ok) throw new Error(`附件桩失败: ${r.reason}`);
    const rm = el(ctx, '#f-attach-list .rm');
    ok(!!rm, '附件 chip 上有移除按钮');
    rm.dispatchEvent(clickEvt(ctx.win));
    await ticks(ctx.win, 3);
    ok(evalIn(ctx, 'state.composing.files.length') === 0, '附件已移除', evalIn(ctx, 'state.composing.files.length'));
    ok(evalIn(ctx, 'isComposerDirty()') === false, '移除附件后 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '移除附件后点外部 -> 直接关闭');
  });

  await test('T8g Fix1 重点攻击：隐藏编辑器残留不再造成假提示', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-body', 'hi');
    await toRich(ctx);
    // 切到富文本后可见内容 = hi；此处模拟用户在富文本里把可见内容删光
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = ""');
    const visible = evalIn(ctx, 'richPlainText(document.querySelector("#f-body-rich"))');
    const bodyStill = val(ctx, '#f-body');
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`富文本可见内容="${visible}"  隐藏 #f-body 残留="${bodyStill}"  isComposerDirty=${dirty}`);
    ok(bodyStill === 'hi', '前提成立：隐藏的 #f-body 确实仍残留 "hi"', JSON.stringify(bodyStill));
    ok(visible === '', '可见富文本内容已为空');
    ok(dirty === false, 'Fix 1：只认可见编辑器 -> 不脏（修复前的假提示已消除）');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx), '该情形点外部 -> 不弹确认框');
    ok(!composerOpen(ctx), '该情形点外部 -> 直接关闭');
  });

  /* ---- T9 补充：toast 在发送成功时不会误报「发送中」---- */
  await test('T9 发送成功后 sendInFlight 复位，后续点外部按普通脏态处理', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-to', 'a@b.com');
    setValue(ctx, '#f-body', 'body');
    clickEl(ctx, '#composer-send');
    ctx.stub.settleSend(500, { error: 'boom' });
    await ticks(ctx.win, 20);
    ok(sendFlag(ctx) === false, '失败后 sendInFlight=false');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '失败后点外部 -> 走普通脏态弹确认框（不是「发送中」拦截）');
    ok(!toastText(ctx).includes('正在发送中'), 'toast 不再是「发送中」文案', toastText(ctx));
  });

  /* ---- T10 覆盖层集成检查（确认框必须真的盖在写信弹窗之上） ---- */
  await test('T10 CSS：确认框覆盖层真的拦截写信弹窗', async (ctx) => {
    const block = (sel) => {
      const i = APP_CSS.indexOf(`${sel} {`);
      if (i < 0) return null;
      const j = APP_CSS.indexOf('}', i);
      return APP_CSS.slice(i, j);
    };
    const modal = block('#modal-mask');
    const confirm = block('#confirm-mask');
    const hidden = /\.hidden\s*\{[^}]*display:\s*none\s*!important/.test(APP_CSS);
    const z = (s) => { const m = s && s.match(/z-index:\s*(\d+)/); return m ? Number(m[1]) : NaN; };

    ok(hidden, '.hidden 使用 display:none !important（否则 id 选择器会盖过 .hidden）');
    ok(!!modal && /position:\s*fixed/.test(modal) && /inset:\s*0/.test(modal), '#modal-mask 为全屏 fixed 遮罩');
    ok(!!confirm && /position:\s*fixed/.test(confirm) && /inset:\s*0/.test(confirm), '#confirm-mask 为全屏 fixed 遮罩');
    ok(z(confirm) > z(modal), `#confirm-mask z-index(${z(confirm)}) > #modal-mask z-index(${z(modal)}) -> 确认框在写信弹窗之上`);
    info(`modal z=${z(modal)} confirm z=${z(confirm)}`);
  });

  /* ---- T11 发送人下拉（发件邮箱）变更是否算脏 ---- */
  await test('T11 Fix3：只切换发件邮箱 -> 判脏、弹确认', async (ctx) => {
    await openCompose(ctx);
    const sel = el(ctx, '#f-mailbox');
    const options = Array.from(sel.options).map((o) => o.value);
    ok(options.length >= 2, '发件邮箱下拉有多个选项', options.join(','));
    ok(evalIn(ctx, 'isComposerDirty()') === false, '未改动时不脏');
    const original = sel.value;
    const other = options.find((v) => v !== original);
    sel.value = other;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`切换发件邮箱 ${original} -> ${other} 后 isComposerDirty()=${dirty}`);
    ok(dirty === true, 'Fix 3：仅切换发件邮箱 -> 判脏（发件人已纳入基线）');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '仅切换发件邮箱点外部 -> 弹确认框');
    ok(composerOpen(ctx), '仅切换发件邮箱点外部 -> 弹窗仍打开');
    clickEl(ctx, '#confirm-cancel');
    ok(el(ctx, '#f-mailbox').value === other, '「继续编辑」后发件人选择保留', el(ctx, '#f-mailbox').value);
  }, { mailboxes: [{ mailbox: 'me@example.com' }, { mailbox: 'alias@example.com' }] });

  await test('T11b 发件邮箱改回原值 -> 回到不脏', async (ctx) => {
    await openCompose(ctx);
    const sel = el(ctx, '#f-mailbox');
    const original = sel.value;
    const other = Array.from(sel.options).map((o) => o.value).find((v) => v !== original);
    sel.value = other;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    ok(evalIn(ctx, 'isComposerDirty()') === true, '改发件人 -> 脏');
    sel.value = original;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    ok(evalIn(ctx, 'isComposerDirty()') === false, '改回原值 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '改回原值点外部 -> 直接关闭');
  }, { mailboxes: [{ mailbox: 'me@example.com' }, { mailbox: 'alias@example.com' }] });

  /* ---- T11c 回信：改选发件人必须进入请求体（后端曾完全忽略它） ---- */
  await test('T11c 回信时改选发件人 -> 请求体必须带上所选 mailbox', async (ctx) => {
    const orig = 'me@example.com';
    const other = 'alias@example.com';
    openReply(ctx, { mailbox: orig });
    await ticks(ctx.win, 2);
    ok(composerOpen(ctx), '回复弹窗已打开');

    const sel = el(ctx, '#f-mailbox');
    const opts = Array.from(sel.options).map((o) => o.value);
    ok(opts.join(',') === `${orig},${other}`, '发件人下拉含两个地址（否则下面的改选无从谈起）', opts.join(','));
    ok(sel.value === orig, '默认沿用「收到原邮件的那个信箱」', sel.value);

    sel.value = other;
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    setValue(ctx, '#f-body', '回复内容');
    clickEl(ctx, '#composer-send');
    ok(ctx.stub.hasPendingSend(), '发送请求已发出且挂起');

    const sent = ctx.stub.calls.filter((c) => c.method === 'POST' && /\/api\/messages\/m1\/reply$/.test(c.url));
    ok(sent.length === 1, '恰好 1 个回信请求（按 c.url 过滤，不是拿正则直接测对象）',
      sent.map((c) => c.url).join(',') || '（无）');
    const body = sent.length ? JSON.parse(sent[0].body) : null;
    ok(body && body.mailbox === other,
      '请求体 mailbox 是用户改选的地址（否则后端只能退回原邮件的收件信箱）',
      body && JSON.stringify(body.mailbox));
    ok(body && body.merge === undefined, '回信请求不得携带 merge（合并发送只对写信生效）');

    ctx.stub.settleSend(200, { ok: true });
    await ticks(ctx.win, 15);
  }, { mailboxes: [{ mailbox: 'me@example.com' }, { mailbox: 'alias@example.com' }] });

  /* ---- T13 norm() 归一化边界 ---- */
  await test('T13 norm() 边界：null/undefined/各类空白', async (ctx) => {
    const probe = (expr) => evalIn(ctx, `(() => { const r = norm(${expr}); return JSON.stringify(r); })()`);
    const cases = [
      ['norm(null)', 'null', '""'],
      ['norm(undefined)', 'undefined', '""'],
      ["norm('')", "''", '""'],
      ["norm('  ')", "'  '", '""'],
      ["norm('\\t\\n\\r')", "'\\t\\n\\r'", '""'],
      ["norm('\\u00a0')", "'\\u00a0'", '""'],
      ["norm('\\u3000')", "'\\u3000'", '""'],
      ["norm(' \\u3000 \\u00a0 ')", "' \\u3000 \\u00a0 '", '""'],
      ["norm('\\u3000x\\u3000')", "'\\u3000x\\u3000'", '"x"'],
      ["norm(' a b ')", "' a b '", '"a b"'],
      ['norm(0)', '0', '"0"'],
    ];
    for (const [label, expr, expect] of cases) {
      const got = probe(expr);
      ok(got === expect, `${label} -> ${expect}`, `实际 ${got}`);
    }
    info('JS trim() 的 WhiteSpace 含 U+3000 全角空格与 U+00A0 NBSP，实测已被去掉');
  });

  /* ---- T14 全角空格 / 各种空白的行为一致性 ---- */
  const blankCases = [
    ['主题=全角空格', (ctx) => setValue(ctx, '#f-subject', '\u3000'), '#f-subject'],
    ['收件人=全角空格', (ctx) => setValue(ctx, '#f-to', '\u3000'), '#f-to'],
    ['正文=全角空格', (ctx) => setValue(ctx, '#f-body', '\u3000'), '#f-body'],
    ['正文=NBSP', (ctx) => setValue(ctx, '#f-body', '\u00a0'), '#f-body'],
    ['正文=换行制表符', (ctx) => setValue(ctx, '#f-body', '\n\t'), '#f-body'],
    ['正文=半角+全角混合', (ctx) => setValue(ctx, '#f-body', ' \u3000 \u00a0 '), '#f-body'],
  ];
  for (const [label, make, sel] of blankCases) {
    await test(`T14 ${label} -> 不脏、直接关闭`, async (ctx) => {
      await openCompose(ctx);
      make(ctx);
      const dirty = evalIn(ctx, 'isComposerDirty()');
      info(`${label} -> isComposerDirty()=${dirty}`);
      ok(dirty === false, `${label} -> 不脏`);
      clickMaskBlank(ctx);
      ok(!confirmShown(ctx) && !composerOpen(ctx), `${label} 点外部 -> 直接关闭、无提示`);
    });
  }

  await test('T14b 富文本=全角空格 -> 不脏（与纯文本一致）', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "\\u3000"');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '富文本仅全角空格 -> 不脏');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '富文本仅全角空格点外部 -> 直接关闭');
  });

  await test('T14c 全角空格 + 真实文字 -> 判脏', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-subject', '\u3000x\u3000');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '全角空格包裹真实文字 -> 判脏');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '点外部 -> 弹确认框');
  });

  await test('T14d 基线非空（回复预填主题）时首尾空格不改变判定', async (ctx) => {
    openReply(ctx); // 基线 subject = "Re: Hello"
    ok(evalIn(ctx, 'isComposerDirty()') === false, '回复刚打开、未改动 -> 不脏');
    setValue(ctx, '#f-subject', 'Re: Hello   ');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '主题尾部加空格 -> 不脏（norm 去首尾空白）');
    setValue(ctx, '#f-subject', '   Re: Hello');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '主题首部加空格 -> 不脏');
    setValue(ctx, '#f-subject', '\u3000Re: Hello\u3000');
    ok(evalIn(ctx, 'isComposerDirty()') === false, '主题首尾加全角空格 -> 不脏');
    setValue(ctx, '#f-subject', 'Re: Hello!');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '主题真的加字 -> 脏');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '点外部 -> 弹确认框');
  });

  await test('T14e 内部空格差异仍算脏（norm 只去首尾、不折叠内部）', async (ctx) => {
    openReply(ctx); // 基线 subject = "Re: Hello"
    setValue(ctx, '#f-subject', 'Re:  Hello');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '主题内部多一个空格 -> 仍脏（norm 不做内部归一化）');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '点外部 -> 弹确认框');
  });

  /* ---- T14f 空基线下正文首尾带空格的真实文字 -> 仍脏 ---- */
  await test('T14f 空基线下正文首尾带空格的真实文字 -> 仍脏', async (ctx) => {
    await openCompose(ctx);
    setValue(ctx, '#f-body', '  hello  ');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '基线为空、正文 "  hello  " -> 脏（去空格后仍有内容）');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '点外部 -> 弹确认框');
  });

  /* ---- T16 守卫与发送校验口径一致性（复核 kou 的 N1 修复） ---- */
  await test('T16 守卫判空 ⟺ 发送拒绝（htmlHasText 复用 richPlainText）', async (ctx) => {
    const cases = [
      ['<div>&nbsp;</div>', '实体 &nbsp;'],
      ['<div>&#160;</div>', '实体 &#160;'],
      ['<div> </div>', '裸空格'],
      ['<div><br></div>', '仅 <br>'],
      ['<img src="x">', '纯图片（无文字）'],
      ['<div>hi</div>', '真实文字'],
    ];
    for (const [markup, label] of cases) {
      const c = await boot();
      try {
        await openCompose(c);
        await toRich(c);
        evalIn(c, `document.querySelector("#f-body-rich").innerHTML = ${JSON.stringify(markup)}`);
        const guardDirty = evalIn(c, 'isComposerDirty()'); // 收件人/主题均为空，只反映正文
        setValue(c, '#f-to', 'a@b.com');
        clickEl(c, '#composer-send');
        const sent = c.stub.hasPendingSend();
        info(`markup=${markup}  守卫判脏=${guardDirty}  发送放行=${sent}  toast="${toastText(c)}"`);
        ok(guardDirty === sent, `${label}：守卫判脏(${guardDirty}) 与 发送放行(${sent}) 口径一致`);
        if (sent) { c.stub.settleSend(200, { ok: true }); await ticks(c.win, 15); }
      } finally {
        c.close();
      }
    }
  });

  await test('T16b 有文字 + 图片：守卫判脏、发送放行且 html 原样保留', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "<div>hi<img src=\\"x\\"></div>"');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '文字+图片 -> 守卫判脏');
    setValue(ctx, '#f-to', 'a@b.com');
    clickEl(ctx, '#composer-send');
    ok(ctx.stub.hasPendingSend() === true, '发送放行');
    const post = ctx.stub.calls.find((x) => x.method === 'POST' && x.url.startsWith('/api/messages'));
    const payload = post && post.body ? JSON.parse(post.body) : null;
    info(`payload.html = ${payload && JSON.stringify(payload.html)}`);
    ok(!!payload && typeof payload.html === 'string' && payload.html.includes('<img'), 'payload.html 未被丢弃、图片仍在', payload && String(payload.html));
    if (ctx.stub.hasPendingSend()) { ctx.stub.settleSend(200, { ok: true }); await ticks(ctx.win, 15); }
  });


  await test('T15 富文本仅 &nbsp;：守卫判空且发送拒绝（N1 修复验证）', async (ctx) => {
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "&nbsp;"');
    const dirty = evalIn(ctx, 'isComposerDirty()');
    info(`富文本仅 &nbsp;（收件人/主题均为空）-> isComposerDirty()=${dirty}`);
    ok(dirty === false, '守卫：仅 &nbsp; 视为无内容');
    clickMaskBlank(ctx);
    ok(!confirmShown(ctx) && !composerOpen(ctx), '仅 &nbsp; 点外部 -> 直接关闭、不提示');

    // 发送侧：htmlHasText 已改为复用 richPlainText，应当同样判「无内容」
    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "&nbsp;"');
    setValue(ctx, '#f-to', 'a@b.com');
    clickEl(ctx, '#composer-send');
    const sent = ctx.stub.hasPendingSend();
    info(`点发送后是否发出请求 = ${sent}；toast="${toastText(ctx)}"`);
    ok(sent === false, '发送侧：仅 &nbsp; 不再被放行（N1 口径已统一）');
    ok(toastText(ctx).includes('请填写邮件内容'), '给出「请填写邮件内容」提示', toastText(ctx));
  });

  await test('T4e 回复 + 富文本中「引用原文」-> 弹确认', async (ctx) => {
    openReply(ctx);
    await toRich(ctx);
    clickEl(ctx, '#f-quote');
    ok(evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML').includes('blockquote'), '富文本中插入了引用块');
    ok(evalIn(ctx, 'isComposerDirty()') === true, '富文本引用后判脏');
    clickMaskBlank(ctx);
    ok(confirmShown(ctx), '富文本引用后点外部 -> 弹确认框');
    ok(composerOpen(ctx), '富文本引用后点外部 -> 弹窗仍打开');
  });

  /* ---- T12 诊断：jsdom innerText 缺失的影响（环境局限，非实现 Bug） ---- */
  await test('T12 诊断：jsdom 未实现 innerText 对 rich->plain 往返的影响', async (ctx) => {
    const innerTextType = evalIn(ctx, 'typeof document.querySelector("#f-body-rich").innerText');
    info(`jsdom 中 #f-body-rich.innerText 的类型 = ${innerTextType}`);
    ok(innerTextType === 'undefined', 'jsdom 未实现 innerText（记录为测试环境局限）');

    await openCompose(ctx);
    await toRich(ctx);
    evalIn(ctx, 'document.querySelector("#f-body-rich").innerHTML = "hello"');
    ok(evalIn(ctx, 'richPlainText(document.querySelector("#f-body-rich"))') === 'hello', 'richPlainText 经 textContent 兜底可正确取到 hello');
    clickEl(ctx, '#f-mode'); // 切回纯文本
    await ticks(ctx.win, 2);
    const taValue = val(ctx, '#f-body');
    info(`切回纯文本后 #f-body.value = ${JSON.stringify(taValue)}（真浏览器应为 "hello"）`);
    ok(taValue === 'undefined', 'jsdom 下 textarea 被写成字符串 "undefined"（环境局限：toggleRich 的 rich->plain 分支依赖 innerText）');
    info('结论：rich->plain 往返路径在 jsdom 中不可信，需真浏览器人工复核；本条不计为实现 Bug。');
  });

  /* ---- 汇总 ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) {
    console.log('（无）');
  } else {
    for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail ? `  [${f.detail}]` : ''}`);
  }
  console.log(`\n被测版本: md5=${FINGERPRINT.md5}  mtime=${FINGERPRINT.mtime}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
})();
