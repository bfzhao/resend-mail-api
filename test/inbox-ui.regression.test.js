'use strict';

/* =============================================================================
 * 收件箱 UI 三类缺陷的独立回归验证（真实 jsdom + 真实 DOM 事件 + 真实 app.js）
 *
 * 运行：
 *   NODE_PATH='C:\Users\Bingfeng\.workbuddy-ai\binaries\node\workspace\node_modules' \
 *     node test/inbox-ui.regression.test.js
 *
 * 退出码：0 = 全部通过；1 = 存在失败；2 = 环境缺失（找不到 jsdom）。
 * 本文件只读 public/ 下源码，不做任何修改。
 *
 * 覆盖缺陷：
 *   BUG-1  行选中高亮残留（同时出现多个 .list-item.active）
 *   BUG-1b 「全选本页」复选框状态残留
 *   BUG-2  读过之后列表行仍显示未读（0→1 跃迁未回写本地）
 *   BUG-3a 账号下拉被静默改写（state.mailbox 与 sel.value 脱钩）
 *   BUG-3c 读信后账号未读数陈旧（不重新请求 /api/mailboxes）
 *   BUG-3d 下拉项/列表标题口径未标注
 *   BUG-4  定时同步把列表清空（force 路径未归零 offset → 请求第 2 页 → 空页整体覆盖）
 *   BUG-5  localStorage 恢复路径下具体账号选择被静默重置（下拉/请求/列表全丢）
 *
 * 说明：断言全部基于「需求规格描述的正确行为」与 app.js 中真实存在的公开函数
 * （openFolder / openMessage / closeMessagePane / renderMailboxSelect / loadMailboxes /
 *  renderSelectBar），通过真实 DOM 事件驱动，不依赖臆造的私有函数名。
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('无法加载 jsdom。请用 NODE_PATH 指向 jsdom 所在 node_modules（Windows 反斜杠写法）：');
  console.error("  NODE_PATH='C:\\Users\\Bingfeng\\.workbuddy-ai\\binaries\\node\\workspace\\node_modules' node test/inbox-ui.regression.test.js");
  console.error(String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
// QA_APP_JS 仅用于「变异验证」：指向一份人工构造的缺陷版 app.js，确认本测试确实能抓到缺陷。
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
const INDEX_PATH = path.join(ROOT, 'public', 'index.html');
const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');

const FINGERPRINT = {
  md5: crypto.createHash('md5').update(APP_JS).digest('hex'),
  mtime: fs.statSync(APP_JS_PATH).mtime.toISOString(),
  bytes: Buffer.byteLength(APP_JS),
};

/* ---------------------------------------------------------------------------
 * fetch 打桩（jsdom 不实现 fetch；不打桩则 api() 会静默吞成「网络错误」）
 * -------------------------------------------------------------------------*/

function makeStub(cfg = {}) {
  const calls = [];
  const counters = { account: 0, mailboxes: 0, counts: 0, folders: 0, detail: 0, batch: 0, patch: 0 };
  const store = {
    mailboxes: cfg.mailboxes || [],
    folders: cfg.folders || {},
    messages: cfg.messages || {},
    counts: cfg.counts || { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 },
  };
  // honorPaging：真实后端语义，按 limit/offset 切片返回（BUG-4 必需，否则「第 2 页为空」无法复现）
  const honorPaging = !!cfg.honorPaging;
  // foldersByMailbox：按 mailbox 查询参数返回不同数据集（BUG-5 用；未命中且 mailbox 非空 → 空页）
  const foldersByMailbox = cfg.foldersByMailbox || null;

  const jsonRes = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });

  const fetchImpl = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ url, method, body: init.body });
    const pathOnly = url.split('?')[0];
    const qs = new URLSearchParams(url.split('?')[1] || '');

    if (pathOnly === '/api/account') {
      counters.account++;
      return Promise.resolve(jsonRes({ can_send: true, from_name: 'Me', from_address: 'me@example.com' }));
    }
    if (pathOnly === '/api/mailboxes') {
      counters.mailboxes++;
      return Promise.resolve(jsonRes({ mailboxes: store.mailboxes }));
    }
    if (pathOnly === '/api/counts') {
      counters.counts++;
      return Promise.resolve(jsonRes(store.counts));
    }
    const fm = /^\/api\/folders\/([a-z]+)$/.exec(pathOnly);
    if (fm) {
      counters.folders++;
      let d = store.folders[fm[1]] || { items: [], total: 0 };
      if (foldersByMailbox) {
        const mb = qs.get('mailbox') || '';
        d = Object.prototype.hasOwnProperty.call(foldersByMailbox, mb)
          ? foldersByMailbox[mb]
          : { items: [], total: 0 }; // 未知账号 → 空页（真实后端语义）
      }
      if (honorPaging) {
        const limit = Number(qs.get('limit') || 50);
        const offset = Number(qs.get('offset') || 0);
        return Promise.resolve(jsonRes({ folder: fm[1], items: d.items.slice(offset, offset + limit), total: d.total }));
      }
      return Promise.resolve(jsonRes({ folder: fm[1], items: d.items, total: d.total }));
    }
    if (pathOnly === '/api/messages/batch' && method === 'POST') {
      counters.batch++;
      return Promise.resolve(jsonRes({ changed: 1 }));
    }
    const mm = /^\/api\/messages\/([^/]+)$/.exec(pathOnly);
    if (mm) {
      const id = decodeURIComponent(mm[1]);
      if (method === 'PATCH') {
        counters.patch++;
        return Promise.resolve(jsonRes({ ok: true }));
      }
      counters.detail++;
      const d = store.messages[id];
      if (!d) return Promise.resolve(jsonRes({ error: '邮件不存在' }, 404));
      return Promise.resolve(jsonRes(d));
    }
    return Promise.resolve(jsonRes({}));
  };

  return { fetchImpl, calls, counters, store };
}

