'use strict';

/* =============================================================================
 * Multi-domain top-bar switcher -- real jsdom + full index.html + full app.js
 *
 * Run:
 *   NODE_PATH=<NODE_PATH> <node.exe> test/multidomain.dom.test.js
 *
 * Exit code: 0 = all passed; 1 = some failed.
 *
 * Covers:
 *   1) The domain strip is rendered from GET /api/account.domains (and hidden when a single domain is configured);
 *   2) Clicking a domain filters the whole view: the folder list, counts and mailbox list are all re-fetched with ?domain=…,
 *      and the selected chip becomes active;
 *   3) Negative control: the strip is hidden when only one domain exists.
 *
 * This file does not modify any source under public/ and src/.
 * ===========================================================================*/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const APP_JS_PATH = process.env.QA_APP_JS || path.join(ROOT, 'public', 'app.js');
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');

const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');
const FINGERPRINT = {
  'public/app.js': crypto.createHash('md5').update(APP_JS).digest('hex'),
  'public/index.html': crypto.createHash('md5').update(INDEX_HTML).digest('hex'),
};

/* ------------------------------ fixtures ------------------------------ */

function msg(id, mailbox) {
  return {
    id,
    direction: 'inbound',
    from_name: '发件人' + id,
    from_email: 'sender@x.com',
    subject: '主题 ' + id,
    to_emails: [mailbox],
    received_at: 1700000000 + id.charCodeAt(0),
    read: 0,
    starred: 0,
    status: 'received',
    attachments_count: 0,
    preview: '预览 ' + id,
    mailbox,
  };
}

function detail(m) {
  return {
    message: Object.assign({}, m, { body_text: '正文 ' + m.id, body_html: null, thread_id: 't-' + m.id, cc: [], bcc: [], reply_to: [] }),
    attachments: [],
    thread: [],
  };
}

/** Per-domain data: the stub returns different rows / counts depending on the ?domain= param. */
function domainData() {
  const A = msg('A', 'a@example.com');
  const B = msg('B', 'b@other.com');
  return {
    items: { '': [A], 'example.com': [A], 'other.com': [B] },
    mailboxes: {
      '': [
        { mailbox: 'a@example.com', inbox_unread: 1, inbox_total: 1, sent_total: 0 },
        { mailbox: 'b@other.com', inbox_unread: 1, inbox_total: 1, sent_total: 0 },
      ],
      'example.com': [{ mailbox: 'a@example.com', inbox_unread: 1, inbox_total: 1, sent_total: 0 }],
      'other.com': [{ mailbox: 'b@other.com', inbox_unread: 1, inbox_total: 1, sent_total: 0 }],
    },
    counts: { '': { inbox_unread: 2, inbox_total: 2, sent_total: 0, starred_total: 0, trash_total: 0 } },
    details: { A: detail(A), B: detail(B) },
  };
}

function makeStub(account) {
  const data = domainData();
  const calls = [];
  const jsonRes = (obj, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  });
  const domainOf = (url) => {
    const m = /[?&]domain=([^&]+)/.exec(url);
    return m ? decodeURIComponent(m[1]) : '';
  };

  const fetchImpl = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const method = String((init && init.method) || 'GET').toUpperCase();
    calls.push({ url, method, body: init && init.body });

    if (url.startsWith('/api/account')) return Promise.resolve(jsonRes(account));
    if (url.startsWith('/api/contacts')) return Promise.resolve(jsonRes({ contacts: [] }));
    if (url.startsWith('/api/mailboxes')) {
      const d = domainOf(url);
      return Promise.resolve(jsonRes({ mailboxes: data.mailboxes[d] || [] }));
    }
    if (url.startsWith('/api/counts')) {
      const d = domainOf(url);
      const c = data.counts[d] || { inbox_unread: 1, inbox_total: 1, sent_total: 0, starred_total: 0, trash_total: 0 };
      return Promise.resolve(jsonRes(c));
    }
    const f = /^\/api\/folders\/([^?]+)/.exec(url);
    if (f) {
      const d = domainOf(url);
      const items = data.items[d] || data.items[''] || [];
      return Promise.resolve(jsonRes({ items, total: items.length }));
    }
    const dm = /^\/api\/messages\/([^/?]+)$/.exec(url);
    if (dm && method === 'GET') return Promise.resolve(jsonRes(data.details[dm[1]] || { message: null, attachments: [], thread: [] }));
    if (url.startsWith('/api/messages')) return Promise.resolve(jsonRes({ ok: true, items: [], total: 0 }));
    return Promise.resolve(jsonRes({}));
  };

  return { fetchImpl, calls, data };
}

/* ------------------------------ boot ------------------------------ */

const tick = (win) => new Promise((r) => win.setTimeout(r, 0));
async function ticks(win, n = 1) { for (let i = 0; i < n; i++) await tick(win); }
const liveCtxs = [];