/* ---------------------------------------------------------------------------
 * 固定装置（每条用例各构造一份全新对象，避免跨用例互相污染）
 * -------------------------------------------------------------------------*/

function msg(id, read, extra = {}) {
  return Object.assign({
    id,
    direction: 'inbound',
    from_name: '发件人' + id,
    from_email: id.toLowerCase() + '@x.com',
    subject: '主题 ' + id,
    to_emails: ['me@x.com'],
    received_at: 1700000000 + id.charCodeAt(0),
    read,
    starred: 0,
    status: 'received',
    attachments_count: 0,
    preview: '预览 ' + id,
    mailbox: 'alpha@x.com',
  }, extra);
}

/** 详情响应：服务端在响应前已把 read 置 1（src/index.ts getMessageDetail 的真实行为）。 */
function detail(m, read) {
  return {
    message: Object.assign({}, m, {
      read,
      body_text: '正文 ' + m.id,
      body_html: null,
      thread_id: 't-' + m.id,
      cc: [],
      bcc: [],
      reply_to: [],
      mailbox: m.mailbox || 'alpha@x.com',
    }),
    attachments: [],
    thread: [],
  };
}

/**
 * 列表首项 C 是「已读」的占位邮件：init() 的 maybeAutoOpen() 会自动打开首项，
 * 用它挡住自动打开，A/B 的初始未读状态才不会被自动打开顺带改掉。
 */