async function boot(cfg = {}) {
  const account = cfg.account || { can_send: true, from_name: 'Me', from_address: 'a@example.com', domain: 'example.com', domains: ['example.com', 'other.com'] };
  const dom = new JSDOM(INDEX_HTML, { runScripts: 'dangerously', url: 'http://localhost/' });
  const win = dom.window;
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(win.document, 'hidden', { value: false, configurable: true });
  Object.defineProperty(win, 'innerWidth', { value: 1024, configurable: true });

  const stub = makeStub(account);
  win.fetch = stub.fetchImpl;

  const script = win.document.createElement('script');
  script.textContent = APP_JS;
  win.document.body.appendChild(script);

  let ready = false;
  for (let i = 0; i < 600; i++) {
    const nav = win.document.querySelector('#folder-nav');
    const list = win.document.querySelector('#list');
    let openId = null;
    let settled = false;
    try {
      openId = win.eval('typeof state === "object" ? state.openId : null');
      settled = !win.eval('detailPending');
    } catch { /* not ready */ }
    if (nav && nav.children.length > 0 && list && list.children.length > 0 && openId && settled) { ready = true; break; }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 5);
  win.eval('prefetchGen++; prefetchActive = null;');

  const ctx = { dom, win, doc: win.document, stub, close() { try { dom.window.close(); } catch { /* ignore */ } } };
  liveCtxs.push(ctx);
  return ctx;
}

/* ------------------------------ helpers ------------------------------ */

const el = (ctx, sel) => ctx.doc.querySelector(sel);
const evalIn = (ctx, expr) => ctx.win.eval(expr);
const domainOfState = (ctx) => evalIn(ctx, 'state.domain');
const chips = (ctx) => Array.from(ctx.doc.querySelectorAll('#domain-bar .domain-chip'));
function clickEl(ctx, node) {
  node.dispatchEvent(new ctx.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}
const callsMatching = (ctx, re) => ctx.stub.calls.filter((c) => re.test(c.url));

/* ------------------------------ runner ------------------------------ */

const results = [];
let currentTest = '(boot)';
let pass = 0;
let fail = 0;

function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}

async function test(name, fn) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  let ctx = null;
  try {
    ctx = await boot();
    await fn(ctx);
  } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  } finally {
    for (const c of liveCtxs) { try { await ticks(c.win, 5); } catch { /* ignore */ } }
    for (const c of liveCtxs.splice(0)) c.close();
  }
}

/* ============================== tests ============================== */
(async () => {
  console.log(`被测版本: app.js md5=${FINGERPRINT['public/app.js']}  index.html md5=${FINGERPRINT['public/index.html']}`);

  await test('D1 顶部域名条：由 /api/account.domains 渲染，默认「全部」', async (ctx) => {
    const bar = el(ctx, '#domain-bar');
    ok(!!bar, '#domain-bar 存在于 DOM');
    ok(!bar.classList.contains('hidden'), '配置了多个域名 -> 域名条可见');
    const labels = chips(ctx).map((c) => c.textContent);
    ok(chips(ctx).length === 3, '共 3 个域名块（全部 + 2 个域名）', JSON.stringify(labels));
    ok(labels[0] === '全部域名' && labels.includes('example.com') && labels.includes('other.com'), '域名块文案正确', JSON.stringify(labels));
    ok(chips(ctx).find((c) => c.textContent === '全部域名').classList.contains('active'), '默认选中「全部域名」');
  });

  await test('D2 点击域名：切换过滤状态并给 folders/counts/mailboxes 带上 domain 参数', async (ctx) => {
    ctx.stub.calls.length = 0;
    const other = chips(ctx).find((c) => c.textContent === 'other.com');
    ok(!!other, '找到 other.com 域名块');
    clickEl(ctx, other);
    await ticks(ctx.win, 5);

    ok(domainOfState(ctx) === 'other.com', 'state.domain 切换为 other.com', domainOfState(ctx));
    ok(chips(ctx).find((c) => c.textContent === 'other.com').classList.contains('active'), 'other.com 块变为 active');
    ok(!chips(ctx).find((c) => c.textContent === '全部域名').classList.contains('active'), '「全部域名」不再 active');

    ok(callsMatching(ctx, /^\/api\/folders\/inbox\?.*domain=other\.com/).length >= 1, '列表请求带 domain=other.com', JSON.stringify(callsMatching(ctx, /folders/).map((c) => c.url)));
    ok(callsMatching(ctx, /^\/api\/counts\?.*domain=other\.com/).length >= 1, '计数请求带 domain=other.com', JSON.stringify(callsMatching(ctx, /counts/).map((c) => c.url)));
    ok(callsMatching(ctx, /^\/api\/mailboxes\?.*domain=other\.com/).length >= 1, '邮箱列表请求带 domain=other.com', JSON.stringify(callsMatching(ctx, /mailboxes/).map((c) => c.url)));

    const rows = Array.from(ctx.doc.querySelectorAll('#list .list-item'));
    ok(rows.length === 1, 'other.com 视图只显示 1 封（B）', `rows=${rows.length}`);
  });

  await test('D3 仅一个域名：域名条仍可见且只显示该域名（无「全部域名」块）', async (ctx) => {
    // Re-boot with a single-domain account.
    for (const c of liveCtxs.splice(0)) c.close();
    const single = await boot({ account: { can_send: true, from_name: 'Me', from_address: 'a@example.com', domain: 'example.com', domains: ['example.com'] } });
    const bar = el(single, '#domain-bar');
    ok(!!bar, '#domain-bar 存在于 DOM');
    ok(!bar.classList.contains('hidden'), '只配置一个域名 -> 域名条仍可见', JSON.stringify(chips(single).map((c) => c.textContent)));
    const labels = chips(single).map((c) => c.textContent);
    ok(labels.length === 1 && labels[0] === 'example.com', '只显示一个域名块且无「全部域名」', JSON.stringify(labels));
    ok(chips(single)[0].classList.contains('active'), '唯一域名块处于选中态');
  });

  console.log(`\n===== 结果: ${pass} passed, ${fail} failed =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试运行异常：', e);
  for (const c of liveCtxs.splice(0)) c.close();
  process.exit(1);
});