function inboxFixture() {
  const C = msg('C', 1);
  const A = msg('A', 0);
  const B = msg('B', 1);
  const S1 = msg('S1', 1, { direction: 'outbound', status: 'sent', mailbox: 'alpha@x.com' });
  return {
    mailboxes: [
      { mailbox: 'alpha@x.com', inbox_unread: 1, inbox_total: 2, sent_total: 1 },
      { mailbox: 'beta@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
    ],
    folders: {
      inbox: { items: [C, A, B], total: 3 },
      sent: { items: [S1], total: 1 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages: {
      A: detail(A, 1),
      B: detail(B, 1),
      C: detail(C, 1),
      S1: detail(S1, 1),
    },
    counts: { inbox_unread: 1, inbox_total: 2, sent_total: 1, starred_total: 0, trash_total: 0 },
  };
}

/** BUG-4 固定装置：50 行、total=50，桩按 limit/offset 真实切片 → 第 2 页必为空。 */
function pagingFixture() {
  const items = [];
  for (let i = 0; i < 50; i++) items.push(msg('P' + String(i).padStart(2, '0'), i === 0 ? 0 : 1));
  const messages = {};
  for (const it of items) messages[it.id] = detail(it, it.read);
  return {
    honorPaging: true,
    folders: {
      inbox: { items, total: 50 },
      sent: { items: [], total: 0 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages,
    mailboxes: [{ mailbox: 'alpha@x.com', inbox_unread: 1, inbox_total: 50, sent_total: 0 }],
    counts: { inbox_unread: 1, inbox_total: 50, sent_total: 0, starred_total: 0, trash_total: 0 },
  };
}

/** BUG-5 固定装置：上次会话残留的 localStorage 快照，选中具体账号 beta。 */
function seededBetaFixture() {
  const items = [];
  for (let i = 0; i < 7; i++) items.push(msg('B' + i, i === 0 ? 0 : 1, { mailbox: 'beta@x.com' }));
  const messages = {};
  for (const it of items) messages[it.id] = detail(it, it.read);
  const mailboxes = [
    { mailbox: 'alpha@x.com', inbox_unread: 2, inbox_total: 3, sent_total: 0 },
    { mailbox: 'beta@x.com', inbox_unread: 1, inbox_total: 7, sent_total: 0 },
  ];
  const counts = { inbox_unread: 1, inbox_total: 7, sent_total: 0, starred_total: 0, trash_total: 0 };
  return {
    mailboxes,
    counts,
    seedCache: {
      v: 1,
      at: Date.now(),
      folderKey: 'beta@x.com|inbox|',
      mailbox: 'beta@x.com',
      folderName: 'inbox',
      q: '',
      folder: { items, total: 7 },
      counts,
      mailboxes,
      openId: null,
    },
    // 「全部邮箱」视图刻意给不同的行数，便于区分「走错分支」
    foldersByMailbox: {
      'beta@x.com': { items, total: 7 },
      '': { items: items.slice(0, 3), total: 3 },
      'alpha@x.com': { items: [], total: 0 },
    },
    messages,
  };
}

/** BUG-5 负控制固定装置：快照里的账号已不存在（ghost）。 */function seededGhostFixture() {
  const items = [];
  for (let i = 0; i < 4; i++) items.push(msg('G' + i, 1, { mailbox: 'ghost@x.com' }));
  const messages = {};
  for (const it of items) messages[it.id] = detail(it, 1);
  const mailboxes = [
    { mailbox: 'alpha@x.com', inbox_unread: 2, inbox_total: 3, sent_total: 0 },
    { mailbox: 'beta@x.com', inbox_unread: 0, inbox_total: 7, sent_total: 0 },
  ];
  const counts = { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 };
  return {
    mailboxes,
    counts,
    seedCache: {
      v: 1,
      at: Date.now(),
      folderKey: 'ghost@x.com|inbox|',
      mailbox: 'ghost@x.com',
      folderName: 'inbox',
      q: '',
      folder: { items, total: 4 },
      counts: { inbox_unread: 0, inbox_total: 4, sent_total: 0, starred_total: 0, trash_total: 0 },
      mailboxes,
      openId: null,
    },
    foldersByMailbox: {
      'ghost@x.com': { items, total: 4 },
      // 回退目标 alpha 必须有内容，否则列表会空、init 的就绪判据（列表有行）无法满足
      'alpha@x.com': { items: items.slice(0, 2), total: 2 },
      'beta@x.com': { items: [], total: 0 },
    },
    messages,
  };
}

/**
 * T4d 固定装置：`/api/mailboxes` 返回**空数组**（服务端账号被清空）。
 * snapshotMailboxes 控制 localStorage 快照里的账号列表：
 *   - 子情形 B：快照含账号列表（下拉先被填充过 option）→ snapshotMailboxes = [beta]
 *   - 子情形 C：快照 mailboxes 为空（下拉从未被填充）  → snapshotMailboxes = []
 * 两种情形下 state.mailbox 都是 'beta@x.com'，列表请求都必须带 mailbox=beta。
 */
function emptyMailboxesFixture(snapshotMailboxes) {
  const items = [];
  for (let i = 0; i < 5; i++) items.push(msg('E' + i, i === 0 ? 0 : 1, { mailbox: 'beta@x.com' }));
  const messages = {};
  for (const it of items) messages[it.id] = detail(it, it.read);
  const counts = { inbox_unread: 1, inbox_total: 5, sent_total: 0, starred_total: 0, trash_total: 0 };
  return {
    mailboxes: [], // ← 服务端账号列表为空
    counts,
    seedCache: {
      v: 1,
      at: Date.now(),
      folderKey: 'beta@x.com|inbox|',
      mailbox: 'beta@x.com',
      folderName: 'inbox',
      q: '',
      folder: { items, total: 5 },
      counts,
      mailboxes: snapshotMailboxes,
      openId: null,
    },
    // 「全部邮箱」视图刻意也给出行（否则一旦实现把 mailbox 丢掉，列表会空、用例只会在 boot 超时，
    // 报不出「请求缺 mailbox」这个真正的原因）
    foldersByMailbox: { 'beta@x.com': { items, total: 5 }, '': { items: items.slice(0, 2), total: 2 } },
    messages,
  };
}

/* ---------------------------------------------------------------------------
 * 启动一个「已跑完 init()」的应用实例
 * -------------------------------------------------------------------------*/

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }
const sleep = (ctx, ms) => new Promise((r) => ctx.win.setTimeout(r, ms));

async function boot(cfg = {}) {
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  // jsdom 默认 document.hidden === true（visibilityState='prerender'），
  // 会让 periodicSync() 在 `if (document.hidden) return;` 处直接返回、一个请求都不发。
  // 真实浏览器里可见标签页是 visible，这里显式对齐，否则定时同步路径在 jsdom 中不可测。
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  // seedCache：在注入 app.js **之前**写入 localStorage 快照（BUG-5 的「上次会话残留」场景）
  if (cfg.seedCache !== undefined) {
    const raw = typeof cfg.seedCache === 'string' ? cfg.seedCache : JSON.stringify(cfg.seedCache);
    win.localStorage.setItem('inbox-cache-v1', raw);
  }
  const stub = makeStub(cfg);
  win.fetch = stub.fetchImpl; // 必须在注入 app.js 之前

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  // 就绪判据：renderNav 已渲染 4 个文件夹 + loadFolder 已渲染出列表行 + maybeAutoOpen 已打开首封。
  // 这三件事都发生在 setupEvents() 之后，因此等价于「事件已接线、init 已跑完」。
  let ready = false;
  for (let i = 0; i < 600; i++) {
    const nav = win.document.querySelector('#folder-nav');
    const list = win.document.querySelector('#list');
    let openId = null;
    try { openId = win.eval('typeof state === "object" ? state.openId : null'); } catch { /* 脚本未就绪 */ }
    if (nav && nav.children.length === 4 && list && list.children.length > 0 && openId) { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 10);

  return { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
}

/* ---------------------------------------------------------------------------
 * DOM / 事件辅助
 * -------------------------------------------------------------------------*/

const evalIn = (ctx, expr) => ctx.win.eval(expr);
const el = (ctx, sel) => ctx.doc.querySelector(sel);
const rowFor = (ctx, id) => ctx.doc.querySelector(`.list-item[data-id="${id}"]`);
const activeRows = (ctx) => ctx.doc.querySelectorAll('.list-item.active');
const hidden = (ctx, sel) => el(ctx, sel).classList.contains('hidden');

function clickEl(ctx, node) {
  node.dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function clickRow(ctx, id) {
  const r = rowFor(ctx, id);
  if (!r) throw new Error(`找不到列表行: ${id}`);
  clickEl(ctx, r);
}
function setCheckbox(ctx, sel, checked) {
  const n = el(ctx, sel);
  n.checked = checked;
  n.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
}
function setSearch(ctx, value) {
  const n = el(ctx, '#search-input');
  n.value = value;
  n.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
}
/** 用真实用户动作把列表恢复成「无选中、无打开」的干净状态。 */
async function resetList(ctx) {
  evalIn(ctx, "openFolder('inbox')");
  await ticks(ctx.win, 6);
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

async function test(name, fn, cfg) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot(cfg || inboxFixture());
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    if (ctx) ctx.close();
  }
}

/* ---------------------------------------------------------------------------
 * BUG-4 / BUG-5 专用辅助
 * -------------------------------------------------------------------------*/

/** 从 fetch 记录的 URL 里取某个查询参数（用于断言请求真的带了 offset / mailbox）。 */
function queryParam(url, key) {
  const qs = new URLSearchParams(String(url).split('?')[1] || '');
  return qs.get(key);
}
const folderCalls = (ctx) => ctx.stub.calls.filter((c) => /^\/api\/folders\//.test(c.url));
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* ===========================================================================
 * 用例
 * ===========================================================================*/

(async function main() {
  console.log('收件箱 UI 三类缺陷 —— 独立 jsdom 回归验证');
  console.log(`被测版本: app.js md5=${FINGERPRINT.md5}  mtime=${FINGERPRINT.mtime}  bytes=${FINGERPRINT.bytes}`);

  /* ---- T0 环境自检：保证断言不是「空转蒙对」 ---- */
  await test('T0 测试环境自检（harness 可信度）', async (ctx) => {
    ok(typeof ctx.win.openMessage === 'function', 'app.js 已注入且 openMessage 为全局函数');
    ok(typeof ctx.win.openFolder === 'function', 'openFolder 为全局函数');
    ok(typeof ctx.win.loadMailboxes === 'function', 'loadMailboxes 为全局函数');
    ok(el(ctx, '#folder-nav').children.length === 4, 'renderNav 已执行（4 个文件夹）', el(ctx, '#folder-nav').children.length);
    ok(ctx.stub.counters.account >= 1, '/api/account 被请求（fetch 打桩生效）', ctx.stub.counters.account);
    ok(ctx.stub.counters.folders >= 1, '/api/folders/* 被请求（列表数据来自打桩）', ctx.stub.counters.folders);
    ok(evalIn(ctx, 'state.items.length') === 3, '列表渲染出 3 行', evalIn(ctx, 'state.items.length'));
    ok(!!rowFor(ctx, 'A') && !!rowFor(ctx, 'B'), 'A / B 两行都存在于 DOM');
    ok(!!rowFor(ctx, 'A') && rowFor(ctx, 'A').classList.contains('unread'), 'A 行初始为未读（.unread 存在）');
    ok(!!rowFor(ctx, 'B') && !rowFor(ctx, 'B').classList.contains('unread'), 'B 行初始为已读（无 .unread）');
    // 证明 #select-all 的 change 监听确实已接线（否则后续断言会空转）
    setCheckbox(ctx, '#select-all', true);
    ok(evalIn(ctx, 'state.selected.size') === 3, '勾选 #select-all 后 state.selected.size=3（事件已接线）', evalIn(ctx, 'state.selected.size'));
    ok(!hidden(ctx, '#list-bulk'), '勾选后批量操作条可见');
  });

  /* ---- BUG-1 行选中高亮残留 ---- */
  await test('T1 BUG-1 连续打开两封邮件后只能有 1 个 active 行', async (ctx) => {
    await resetList(ctx);
    ok(activeRows(ctx).length === 0, '负控制基线：重置后没有任何 active 行', activeRows(ctx).length);

    clickRow(ctx, 'A');
    await ticks(ctx.win, 8);
    const afterA = activeRows(ctx).length;
    ok(afterA === 1, '负控制：只打开 A 时 active 数量为 1（不是 0）', afterA);
    ok(afterA === 1 && activeRows(ctx)[0].dataset.id === 'A', 'active 行是 A');

    clickRow(ctx, 'B');
    await ticks(ctx.win, 8);
    const afterB = activeRows(ctx).length;
    ok(afterB === 1, '打开第二封 B 后 active 数量恒为 1（BUG-1 核心）', afterB);
    ok(afterB === 1 && activeRows(ctx)[0].dataset.id === 'B', '唯一的 active 行是 B（A 的残留已清除）',
      afterB === 1 ? activeRows(ctx)[0].dataset.id : Array.from(activeRows(ctx)).map((r) => r.dataset.id).join(','));

    evalIn(ctx, 'closeMessagePane()');
    ok(activeRows(ctx).length === 0, 'closeMessagePane() 之后 active 数量为 0', activeRows(ctx).length);
  });

  /* ---- BUG-1b 「全选本页」复选框状态残留 ---- */
  await test('T1b-1 BUG-1b 切文件夹后 #select-all 必须复位', async (ctx) => {
    await resetList(ctx);
    setCheckbox(ctx, '#select-all', true);
    ok(el(ctx, '#select-all').checked === true, '勾选后 #select-all.checked=true');
    ok(!hidden(ctx, '#list-bulk'), '勾选后批量条可见');

    await ticks(ctx.win, 3);
    ok(el(ctx, '#select-all').checked === true && !hidden(ctx, '#list-bulk'),
      '负控制：勾选后不做任何操作，状态保持不变（功能没被改没）');

    evalIn(ctx, "openFolder('sent')");
    await ticks(ctx.win, 8);
    ok(evalIn(ctx, 'state.selected.size') === 0, '切文件夹后 state.selected 已清空', evalIn(ctx, 'state.selected.size'));
    ok(el(ctx, '#select-all').checked === false, '切文件夹后 #select-all.checked 复位为 false（BUG-1b 核心）',
      el(ctx, '#select-all').checked);
    ok(hidden(ctx, '#list-bulk'), '切文件夹后批量条隐藏');
  });

  await test('T1b-2 BUG-1b 改搜索词后 #select-all 必须复位', async (ctx) => {
    await resetList(ctx);
    setCheckbox(ctx, '#select-all', true);
    ok(el(ctx, '#select-all').checked === true, '勾选后 #select-all.checked=true');

    setSearch(ctx, 'A');
    await sleep(ctx, 700); // setupSearch 的 400ms 防抖
    await ticks(ctx.win, 8);
    ok(evalIn(ctx, 'state.selected.size') === 0, '搜索后 state.selected 已清空', evalIn(ctx, 'state.selected.size'));
    ok(el(ctx, '#select-all').checked === false, '搜索后 #select-all.checked 复位为 false（BUG-1b）',
      el(ctx, '#select-all').checked);
    ok(hidden(ctx, '#list-bulk'), '搜索后批量条隐藏');
  });

  await test('T1b-3 BUG-1b 完成一次批量操作后 #select-all 必须复位', async (ctx) => {
    await resetList(ctx);
    setCheckbox(ctx, '#select-all', true);
    ok(evalIn(ctx, 'state.selected.size') === 3, '勾选后选中 3 封', evalIn(ctx, 'state.selected.size'));

    const btn = Array.from(el(ctx, '#bulk-actions').querySelectorAll('button')).find((b) => b.textContent === '已读');
    ok(!!btn, '批量条上有「已读」按钮');
    clickEl(ctx, btn);
    await ticks(ctx.win, 10);
    ok(ctx.stub.counters.batch === 1, '批量接口被调用一次', ctx.stub.counters.batch);
    ok(evalIn(ctx, 'state.selected.size') === 0, '批量操作后 state.selected 已清空', evalIn(ctx, 'state.selected.size'));
    ok(el(ctx, '#select-all').checked === false, '批量操作后 #select-all.checked 复位为 false（BUG-1b）',
      el(ctx, '#select-all').checked);
    ok(hidden(ctx, '#list-bulk'), '批量操作后批量条隐藏');
  });

  await test('T1b-4 BUG-1b 切换账号后 #select-all 必须复位', async (ctx) => {
    await resetList(ctx);
    setCheckbox(ctx, '#select-all', true);
    ok(el(ctx, '#select-all').checked === true, '勾选后 #select-all.checked=true');

    const sel = el(ctx, '#mailbox-select');
    sel.value = 'beta@x.com';
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    await ticks(ctx.win, 10);
    ok(evalIn(ctx, 'state.selected.size') === 0, '切账号后 state.selected 已清空', evalIn(ctx, 'state.selected.size'));
    ok(el(ctx, '#select-all').checked === false, '切账号后 #select-all.checked 复位为 false（BUG-1b）',
      el(ctx, '#select-all').checked);
    ok(hidden(ctx, '#list-bulk'), '切账号后批量条隐藏');
  });

  /* ---- BUG-2 读过之后列表行仍显示未读 ---- */
  await test('T2 BUG-2 打开未读邮件后行内 .unread 必须消失且本地状态回写', async (ctx) => {
    await resetList(ctx);
    ok(rowFor(ctx, 'A').classList.contains('unread'), '前置：A 行未读');
    ctx.stub.counters.counts = 0;

    clickRow(ctx, 'A');
    await ticks(ctx.win, 10);

    ok(!rowFor(ctx, 'A').classList.contains('unread'), '打开后 A 行 .unread 已移除（BUG-2 核心）',
      rowFor(ctx, 'A').className);
    ok(evalIn(ctx, "state.items.find((x) => x.id === 'A').read") === 1,
      'state.items 中 A.read 已更新为 1', evalIn(ctx, "state.items.find((x) => x.id === 'A').read"));
    ok(evalIn(ctx, "[...state.cache.folders.values()].some((c) => c.items.some((i) => i.id === 'A' && i.read === 1))") === true,
      '文件夹缓存中 A.read 已更新为 1');
    ok(evalIn(ctx, "state.cache.messages.get('A') && state.cache.messages.get('A').message.read === 1") === true,
      '消息缓存中 A.read 为 1');
    ok(ctx.stub.counters.counts === 1, '发生 0→1 跃迁时恰好请求一次 /api/counts', ctx.stub.counters.counts);
  });

  await test('T2b BUG-2 负控制：本来就是已读的邮件不得额外请求 /api/counts', async (ctx) => {
    await resetList(ctx);
    ok(!rowFor(ctx, 'B').classList.contains('unread'), '前置：B 行已读');
    ctx.stub.counters.counts = 0;
    ctx.stub.counters.mailboxes = 0;

    clickRow(ctx, 'B');
    await ticks(ctx.win, 10);

    ok(ctx.stub.counters.counts === 0, '无 0→1 跃迁时不得请求 /api/counts（防止「无条件刷新」蒙对）',
      ctx.stub.counters.counts);
    ok(ctx.stub.counters.mailboxes === 0, '无 0→1 跃迁时不得请求 /api/mailboxes', ctx.stub.counters.mailboxes);
    ok(!rowFor(ctx, 'B').classList.contains('unread'), 'B 行保持已读');
  });

  await test('T2c BUG-2 命中消息缓存提前 return 分支时行状态依然正确', async (ctx) => {
    await resetList(ctx);
    clickRow(ctx, 'A');
    await ticks(ctx.win, 10);
    ok(evalIn(ctx, "state.cache.messages.has('A')") === true, '前置：A 已进入消息缓存');

    // 制造「缓存已是已读、但列表行仍显示未读」的状态，逼 openMessage 走提前 return 分支
    evalIn(ctx, "state.items.find((x) => x.id === 'A').read = 0");
    rowFor(ctx, 'A').classList.add('unread');
    ok(rowFor(ctx, 'A').classList.contains('unread'), '前置：已把 A 行改回未读外观');
    const detailBefore = ctx.stub.counters.detail;

    clickRow(ctx, 'A');
    await ticks(ctx.win, 10);
    info(`提前 return 分支是否复用缓存（详情请求增量=${ctx.stub.counters.detail - detailBefore}）`);
    ok(!rowFor(ctx, 'A').classList.contains('unread'), '缓存分支下打开后 A 行 .unread 仍被清除');
    ok(evalIn(ctx, "state.items.find((x) => x.id === 'A').read") === 1, '缓存分支下 state.items 中 A.read 仍为 1',
      evalIn(ctx, "state.items.find((x) => x.id === 'A').read"));
  });

  /* ---- BUG-3a 账号下拉被静默改写 ---- */
  await test('T3 BUG-3a 「全部邮箱」不得被静默改写，state.mailbox 与 sel.value 恒一致', async (ctx) => {
    const sel = el(ctx, '#mailbox-select');
    ok(evalIn(ctx, 'state.mailbox') === sel.value, '初始：state.mailbox === sel.value',
      `${evalIn(ctx, 'state.mailbox')} / ${sel.value}`);

    sel.value = '';
    sel.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    await ticks(ctx.win, 8);
    ok(sel.value === '', '把下拉切到「全部邮箱」后 sel.value 为 ""', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === '', '此时 state.mailbox 为 ""', JSON.stringify(evalIn(ctx, 'state.mailbox')));

    evalIn(ctx, 'loadMailboxes(true)');
    await ticks(ctx.win, 8);
    ok(sel.value === '', '再次 loadMailboxes() 后 sel.value 仍为 ""（BUG-3a 核心）', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === sel.value, '不变量：state.mailbox === sel.value',
      `${evalIn(ctx, 'state.mailbox')} / ${sel.value}`);

    evalIn(ctx, 'renderMailboxSelect()');
    ok(sel.value === '', '直接 renderMailboxSelect() 后仍为「全部邮箱」', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === '', 'state.mailbox 仍为 ""');
  });

  await test('T3b BUG-3a 账号已不存在时回退，state.mailbox 与 sel.value 仍必须一致', async (ctx) => {
    const sel = el(ctx, '#mailbox-select');
    // 场景一：用户选中 alpha@x.com（真实路径：change 监听会把 state.mailbox 同步成 alpha），
    //         随后该账号从账号列表中消失 → 必须回退到仍然存在的账号。
    //         注意：真值来源是 state.mailbox（app.js 已注明）；只改 sel.value 不改 state.mailbox
    //         不构成「用户选了 alpha」，因此这里必须两者同时设置，否则测的是假场景。
    sel.value = 'alpha@x.com';
    evalIn(ctx, "state.mailbox = 'alpha@x.com'");
    evalIn(ctx, "state.mailboxList = state.mailboxList.filter((m) => m.mailbox !== 'alpha@x.com')");
    evalIn(ctx, 'renderMailboxSelect()');
    const v1 = sel.value;
    const m1 = evalIn(ctx, 'state.mailbox');
    ok(v1 !== '' && v1 !== 'alpha@x.com', '场景一：回退到某个仍然存在的账号', JSON.stringify(v1));
    ok(m1 === v1, '场景一：回退后 state.mailbox === sel.value（不脱钩）', `${JSON.stringify(m1)} / ${JSON.stringify(v1)}`);

    // 场景一附注：仅改 sel.value（不同步 state.mailbox）时，真值来源仍是 state.mailbox，
    // 因此不会触发回退。这是当前实现的既定契约，显式记录以免将来误判为回归。
    evalIn(ctx, "state.mailbox = ''");
    sel.value = 'alpha@x.com';
    evalIn(ctx, 'renderMailboxSelect()');
    ok(sel.value === '' && evalIn(ctx, 'state.mailbox') === '',
      '场景一附注：只改 sel.value 不构成用户选择，state.mailbox 仍是真值来源（不变量依然成立）',
      `${JSON.stringify(sel.value)} / ${JSON.stringify(evalIn(ctx, 'state.mailbox'))}`);

    // 场景二：state.mailbox 指向已不存在的账号，下拉显示仍是有效账号
    evalIn(ctx, "state.mailbox = 'ghost@x.com'");
    evalIn(ctx, 'renderMailboxSelect()');
    const v2 = sel.value;
    const m2 = evalIn(ctx, 'state.mailbox');
    ok(m2 === v2, '场景二：renderMailboxSelect() 后 state.mailbox === sel.value', `${JSON.stringify(m2)} / ${JSON.stringify(v2)}`);
    ok(v2 !== 'ghost@x.com', '场景二：下拉不会停留在不存在的账号上', JSON.stringify(v2));
  });

  /* ---- BUG-3c 账号未读数陈旧 ---- */
  await test('T3c BUG-3c 读信发生 0→1 跃迁后必须重新请求 /api/mailboxes', async (ctx) => {
    await resetList(ctx);
    ctx.stub.counters.mailboxes = 0;
    clickRow(ctx, 'A');
    await ticks(ctx.win, 10);
    ok(ctx.stub.counters.mailboxes >= 1, '读信跃迁后 /api/mailboxes 被重新请求（BUG-3c）', ctx.stub.counters.mailboxes);
  });

  /* ---- BUG-3d 口径未标注 ---- */
  await test('T3d BUG-3d 下拉项与列表标题的数字口径必须自解释', async (ctx) => {
    const opts = Array.from(el(ctx, '#mailbox-select').options);
    info(`下拉项文案: ${opts.map((o) => `${JSON.stringify(o.value)}=>${JSON.stringify(o.textContent)}`).join(' , ')}`);
    const numbered = opts.filter((o) => o.value !== '' && /\d/.test(o.textContent));
    ok(numbered.length >= 1, '前置：存在显示未读数的下拉项', numbered.map((o) => o.textContent).join(' | '));
    for (const o of numbered) {
      ok(o.textContent.includes('未读'), `下拉项「${o.textContent}」用「未读」标注数字含义`);
    }
    const title = el(ctx, '#list-title').textContent;
    info(`列表标题: ${JSON.stringify(title)}`);
    ok(/共\s*\d+\s*封/.test(title), '列表标题明确标注总数口径（形如「共 N 封」，非裸数字）', JSON.stringify(title));
  });

  /* ===========================================================================
   * BUG-4 / BUG-5：本地缓存优先改造引入的两类回归
   * ===========================================================================*/

  /* ---- BUG-4 定时同步把列表清空 ---- */
  await test('T4a BUG-4 定时同步必须请求第 1 页、且不得把列表清空', async (ctx) => {
    const win = ctx.win;
    ok(el(ctx, '#list').children.length === 50, '前置：列表渲染 50 行', el(ctx, '#list').children.length);
    ok(evalIn(ctx, 'state.offset') === 50, '前置：state.offset=50（第 1 页已满）', evalIn(ctx, 'state.offset'));

    // 负控制 1：断言工具本身可用（否则「不含 offset=50」可能只是解析失败）
    ok(queryParam('/api/folders/inbox?limit=50&offset=50', 'offset') === '50',
      '负控制：offset 解析工具可用（非空转）', queryParam('/api/folders/inbox?limit=50&offset=50', 'offset'));

    // 负控制 2：total=50 时第 2 页确实为空 —— 旧实现请求 offset=50 拿到的就是空页
    const page2 = await evalIn(ctx, 'fetchFolderPage(50)');
    ok(page2.items.length === 0, '前提：total=50 时第 2 页为空（旧实现 offset=50 会拿到空页）', page2.items.length);

    // 负控制 3：空页被整体覆盖进 state.items 时，列表确实会变成 0 行（证明下面断言能观察到缺陷）
    evalIn(ctx, 'state.items = []; state.offset = 0; paintList();');
    ok(el(ctx, '#list').children.length === 0, '负控制：空页整体覆盖后列表确实变 0 行', el(ctx, '#list').children.length);
    evalIn(ctx, "openFolder('inbox')");
    await ticks(win, 12);
    ok(el(ctx, '#list').children.length === 50, '前置恢复：重新加载后回到 50 行', el(ctx, '#list').children.length);

    // periodicSync 只在非阅读态刷新列表，且只在文件夹缓存超过 TTL.folder(45s) 时才刷新
    // （60s 定时同步的真实场景：上次刷新早已过期）。把缓存时间戳做旧以触发刷新路径。
    evalIn(ctx, 'closeMessagePane()');
    evalIn(ctx, 'state.cache.folders.forEach((c) => { c.at = Date.now() - 120000; })');
    await ticks(win, 3);
    const before = ctx.stub.calls.length;
    evalIn(ctx, 'periodicSync()');
    await ticks(win, 20);

    const reqs = ctx.stub.calls.slice(before).filter((c) => /^\/api\/folders\//.test(c.url));
    info(`periodicSync 发出的列表请求: ${reqs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(reqs.length >= 1, 'periodicSync 确实发出了列表请求（否则后面断言会空转）', reqs.length);
    for (const c of reqs) {
      ok(queryParam(c.url, 'offset') === '0', `列表请求必须带 offset=0（实际 ${c.url}）`, queryParam(c.url, 'offset'));
    }
    ok(!reqs.some((c) => queryParam(c.url, 'offset') === '50'), '任何列表请求都不得带 offset=50（BUG-4 根因）');
    ok(el(ctx, '#list').children.length === 50,
      'BUG-4 核心：periodicSync 后列表不得被清空（仍为 50 行）', el(ctx, '#list').children.length);
    ok(evalIn(ctx, 'state.items.length') === 50, 'state.items 仍为 50 条', evalIn(ctx, 'state.items.length'));
    ok(evalIn(ctx, 'state.offset') === 50, 'state.offset 重新落在 50', evalIn(ctx, 'state.offset'));
  }, pagingFixture());

  /* ---- BUG-5 恢复路径下具体账号选择被静默重置 ---- */
  await test('T4b BUG-5 恢复路径下具体账号选择不得被静默重置', async (ctx) => {
    const sel = el(ctx, '#mailbox-select');
    info(`恢复后 下拉值=${JSON.stringify(sel.value)}  state.mailbox=${JSON.stringify(evalIn(ctx, 'state.mailbox'))}  行数=${el(ctx, '#list').children.length}`);
    ok(sel.value === 'beta@x.com', '下拉 value 必须恢复为快照里的 beta@x.com', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === 'beta@x.com', 'state.mailbox 必须是 beta@x.com', JSON.stringify(evalIn(ctx, 'state.mailbox')));
    ok(evalIn(ctx, 'state.mailbox') === sel.value, '核心不变量：state.mailbox === sel.value');
    ok(el(ctx, '#list').children.length === 7,
      '列表行数必须保持缓存里的 7 行（不得清空，也不得换成「全部邮箱」视图的 3 行）', el(ctx, '#list').children.length);

    const fcs = folderCalls(ctx);
    info(`列表请求: ${fcs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(fcs.length >= 1, '存在列表请求（否则下面的断言会空转）', fcs.length);
    ok(fcs.some((c) => String(c.url).includes('mailbox=beta%40x.com')),
      '至少一个列表请求的原始 URL 含 mailbox=beta%40x.com',
      fcs.map((c) => c.url).join(' , '));
    ok(fcs.every((c) => queryParam(c.url, 'mailbox') === 'beta@x.com'),
      '不得发出不带 mailbox 的列表请求（那会静默退化成「全部邮箱」）',
      fcs.map((c) => queryParam(c.url, 'mailbox')).join(','));
    ok(queryParam(fcs[0].url, 'mailbox') === 'beta@x.com',
      '第一个列表请求就带 beta（缓存优先，不等网络）', fcs[0].url);
  }, seededBetaFixture());

  await test('T4c BUG-5 负控制：快照账号已不存在时回退，且 state.mailbox 与 sel.value 恒相等', async (ctx) => {
    const sel = el(ctx, '#mailbox-select');
    const values = Array.from(sel.options).map((o) => o.value);
    info(`下拉选项=${JSON.stringify(values)}  当前值=${JSON.stringify(sel.value)}  state.mailbox=${JSON.stringify(evalIn(ctx, 'state.mailbox'))}`);
    ok(!values.includes('ghost@x.com'), '前置：下拉里已没有 ghost@x.com（账号已失效）');
    ok(sel.value !== 'ghost@x.com', '不得停留在已不存在的账号上', JSON.stringify(sel.value));
    ok(sel.value !== '', '回退到某个具体账号，而不是静默变成「全部邮箱」', JSON.stringify(sel.value));
    ok(values.includes(sel.value), '回退目标必须是下拉里真实存在的账号', JSON.stringify(sel.value));
    ok(evalIn(ctx, 'state.mailbox') === sel.value,
      '核心不变量：state.mailbox === sel.value（二者永不脱钩）',
      `${JSON.stringify(evalIn(ctx, 'state.mailbox'))} / ${JSON.stringify(sel.value)}`);
    ok(evalIn(ctx, 'state.mailbox') === 'alpha@x.com', '回退优先选「有未读的账号」', JSON.stringify(evalIn(ctx, 'state.mailbox')));
  }, seededGhostFixture());

  /* ---- T4d 边界：账号列表为空（/api/mailboxes → []）时下拉隐藏，state.mailbox 仍是唯一权威 ----
   * 机制（app.js:362-375）：`if (list.length < 1) { wrap.classList.add('hidden'); return; }` 提前返回，
   * 而 `sel.innerHTML = ''` 在它**之后**。`.hidden` 只是 display:none !important（app.css:36），
   * 不重置 value/selectedIndex ⇒ 空列表时旧 option 会残留。
   * 因此**不得**断言 `sel.options.length === 0`（B 下是 2、C 下是 0，这不是契约），
   * 也**不得**用 DOM 显示值断言权威性；权威性一律用「列表请求是否带 mailbox 参数」来断言。
   */
  await test('T4d-B 账号列表被服务端清空后：下拉隐藏，但 state.mailbox 仍驱动请求', async (ctx) => {
    const wrap = el(ctx, '#mailbox-wrap');
    const sel = el(ctx, '#mailbox-select');
    ok(wrap.classList.contains('hidden'), '账号列表为空 ⇒ 下拉被隐藏');
    ok(evalIn(ctx, 'state.mailboxList.length') === 0, 'state.mailboxList 已为空', evalIn(ctx, 'state.mailboxList.length'));
    ok(evalIn(ctx, 'state.mailbox') === 'beta@x.com', 'state.mailbox 仍保留快照账号（未被清空）',
      JSON.stringify(evalIn(ctx, 'state.mailbox')));
    info(`记录（不作为契约）：sel.value=${JSON.stringify(sel.value)}  sel.options.length=${sel.options.length}  wrap.hidden=true`);

    // 权威性：请求必须带 mailbox
    const fcs = folderCalls(ctx);
    info(`列表请求: ${fcs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(fcs.length >= 1, '存在列表请求（否则后面的断言会空转）', fcs.length);
    ok(fcs.every((c) => queryParam(c.url, 'mailbox') === 'beta@x.com'),
      '所有列表请求都带 mailbox=beta@x.com（权威来源是 state.mailbox）',
      fcs.map((c) => c.url).join(' , '));

    // 负控制：把 DOM 值清掉（模拟「顺手 sel.innerHTML = ''」的倒退改动）不得影响行为
    sel.value = '';
    const before = ctx.stub.calls.length;
    evalIn(ctx, "openFolder('inbox')");
    await ticks(ctx.win, 12);
    const reqs = ctx.stub.calls.slice(before).filter((c) => /^\/api\/folders\//.test(c.url));
    info(`负控制（只清 DOM 值）后的列表请求: ${reqs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(reqs.length >= 1, '负控制下仍有列表请求（非空转）', reqs.length);
    ok(reqs.every((c) => queryParam(c.url, 'mailbox') === 'beta@x.com'),
      '负控制：只改 sel.value 不改 state.mailbox ⇒ 请求仍带 mailbox=beta（DOM 不是真值来源）',
      reqs.map((c) => queryParam(c.url, 'mailbox')).join(','));

    // 负控制：断言工具本身能观察到「缺参数」
    ok(queryParam('/api/folders/inbox?limit=50&offset=0', 'mailbox') === null,
      '负控制：不带 mailbox 的 URL 解析为 null（断言确实能观察到缺失）');
  }, emptyMailboxesFixture([{ mailbox: 'beta@x.com', inbox_unread: 1, inbox_total: 5, sent_total: 0 }]));

  await test('T4d-C 快照 mailboxes 为空：下拉从未填充，state.mailbox 仍是唯一权威', async (ctx) => {
    const wrap = el(ctx, '#mailbox-wrap');
    const sel = el(ctx, '#mailbox-select');
    ok(wrap.classList.contains('hidden'), '账号列表为空 ⇒ 下拉被隐藏');
    ok(evalIn(ctx, 'state.mailboxList.length') === 0, 'state.mailboxList 已为空');
    ok(evalIn(ctx, 'state.mailbox') === 'beta@x.com', 'state.mailbox 仍为 beta@x.com', JSON.stringify(evalIn(ctx, 'state.mailbox')));
    info(`记录（不作为契约）：sel.value=${JSON.stringify(sel.value)}  sel.options.length=${sel.options.length}`);
    info('本子情形下 state.mailbox 与 sel.value 不相等，这是允许的：下拉隐藏时 state.mailbox 才是权威。');

    const fcs = folderCalls(ctx);
    info(`列表请求: ${fcs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(fcs.length >= 1, '存在列表请求（否则断言会空转）', fcs.length);
    ok(fcs.every((c) => queryParam(c.url, 'mailbox') === 'beta@x.com'),
      '即使下拉隐藏，列表请求仍带 mailbox=beta@x.com',
      fcs.map((c) => c.url).join(' , '));

    // 负控制：若真值来源错用 sel.value（此处为 ''），请求就会丢掉 mailbox —— 证明断言能区分两种真值来源
    const before = ctx.stub.calls.length;
    evalIn(ctx, "state.mailbox = document.querySelector('#mailbox-select').value"); // 模拟「以 DOM 显示值为真值」的倒退实现
    evalIn(ctx, "openFolder('inbox')");
    await ticks(ctx.win, 12);
    const reqs = ctx.stub.calls.slice(before).filter((c) => /^\/api\/folders\//.test(c.url));
    info(`负控制（以 sel.value 为真值）后的列表请求: ${reqs.map((c) => c.url).join(' , ') || '（无）'}`);
    ok(reqs.length >= 1, '负控制下仍有列表请求（非空转）', reqs.length);
    ok(reqs.every((c) => queryParam(c.url, 'mailbox') === null),
      '负控制：以 sel.value（\'\'）为真值 ⇒ 请求丢掉 mailbox 参数（断言确实能观察到差异）',
      reqs.map((c) => c.url).join(' , '));
  }, emptyMailboxesFixture([]));

  /* ---- 汇总 ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: app.js md5=${FINGERPRINT.md5}  mtime=${FINGERPRINT.mtime}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);

  const exitCode = fail ? 1 : 0;
  // 把退出码写进文件，便于独立复核（不只依赖 shell 的 $?）
  const exitFile = path.join(os.tmpdir(), 'qa-inbox-ui.regression.exit');
  try {
    fs.writeFileSync(exitFile, String(exitCode), 'utf8');
    console.log(`退出码已写入: ${exitFile} = ${exitCode}`);
  } catch (e) {
    console.log(`退出码文件写入失败: ${e.message}`);
  }
  process.exit(exitCode);
})();
