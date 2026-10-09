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
// QA_INDEX_HTML 仅用于「变异验证」：指向一份人工构造的缺陷版 index.html（变体放仓库外）。
// 缺了这个钩子，HTML 变体会「跑仓库原文件却以为跑的是变体」→ 变体恒不被抓（假阴性）。
const INDEX_PATH = process.env.QA_INDEX_HTML || path.join(ROOT, 'public', 'index.html');
const APP_JS = fs.readFileSync(APP_JS_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(INDEX_PATH, 'utf8');

const FINGERPRINT = {
  md5: crypto.createHash('md5').update(APP_JS).digest('hex'),
  mtime: fs.statSync(APP_JS_PATH).mtime.toISOString(),
  bytes: Buffer.byteLength(APP_JS),
};

/**
 * 本地快照的版本号**从 app.js 里现取**，不在这里另写一份。
 *
 * 写死 `v: 1` 的后果：CACHE_VERSION 一旦升版，readPersisted() 会把快照判为过期、
 * 静默走空路径 —— 而 T4b/T4c/T4d 验证的正是「恢复路径」，会变成「快照被拒 → 什么都没恢复」
 * 的失败（或更糟：断言恰好还成立 → 恢复路径根本没被测到）。取现成的值就不会失配。
 * 另在 T0 里断言它确实解析出来了，避免正则失配时静默变成 NaN。
 */
const CACHE_VERSION_IN_APP = Number((/const CACHE_VERSION = (\d+);/.exec(APP_JS) || [])[1]);

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
  // holdDetail：把详情响应挂起，由测试用 releaseDetail() 显式放行（FIFO）。
  // 用于观察「头部已渲染、正文仍在下载」这个中间态，以及验证过期响应不被采用。
  // 可在运行中通过 setHoldDetail() 开关：boot 阶段通常先关掉，点击阶段再打开。
  let holdDetail = !!cfg.holdDetail;
  const heldDetails = [];

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
      if (holdDetail) {
        return new Promise((resolve) => { heldDetails.push({ id, resolve: () => resolve(jsonRes(d)) }); });
      }
      return Promise.resolve(jsonRes(d));
    }
    return Promise.resolve(jsonRes({}));
  };

  return {
    fetchImpl, calls, counters, store,
    /** 放行被 holdDetail 挂起的详情响应。传 id 放行指定那封，不传则放行最早的一封。返回是否放行了。 */
    releaseDetail(id) {
      const idx = id === undefined ? 0 : heldDetails.findIndex((h) => h.id === id);
      if (idx < 0 || idx >= heldDetails.length) return false;
      const [h] = heldDetails.splice(idx, 1);
      h.resolve();
      return true;
    },
    /** 当前被挂起（尚未放行）的详情请求 id 列表，按到达顺序。 */
    heldDetailIds: () => heldDetails.map((h) => h.id),
    /** 运行中开关「挂起详情响应」。 */
    setHoldDetail(v) { holdDetail = !!v; },
  };
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

/**
 * 详情响应：服务端在响应前已把 read 置 1（src/index.ts getMessageDetail 的真实行为）。
 * thread 可选：会话面板用例需要真实会话项，默认空数组（与原行为一致）。
 */
function detail(m, read, thread = []) {
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
    thread,
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

/**
 * 会话面板固定装置：「会话行必须显示收发双方的实际信箱」的回归。
 *
 * ⚠️ 会话项的字段名必须与**真实接口**一致：收件人是 `to`（见 src/index.ts 的 thread.map），
 * 不是 `to_emails`。历史上前端只读 `t.to_emails` → 恒为 undefined → 会话行永远显示「我 → ?」。
 * 这里刻意只提供 `to`，字段名一旦写错用例必然失败（而不是"恰好蒙对"）。
 *
 * ⚠️ 数组顺序必须与**真实接口一致 = 降序（最近在前）**：`repo.listThread()` 的
 * `ORDER BY received_at DESC` 才是排序真值，前端只负责原样渲染。
 * 所以这里的 `threadItems` 按 T3(…300) → T2(…200) → T1(…100) 排列。
 * （后端那侧的排序由 test/inbound-ingest.backend.test.js 的 T12a 守着，本套件守的是渲染顺序。）
 *
 * 列表首项 T3 是**已读**的：init() 的 maybeAutoOpen 会打开它，会话面板（length > 1）随之渲染。
 */
function threadFixture() {
  const threadItems = [
    { // 对方再来信（无名字 → 回退邮箱地址），也是当前打开的一封；时间最新 → 排最前
      id: 'T3', direction: 'inbound', mailbox: 'alpha@x.com',
      from_name: null, from_email: 'bob@partner.com',
      to: ['alpha@x.com'], subject: 'Re: 报价确认',
      preview: '补充', received_at: 1700000300, read: true, deleted: false, current: true,
    },
    { // 我的回信（出站，两个收件人）
      id: 'T2', direction: 'outbound', mailbox: 'support@x.com',
      from_name: 'support', from_email: 'support@x.com',
      to: ['alice@partner.com', 'bob@partner.com'], subject: 'Re: 报价确认',
      preview: '好的', received_at: 1700000200, read: true, deleted: false, current: false,
    },
    { // 最早的来信（有名字）
      id: 'T1', direction: 'inbound', mailbox: 'alpha@x.com',
      from_name: 'Alice', from_email: 'alice@partner.com',
      to: ['alpha@x.com'], subject: '报价确认',
      preview: '见附件', received_at: 1700000100, read: true, deleted: false, current: false,
    },
  ];

  // 列表项走 LIST_SELECT 口径（收件人是 to_emails），与真实列表接口一致。
  const T3 = msg('T3', 1, {
    from_name: null, from_email: 'bob@partner.com', subject: 'Re: 报价确认', mailbox: 'alpha@x.com',
  });
  const T2 = msg('T2', 1, {
    direction: 'outbound', from_name: 'support', from_email: 'support@x.com',
    to_emails: ['alice@partner.com', 'bob@partner.com'], subject: 'Re: 报价确认',
    mailbox: 'support@x.com', status: 'sent',
  });
  // T4 排在 T3 之后 → 不会被 maybeAutoOpen 打开，用来验证「详情未返回时的乐观渲染」。
  const T4 = msg('T4', 1, {
    from_name: 'Carol', from_email: 'carol@partner.com', subject: '另一封信', mailbox: 'beta@x.com',
  });

  return {
    mailboxes: [
      { mailbox: 'alpha@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
      { mailbox: 'beta@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
      { mailbox: 'support@x.com', inbox_unread: 0, inbox_total: 0, sent_total: 1 },
    ],
    folders: {
      inbox: { items: [T3, T4], total: 2 },
      sent: { items: [T2], total: 1 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages: {
      T3: detail(T3, 1, threadItems),
      T2: detail(T2, 1, threadItems),
      T4: detail(T4, 1, []),
    },
    counts: { inbox_unread: 0, inbox_total: 2, sent_total: 1, starred_total: 0, trash_total: 0 },
  };
}

/**
 * 会话副本固定装置：模拟线上真实场景（2026-10-08 生产数据）——
 * 我用 bingfeng@ 发信并**抄送 zhanglili@**，同一封邮件被 Resend 投递回本账号的
 * zhanglili@，于是库里既有出站副本（T2）又有入站副本（T2c）。
 * 服务端 `listThread` 已把入站副本折叠掉：thread 里**没有 T2c**，只有 T2 带 `copy_ids:['T2c']`。
 *
 * 本用例把用户打开的邮件设成**被折叠的那份副本** T2c（放进 zhanglili@ 的收件箱并置于列表首位，
 * 让 maybeAutoOpen 打开它），验证会话面板仍把 T2 标成当前行 ——
 * 否则面板里一行都不高亮，看起来像「我打开的那封不见了」。
 */
function threadCopyFixture() {
  // 时间降序：T3(…300) → T2(…200)；T2c 与 T2 只差 2 秒，是同一封物理邮件
  const T3 = msg('T3', 1, {
    from_name: null, from_email: 'bob@partner.com', subject: 'Re: 报价确认',
    mailbox: 'alpha@x.com', received_at: 1700000300,
  });
  const T2c = msg('T2c', 1, {
    from_name: 'support', from_email: 'support@x.com', subject: 'Re: 报价确认',
    mailbox: 'zhanglili@x.com', received_at: 1700000203,
  });
  const threadItems = [
    { // 对方来信（最新 → 排最前，与接口的降序一致）
      id: 'T3', direction: 'inbound', mailbox: 'alpha@x.com',
      from_name: null, from_email: 'bob@partner.com',
      to: ['alpha@x.com'], subject: 'Re: 报价确认',
      preview: '补充', received_at: 1700000300, read: true, deleted: false, current: false,
    },
    { // 出站副本（留存行）：同一封物理邮件在本账号内的「其它记录」挂在 copy_ids 上
      id: 'T2', direction: 'outbound', mailbox: 'support@x.com',
      from_name: 'support', from_email: 'support@x.com',
      to: ['alice@partner.com'], subject: 'Re: 报价确认',
      preview: '好的', received_at: 1700000201, read: true, deleted: false, current: false,
      copy_ids: ['T2c'],
    },
  ];

  return {
    mailboxes: [
      { mailbox: 'alpha@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
      { mailbox: 'zhanglili@x.com', inbox_unread: 0, inbox_total: 1, sent_total: 0 },
      { mailbox: 'support@x.com', inbox_unread: 0, inbox_total: 0, sent_total: 1 },
    ],
    folders: {
      // T2c 放首位 → maybeAutoOpen 打开的就是这份被折叠的副本
      inbox: { items: [T2c, T3], total: 2 },
      sent: { items: [], total: 0 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages: {
      T2c: detail(T2c, 1, threadItems),
      T3: detail(T3, 1, threadItems),
    },
    counts: { inbox_unread: 0, inbox_total: 2, sent_total: 1, starred_total: 0, trash_total: 0 },
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

/**
 * 预取用例固定装置：收件箱与已发送**各 50 封、id 不重叠**。
 * 这样「切换视图后有没有抓错视图 / 重复抓」才观察得到 ——
 * 若新视图为空列表，预取的游标扫描会自然 break，会把「取消没生效」伪装成通过。
 */
function prefetchFixture() {
  const inboxItems = [];
  const sentItems = [];
  const messages = {};
  for (let i = 0; i < 50; i++) {
    const n = String(i).padStart(2, '0');
    const a = msg('P' + n, i === 0 ? 0 : 1);
    const b = msg('S' + n, 1, { direction: 'outbound', status: 'sent' });
    inboxItems.push(a);
    sentItems.push(b);
    messages[a.id] = detail(a, a.read);
    messages[b.id] = detail(b, 1);
  }
  return {
    honorPaging: true,
    folders: {
      inbox: { items: inboxItems, total: 50 },
      sent: { items: sentItems, total: 50 },
      starred: { items: [], total: 0 },
      trash: { items: [], total: 0 },
    },
    messages,
    mailboxes: [{ mailbox: 'alpha@x.com', inbox_unread: 1, inbox_total: 50, sent_total: 50 }],
    counts: { inbox_unread: 1, inbox_total: 50, sent_total: 50, starred_total: 0, trash_total: 0 },
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
      v: CACHE_VERSION_IN_APP,
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
      v: CACHE_VERSION_IN_APP,
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
      v: CACHE_VERSION_IN_APP,
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

/** 轮询等待页面内某个表达式为真（默认 4s）。等待后台预取这类异步过程用它，别用固定 sleep 猜时长。 */
async function waitUntil(ctx, expr, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let v = false;
    try { v = !!evalIn(ctx, expr); } catch { /* 脚本尚未就绪 */ }
    if (v) return true;
    await sleep(ctx, 40);
  }
  return false;
}

/** 显式启动一次正文预取。boot() 默认会把自动预取作废，只有需要验证预取的用例才用它。 */
function startPrefetch(ctx) { evalIn(ctx, 'prefetchBodies()'); }

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
  // 另需等详情落定（detailPending 清空），否则会停在「头部已画、正文还在下载」的中间态。
  // holdDetail 时详情被测试主动挂起，这一条自动豁免。
  const wantDetailSettled = !cfg.holdDetail;
  let ready = false;
  for (let i = 0; i < 600; i++) {
    const nav = win.document.querySelector('#folder-nav');
    const list = win.document.querySelector('#list');
    let openId = null;
    let detailSettled = false;
    try {
      openId = win.eval('typeof state === "object" ? state.openId : null');
      detailSettled = !win.eval('detailPending');
    } catch { /* 脚本未就绪 */ }
    const settledOk = !wantDetailSettled || detailSettled;
    if (nav && nav.children.length === 4 && list && list.children.length > 0 && openId && settledOk) {
      ready = true; break;
    }
    await tick(win);
  }
  if (!ready) throw new Error('init() 未在预期时间内完成（fetch 打桩或脚本注入失败）');
  await ticks(win, 10);

  // 后台正文预取是**时间相关**的：它会在 paintList() 之后 500ms 开始顺序发详情请求，
  // 让所有「请求次数」类断言变成 flaky（实测：T9 的缓存条数前置条件被多出来的一封打乱）。
  // 默认在 boot 结束时作废它，测试就完全确定；要验证预取本身的用例显式调用
  // startPrefetch()/waitUntil()。gen 与 active 都要清：只递增 gen 的话，
  // 被取消那轮仍占着 prefetchActive，之后的 startPrefetch() 会被早退挡掉。
  if (!cfg.keepPrefetch) win.eval('prefetchGen++; prefetchActive = null;');

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

/**
 * 详情请求（GET /api/messages/:id），可指定起始下标。
 *
 * ⚠️ **必须按 `c.url` 过滤**：`calls` 里存的是 `{ url, method, body }` **对象**。
 * 若写成 `filter((u) => /^\/api\/messages\//.test(u))`，正则会被隐式转成 `"[object Object]"`
 * → **永远不匹配** → `length === 0` 恒成立 → 断言**空转假绿**。
 * 这不是假设：T8「刷新后不再发起详情请求」最初就是这样"通过"的。
 */
const detailCalls = (ctx, from = 0) => ctx.stub.calls.slice(from).filter((c) => /^\/api\/messages\//.test(c.url));

/**
 * 谓词自检：确认上面那个过滤器**真的能识别详情请求**，而不是恒为空。
 * 没有这一步，「期望 0 条」的断言无法区分「确实没发」与「过滤器坏了」。
 * 与 T10（同一过滤器，期望恰好 1 条）构成正负控制组。
 */
function assertDetailCollectorWorks(ctx) {
  ok(ctx.stub.calls.every((c) => c && typeof c.url === 'string'),
    '谓词自检：calls 里是 {url,...} 对象（必须按 c.url 过滤，不能拿正则直接测对象）');
  const probe = { url: '/api/messages/__probe__', method: 'GET' };
  ok(/^\/api\/messages\//.test(probe.url), '谓词自检：过滤器能识别详情请求 URL');
  ok(!/^\/api\/messages\//.test(probe), '谓词自检：拿正则直接测对象不匹配（即空转写法的症状）');
}

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
    // 快照版本号是从 app.js 里正则取的；正则一旦失配会静默变成 NaN，后面恢复路径的用例
    // 就会「快照永远被判过期」，必须在这里先证明它取到了真值。
    ok(Number.isInteger(CACHE_VERSION_IN_APP) && CACHE_VERSION_IN_APP > 0,
      'harness 自检：已从 app.js 解析出 CACHE_VERSION（否则恢复路径用例会静默空转）',
      `CACHE_VERSION_IN_APP=${CACHE_VERSION_IN_APP}`);
    ok(!!rowFor(ctx, 'A') && !!rowFor(ctx, 'B'), 'A / B 两行都存在于 DOM');
    ok(!!rowFor(ctx, 'A') && rowFor(ctx, 'A').classList.contains('unread'), 'A 行初始为未读（.unread 存在）');
    ok(!!rowFor(ctx, 'B') && !rowFor(ctx, 'B').classList.contains('unread'), 'B 行初始为已读（无 .unread）');
    // 证明 #select-all 的 change 监听确实已接线（否则后续断言会空转）
    setCheckbox(ctx, '#select-all', true);
    ok(evalIn(ctx, 'state.selected.size') === 3, '勾选 #select-all 后 state.selected.size=3（事件已接线）', evalIn(ctx, 'state.selected.size'));
    ok(!hidden(ctx, '#list-bulk'), '勾选后批量操作条可见');

    // CACHE_VERSION 升版（1→2）靠的就是「版本不符 → 整份拒绝」这条机制，这里直接验证它本身。
    // 否则「升版」只是一句注释，没人守着 readPersisted() 真的会拒。
    evalIn(ctx, `localStorage.setItem('inbox-cache-v1', JSON.stringify({ v: ${CACHE_VERSION_IN_APP - 1}, at: Date.now(), folder: { items: [{ id: 'STALE' }], total: 1 } }))`);
    ok(evalIn(ctx, 'readPersisted()') === null,
      '版本不符的快照被整份拒绝（CACHE_VERSION 升版据此让旧快照失效）');
    evalIn(ctx, `localStorage.setItem('inbox-cache-v1', JSON.stringify({ v: ${CACHE_VERSION_IN_APP}, at: Date.now(), folder: { items: [], total: 0 } }))`);
    ok(evalIn(ctx, 'readPersisted()') !== null,
      '负控制：版本相符的快照会被接受（不是「readPersisted 一律返回 null」）');
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

  /* ---- 详情：点击不被「正文尚未下载」阻塞 ---- */

  await test('T5 点开未缓存的邮件：头部同步渲染，正文位显示「下载中」，详情回来后原地替换', async (ctx) => {
    // 前置：boot 正常完成（首封 C 已自动打开并完整渲染）
    ok(/正文 C/.test(el(ctx, '#read-message .mail-body').textContent), '前置条件：C 已完整渲染');

    // 把详情接口设为「挂起」，以便观察点击后的中间态
    ctx.stub.setHoldDetail(true);
    clickRow(ctx, 'A'); // A 未缓存 → 详情被挂起，停在「正文下载中」

    ok(evalIn(ctx, 'state.openId') === 'A',
      '点击后 state.openId 立刻切到 A（同步，未等待请求）', JSON.stringify(evalIn(ctx, 'state.openId')));
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 A',
      'A 的主题立刻可见，且来自列表项（详情尚未返回）', el(ctx, '#read-message .mail-subject h1').textContent);
    ok(!!el(ctx, '#read-message .mail-envelope'), '信封卡（发件人/时间/操作按钮）已渲染');
    ok(el(ctx, '#read-message .env-who .who-email').textContent === 'a@x.com · 收至 alpha@x.com',
      '发件人邮箱 + 我方收件信箱立刻可见（乐观渲染，详情尚未返回）',
      el(ctx, '#read-message .env-who .who-email').textContent);

    const ph = el(ctx, '#read-message .mail-body-pending .body-pending');
    ok(!!ph, '正文位显示占位（而不是一块空白正文）');
    ok(!!ph && /正在下载/.test(ph.textContent), '占位文案含「正在下载」', ph && ph.textContent);
    ok(!el(ctx, '#read-message .mail-body pre.text'), '真实正文尚未渲染（否则上面「下载中」的断言会空转）');

    // 放行详情 → 正文原地替换
    ok(ctx.stub.releaseDetail('A'), '确实放行了被挂起的详情响应（否则下面的断言会空转）');
    await ticks(ctx.win, 10);
    ok(!el(ctx, '#read-message .mail-body-pending'), '详情到达后占位被移除');
    ok(/正文 A/.test(el(ctx, '#read-message .mail-body').textContent), '正文已原地替换为真实内容',
      el(ctx, '#read-message .mail-body').textContent.slice(0, 30));
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 A', '主题保持不变');

    // 负控制：缓存命中时必须同步渲染、不出现占位（证明占位由「缓存未命中」触发，而非无条件渲染）
    // 这里刻意保持 holdDetail=true —— 即使详情接口是挂起的，缓存命中也不该有占位。
    clickRow(ctx, 'C');
    ok(evalIn(ctx, 'state.openId') === 'C', '切回 C');
    ok(!el(ctx, '#read-message .mail-body-pending'), '负控制：缓存命中 ⇒ 同步渲染，不出现「下载中」占位');
    ok(/正文 C/.test(el(ctx, '#read-message .mail-body').textContent), '负控制：缓存命中的正文立即可见');
  });

  await test('T6 快速连点：先发的详情响应后到时，不得覆盖后选的邮件', async (ctx) => {
    ctx.stub.setHoldDetail(true);

    clickRow(ctx, 'A');
    clickRow(ctx, 'B');
    info(`被挂起的详情请求（按到达顺序）: ${JSON.stringify(ctx.stub.heldDetailIds())}`);
    ok(ctx.stub.heldDetailIds().join(',') === 'A,B', 'A、B 的详情都被挂起且顺序正确',
      JSON.stringify(ctx.stub.heldDetailIds()));
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 B', '当前显示的是 B 的头部');

    // 放行「先发」的 A：它已是过期响应，必须被丢弃
    ok(ctx.stub.releaseDetail('A'), '放行了 A 的（过期）详情响应');
    await ticks(ctx.win, 10);
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 B',
      '过期响应到达后面板仍是 B（没有被 A 覆盖）', el(ctx, '#read-message .mail-subject h1').textContent);
    ok(evalIn(ctx, 'state.openId') === 'B', 'state.openId 仍为 B', JSON.stringify(evalIn(ctx, 'state.openId')));
    ok(!!el(ctx, '#read-message .mail-body-pending'), 'B 的正文仍显示「下载中」（A 的响应没有被误用）');

    // 再放行 B：这次是当前请求，应当被采用
    ok(ctx.stub.releaseDetail('B'), '放行了 B 的详情响应');
    await ticks(ctx.win, 10);
    ok(!el(ctx, '#read-message .mail-body-pending'), 'B 的占位被移除');
    ok(/正文 B/.test(el(ctx, '#read-message .mail-body').textContent), '面板显示 B 的正文',
      el(ctx, '#read-message .mail-body').textContent.slice(0, 30));
  });

  await test('T7 详情加载失败：保留头部，正文位给出错误态与重试', async (ctx) => {
    // B 的详情缺失 → stub 返回 404，模拟详情接口失败
    clickRow(ctx, 'B');
    await ticks(ctx.win, 10);
    ok(el(ctx, '#read-message .mail-subject h1').textContent === '主题 B',
      '详情失败时头部仍可见（来自列表项）', el(ctx, '#read-message .mail-subject h1').textContent);
    const err = el(ctx, '#read-message .body-pending.is-error');
    ok(!!err, '正文位显示错误态占位（而不是一块空白正文）');
    ok(!!err && /正文加载失败/.test(err.textContent), '错误态给出失败原因', err && err.textContent);
    ok(!!err && /重试/.test(err.textContent), '错误态提供「重试」按钮');
  }, (() => { const c = inboxFixture(); delete c.messages.B; return c; })());

  /* ---- 正文缓存跨刷新存活 ---- */

  await test('T8 正文跨刷新持久化：刷新后点开读过的邮件不再重新下载', async (ctx) => {
    // 第一次会话：读 A，等防抖写入落盘
    evalIn(ctx, "openMessage('A')");
    await ticks(ctx.win, 8);
    await sleep(ctx, 450); // > PERSIST_DEBOUNCE_MS(300)
    const raw = ctx.win.localStorage.getItem('inbox-cache-v1');
    ok(!!raw, '快照已写入 localStorage（否则下面的断言会空转）');
    const snap = JSON.parse(raw);
    ok(Array.isArray(snap.messages), '快照含 messages 字段（正文已落盘）');
    ok(Array.isArray(snap.messages) && snap.messages.some((p) => p[0] === 'A'),
      'A 的正文在落盘列表里', Array.isArray(snap.messages) ? snap.messages.map((p) => p[0]).join(',') : 'null');

    // 第二次会话：用刚写下的快照冷启动，等价于「刷新页面」
    const ctx2 = await boot(Object.assign(inboxFixture(), { seedCache: raw }));
    try {
      const snapIds = snap.messages.map((p) => p[0]);

      // ⚠️ 前置：init() 会在启动时「重开上次打开的邮件」。若 openId 没被恢复，boot 根本不会重开，
      // 下面「boot 期间 0 次详情请求」就变成空转（什么都没测）。
      ok(evalIn(ctx2, 'state.openId') === 'A', '前置：上次打开的邮件已恢复为 A（否则 boot 不会重开）',
        evalIn(ctx2, 'state.openId'));

      // ⭐ 核心断言：boot 阶段重开 A 时**一次详情请求都没有发**——正文完全来自本地快照。
      // 用计数器（不依赖 URL 过滤器）度量，且与「是否重开」互相印证。
      ok(ctx2.stub.counters.detail === 0,
        '刷新后重开上次打开的邮件**未发起任何详情请求**（正文来自本地快照，不再重新下载）',
        `boot 期间 detail 计数 = ${ctx2.stub.counters.detail}`);

      // 快照里的每一封都必须回到内存缓存；尤其 C 在本次会话中从未被请求过，只能来自快照。
      ok(snapIds.length >= 1, '前置：快照里至少有 1 封正文（否则下面的「全部恢复」会空转）',
        snapIds.join(','));
      const missing = snapIds.filter((id) => !evalIn(ctx2, `state.cache.messages.has(${JSON.stringify(id)})`));
      ok(missing.length === 0, '快照里的每一封正文都已恢复到内存缓存',
        `快照=[${snapIds.join(',')}] 缺失=[${missing.join(',')}]`);

      const before = ctx2.stub.calls.length;
      const detailBefore = ctx2.stub.counters.detail;
      assertDetailCollectorWorks(ctx2);
      evalIn(ctx2, "openMessage('A')");
      ok(/正文 A/.test(el(ctx2, '#read-message .mail-body').textContent),
        '点开后正文**同步**可读（来自本地缓存）',
        el(ctx2, '#read-message .mail-body').textContent.slice(0, 20));
      ok(!el(ctx2, '#read-message .mail-body-pending'), '不出现「下载中」占位');
      await ticks(ctx2.win, 8);
      // 两条独立口径交叉验证：计数器（不依赖过滤器）+ URL 过滤
      ok(ctx2.stub.counters.detail === detailBefore,
        '刷新后点开读过的邮件**不再发起详情请求**（计数器口径）',
        `${detailBefore} → ${ctx2.stub.counters.detail}`);
      const detailReqs = detailCalls(ctx2, before);
      ok(detailReqs.length === 0, '刷新后点开读过的邮件**不再发起详情请求**（URL 口径）',
        detailReqs.map((c) => c.url).join(' , ') || '（无）');
    } finally {
      ctx2.close();
    }
  });

  /**
   * 在 Storage **原型**上装一个「按容量抛配额错误」的 setItem。
   * ⚠️ jsdom 的 Storage 是 Proxy：`ls.setItem = fn` 与 `Object.defineProperty(ls, 'setItem', …)`
   * **都会被 get 陷阱忽略**（已实测：包装函数调用次数恒为 0，数据照样写进去）。
   * 唯一有效的做法是在原型上覆写。调用方必须在 finally 里还原。
   * @param ctx 上下文
   * @param limitOf 返回「当前能接受的最大正文条数」；超过就抛 QuotaExceededError
   * @returns { tries, restore } tries 记录每次尝试时快照里带的正文条数
   */
  function installQuotaStub(ctx, limitOf) {
    const ls = ctx.win.localStorage;
    const proto = Object.getPrototypeOf(ls);
    const origSetItem = proto.setItem;
    const tries = [];
    const countMsgs = (v) => {
      try { const o = JSON.parse(v); return Array.isArray(o.messages) ? o.messages.length : 0; } catch { return 0; }
    };
    proto.setItem = function (k, v) {
      if (k !== 'inbox-cache-v1') return origSetItem.call(this, k, v);
      const n = countMsgs(v);
      tries.push(n);
      if (n > limitOf()) throw new Error('QuotaExceededError');
      return origSetItem.call(this, k, v);
    };
    return { tries, restore: () => { proto.setItem = origSetItem; } };
  }

  await test('T9 超配额时对半砍重试：保住较新的正文，列表缓存永不赔进去', async (ctx) => {
    evalIn(ctx, "openMessage('A')");
    await ticks(ctx.win, 8);
    await sleep(ctx, 450);
    ok(evalIn(ctx, 'state.cache.messages.size') === 2,
      '前置条件：内存里有 2 封正文可落盘（C 由自动打开带入、A 由本次点击带入）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    // 模拟 localStorage 满：只装得下 1 封正文
    const q = installQuotaStub(ctx, () => 1);
    try {
      evalIn(ctx, 'writePersisted()');
    } finally {
      q.restore();
    }

    // 空转防护：必须真的「先试 2 封、失败、砍到 1 封再试」
    ok(q.tries.length === 2, '确实重试了一次（而不是一次性放弃）', q.tries.join(' → '));
    ok(q.tries[0] === 2 && q.tries[1] === 1,
      '第一次带 2 封被拒后，砍到 1 封再试', q.tries.join(' → '));

    const snap = JSON.parse(ctx.win.localStorage.getItem('inbox-cache-v1'));
    ok(Array.isArray(snap.messages) && snap.messages.length === 1,
      '最终快照保留 1 封正文', Array.isArray(snap.messages) ? snap.messages.length : 'null');
    ok(Array.isArray(snap.messages) && snap.messages[0][0] === 'A',
      '保留的是**较新**的那封（A），不是较旧的 C',
      Array.isArray(snap.messages) ? snap.messages.map((p) => p[0]).join(',') : 'null');
    ok(Array.isArray(snap.folder.items) && snap.folder.items.length > 0,
      '列表缓存被保住（没有因为正文太大而一起赔进去）', snap.folder.items.length);
  });

  await test('T9b 连一封正文都写不下时：只写列表，仍然不赔进列表缓存', async (ctx) => {
    evalIn(ctx, "openMessage('A')");
    await ticks(ctx.win, 8);
    await sleep(ctx, 450);
    ok(evalIn(ctx, 'state.cache.messages.size') === 2, '前置条件：内存里有 2 封正文可落盘',
      evalIn(ctx, 'state.cache.messages.size'));

    // 模拟极端配额：任何带正文的写入都失败
    const q = installQuotaStub(ctx, () => 0);
    try {
      evalIn(ctx, 'writePersisted()');
    } finally {
      q.restore();
    }

    ok(q.tries.join(' → ') === '2 → 1 → 0',
      '一路砍到空（2 → 1 → 0），没有跳过任何一档', q.tries.join(' → '));

    const snap = JSON.parse(ctx.win.localStorage.getItem('inbox-cache-v1'));
    ok(!Object.prototype.hasOwnProperty.call(snap, 'messages'), '最终快照不含正文');
    ok(Array.isArray(snap.folder.items) && snap.folder.items.length > 0,
      '列表缓存仍然被保住', snap.folder.items.length);
  });

  await test('T10 正文缓存过期后：仍然立刻可读，同时后台校验', async (ctx) => {
    evalIn(ctx, "openMessage('A')");
    await ticks(ctx.win, 8);
    ok(evalIn(ctx, "state.cache.messages.has('A')"), '前置条件：A 已进入正文缓存');

    // 把缓存时间推到 24 小时前（模拟隔天再打开同一封）
    evalIn(ctx, "state.cache.messages.get('A').at = Date.now() - 24*3600*1000");
    const before = ctx.stub.calls.length;
    const detailBefore = ctx.stub.counters.detail;
    assertDetailCollectorWorks(ctx);
    evalIn(ctx, "openMessage('A')");
    ok(/正文 A/.test(el(ctx, '#read-message .mail-body').textContent),
      '过期缓存也**同步**渲染，不等网络', el(ctx, '#read-message .mail-body').textContent.slice(0, 20));
    ok(!el(ctx, '#read-message .mail-body-pending'), '不出现「下载中」占位');

    await ticks(ctx.win, 8);
    // 这条同时是 T8 的正控制组：同一过滤器必须能抓到 1 条，否则 T8 的 0 条无意义
    const reqs = detailCalls(ctx, before);
    ok(reqs.length === 1, '同时后台发起了一次校验请求（保证已读态最终一致）',
      reqs.map((c) => c.url).join(' , ') || '（无）');
    ok(ctx.stub.counters.detail === detailBefore + 1, '计数器口径一致：恰好 1 次详情请求',
      `${detailBefore} → ${ctx.stub.counters.detail}`);
  });

  /* ---- 后台预下载正文 ---- */

  await test('T11 后台预取：不点击也把列表里未缓存的正文抓回来，且不改动用户视图', async (ctx) => {
    // boot 会自动打开首项 C → C 已缓存；A、B 尚未缓存
    ok(evalIn(ctx, "state.cache.messages.has('C')"), '前置：C 已因自动打开进入缓存');
    ok(!evalIn(ctx, "state.cache.messages.has('A')") && !evalIn(ctx, "state.cache.messages.has('B')"),
      '前置：A/B 尚未缓存（否则本用例会空转）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    const openIdBefore = evalIn(ctx, 'state.openId');
    const subjectBefore = el(ctx, '#read-message .mail-subject h1').textContent;
    const before = ctx.stub.calls.length;

    startPrefetch(ctx);
    const done = await waitUntil(ctx, "state.cache.messages.has('A') && state.cache.messages.has('B')");
    ok(done, '预取把 A、B 的正文都抓了回来（全程没有任何点击）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    const fetched = detailCalls(ctx, before).map((c) => c.url);
    ok(fetched.includes('/api/messages/A') && fetched.includes('/api/messages/B'),
      '确实是靠后台详情请求拿到的，而不是凭空出现', fetched.join(' , ') || '（无）');

    // 预取是纯后台行为：不得触碰用户视图
    ok(evalIn(ctx, 'state.openId') === openIdBefore, '打开中的邮件没有被改变',
      `${openIdBefore} → ${evalIn(ctx, 'state.openId')}`);
    ok(evalIn(ctx, 'detailPending') === null, '预取不得留下「下载中」占位状态',
      String(evalIn(ctx, 'detailPending')));
    ok(el(ctx, '#read-message .mail-subject h1').textContent === subjectBefore,
      '右侧面板仍然显示原来那封', el(ctx, '#read-message .mail-subject h1').textContent);
    ok(!el(ctx, '#read-message .mail-body-pending'), '面板没有出现「下载中」占位');
  });

  await test('T11b 负控制：页面不可见时不预取，恢复可见后继续', async (ctx) => {
    Object.defineProperty(ctx.win.document, 'hidden', { value: true, configurable: true });
    Object.defineProperty(ctx.win.document, 'visibilityState', { value: 'hidden', configurable: true });
    const before = ctx.stub.calls.length;
    startPrefetch(ctx);
    await sleep(ctx, 1200); // 远超 PREFETCH_START_DELAY_MS(500) + 一个间隔
    ok(detailCalls(ctx, before).length === 0, '页面隐藏时一个详情请求都不发',
      detailCalls(ctx, before).map((c) => c.url).join(' , ') || '（无）');
    ok(!evalIn(ctx, "state.cache.messages.has('A')"), '隐藏期间也没有预取到正文');

    // 恢复可见：同一套设置下必须真的开始预取，否则上面的 0 可能是「功能压根没生效」而非「被门控」
    Object.defineProperty(ctx.win.document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(ctx.win.document, 'visibilityState', { value: 'visible', configurable: true });
    startPrefetch(ctx);
    const done = await waitUntil(ctx, "state.cache.messages.has('A')");
    ok(done, '恢复可见后预取正常进行（证明上面的 0 不是功能失效）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));
  });

  await test('T11b2 运行中转为不可见：预取立即暂停（入口门控之外的循环内门控）', async (ctx) => {
    startPrefetch(ctx);
    const startedOk = await waitUntil(ctx, "state.cache.messages.has('A')", 4000);
    ok(startedOk, '前置：预取已经跑起来（否则「暂停」无从观察）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    Object.defineProperty(ctx.win.document, 'hidden', { value: true, configurable: true });
    await ticks(ctx.win, 2);
    const before = ctx.stub.calls.length;
    await sleep(ctx, 900); // 远超一个间隔（100ms）
    ok(detailCalls(ctx, before).length === 0, '转为不可见后不再继续发请求',
      detailCalls(ctx, before).map((c) => c.url).join(' , ') || '（无）');
  });

  await test('T11c 视图切换：预取中途作废 —— 不抓旧视图，也不产生重复请求', async (ctx) => {
    startPrefetch(ctx);
    await sleep(ctx, 800); // 500ms 启动延迟 + 约 3 封
    const started = detailCalls(ctx, 0).map((c) => c.url);
    ok(started.length >= 1, '前置：预取确实已经开始（否则「取消」无从观察）', started.join(' , ') || '（无）');

    const beforeSwitch = ctx.stub.calls.length;
    evalIn(ctx, "openFolder('sent')"); // folderKey 立刻变化 → 作废本轮预取
    await ticks(ctx.win, 6);
    await sleep(ctx, 1400);

    const after = detailCalls(ctx, beforeSwitch).map((c) => c.url);
    const stale = after.filter((u) => /\/api\/messages\/P\d\d$/.test(u));
    ok(stale.length === 0, '切换后不再抓旧视图（收件箱 P##）的正文', stale.join(' , ') || '（无）');

    // ⭐ 关键：若取消没生效，旧那轮会**带着游标**继续跑（从第 4 封往后），
    // 于是切换后第一个请求会是 S04 而不是 S00。只断言「没抓旧视图」抓不到它：
    // 旧轮重新快照 state.items 后抓的是新视图，看起来也"正常"。
    const firstNew = after.find((u) => /\/api\/messages\/S\d\d$/.test(u));
    ok(firstNew === '/api/messages/S00',
      '切换后从新视图的**第一封**重新开始预取（说明是干净的新一轮，而不是旧轮带着游标继续跑）',
      firstNew || '（无）');

    const dupes = after.filter((u, i) => after.indexOf(u) !== i);
    ok(dupes.length === 0, '切换后没有任何一封被重复抓（否则说明新旧两轮预取同时在跑）',
      dupes.join(' , ') || '（无）');

    ok(after.some((u) => /\/api\/messages\/S\d\d$/.test(u)),
      '新视图（已发送 S##）的正文有被正常预取',
      after.filter((u) => /S\d\d$/.test(u)).length + ' 条');
  }, prefetchFixture());

  await test('T11d 预取是自动的：列表渲染后无需任何调用/点击，正文自己回来', async (ctx) => {
    // 本用例**不**调用 startPrefetch：验证的是 paintList → prefetchBodies 这条接线本身。
    // boot({keepPrefetch:true}) 表示不作废自动预取。
    const before = ctx.stub.calls.length;
    const done = await waitUntil(ctx, "state.cache.messages.has('A') && state.cache.messages.has('B')", 8000);
    ok(done, '自动预取生效（全程没有任何点击，也没有手动触发）',
      evalIn(ctx, 'Array.from(state.cache.messages.keys()).join(",")'));

    const fetched = detailCalls(ctx, before).map((c) => c.url);
    ok(fetched.includes('/api/messages/A') && fetched.includes('/api/messages/B'),
      '确实发了后台详情请求', fetched.join(' , ') || '（无）');
  }, Object.assign(inboxFixture(), { keepPrefetch: true }));

  /* ---- T12 会话行 / 信封卡必须显示「实际收发信箱」---- */
  await test('T12 会话行显示收发双方的实际信箱 + 按时间降序（最近在前）', async (ctx) => {
    // 负控制：会话面板必须真的渲染出来了，否则下面全部空转
    ok(!!el(ctx, '.rm-thread'), '会话面板已渲染（currentThread.length > 1）');
    const rows = Array.from(ctx.doc.querySelectorAll('.rm-thread .t-item'));
    ok(rows.length === 3, '会话面板渲染出 3 行', rows.length);
    ok(rows.length === 3 && evalIn(ctx, 'currentThread.length') === 3,
      '面板行数与 currentThread 一致（不是上一轮的渲染残留）', evalIn(ctx, 'currentThread.length'));

    const texts = rows.map((r) => r.querySelector('.t-sender').textContent);
    // ⭐ 顺序：服务端 listThread 已改为 received_at DESC，面板必须原样呈现
    //   固定装置三封的时间是 T3(…300) > T2(…200) > T1(…100)。
    ok(texts.join(' || ') === [
      'bob@partner.com → alpha@x.com',                        // T3 最新（无名字 → 回退邮箱）
      'support@x.com → alice@partner.com, bob@partner.com',    // T2 我的回信（完整收件人清单）
      'Alice → alpha@x.com',                                   // T1 最早
    ].join(' || '),
      '⭐ 会话行按时间降序（最近 → 最早）：T3 → T2 → T1', texts.join(' | '));
    ok(texts[0] !== 'Alice → alpha@x.com',
      '负控制：首行不是最早那封（即「仍是升序」会立刻失败）', texts[0]);

    // 时间列也必须是降序（与 sender 序列互相印证，避免「只是数组被倒过来」）
    const times = rows.map((r) => r.querySelector('.t-time').textContent);
    ok(times.every((t) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)),
      '时间列格式为 YYYY-MM-DD HH:MM（否则下面的降序比较无意义）', times.join(' | '));
    ok(times.join('|') === [...times].sort().reverse().join('|'),
      '时间列逐行递减（最近在前）', times.join(' | '));

    // 旧实现的症状：字段名读错（t.to_emails）→ 恒为「我 → ?」。下面两条直接锁死该症状。
    ok(!texts.some((t) => t.includes('?')), '任何会话行都不得出现「?」占位', texts.join(' | '));
    ok(!texts.some((t) => /^我\s*→/.test(t)), '出站行不得用字面量「我」顶替实际发件信箱', texts.join(' | '));

    const titles = rows.map((r) => r.querySelector('.t-sender').title);
    ok(titles[1] === 'support@x.com → alice@partner.com, bob@partner.com',
      '会话行 title 给出完整收发双方（列宽不足被省略号截断时靠它读全）', titles[1]);
    ok(titles.join('|') === texts.join('|'), 'title 与可见文案逐行一致（不因倒序而错位）',
      titles.join(' | '));
  }, threadFixture());

  await test('T12b 信封卡：来信显示「收至 我的信箱」，回信显示实际发件信箱', async (ctx) => {
    ok(evalIn(ctx, 'state.openId') === 'T3', '前置：首项 T3 已被自动打开', evalIn(ctx, 'state.openId'));
    ok(el(ctx, '#read-message .env-who .who-name').textContent === 'bob@partner.com',
      '来信标题：无名字时回退到对方邮箱', el(ctx, '#read-message .env-who .who-name').textContent);
    ok(el(ctx, '#read-message .env-who .who-email').textContent === 'bob@partner.com · 收至 alpha@x.com',
      '来信副行必须能一眼看到「我方收到的信箱」',
      el(ctx, '#read-message .env-who .who-email').textContent);

    // 切到「已发送」，打开我的回信
    evalIn(ctx, "openFolder('sent')");
    await ticks(ctx.win, 10);
    ok(!!rowFor(ctx, 'T2'), '已切到「已发送」且 T2 在列表里（否则下面的点击会空转）');
    clickRow(ctx, 'T2');
    await ticks(ctx.win, 20);
    ok(evalIn(ctx, 'state.openId') === 'T2', '已打开 T2', evalIn(ctx, 'state.openId'));
    ok(el(ctx, '#read-message .env-who .who-name').textContent === 'support@x.com',
      '回信标题是**实际发件信箱**，不再是字面量「我」',
      el(ctx, '#read-message .env-who .who-name').textContent);
    ok(el(ctx, '#read-message .env-who .who-email').textContent === '致 alice@partner.com, bob@partner.com',
      '回信副行是完整收件人清单', el(ctx, '#read-message .env-who .who-email').textContent);
  }, threadFixture());

  await test('T12c 乐观渲染：详情未返回时信封卡已显示「收至 我的信箱」', async (ctx) => {
    ok(evalIn(ctx, 'state.openId') === 'T3', '前置：自动打开的是 T3');
    ctx.stub.setHoldDetail(true);
    clickRow(ctx, 'T4');
    ok(evalIn(ctx, 'state.openId') === 'T4', '点击后同步切到 T4', evalIn(ctx, 'state.openId'));
    ok(!!el(ctx, '#read-message .mail-body-pending'),
      '负控制：详情确实还没回来（否则下面的断言可能是被详情蒙对的）');
    ok(el(ctx, '#read-message .env-who .who-email').textContent === 'carol@partner.com · 收至 beta@x.com',
      '详情未返回时信封卡已经显示我方收件信箱（靠列表项随带的 mailbox，不依赖详情接口）',
      el(ctx, '#read-message .env-who .who-email').textContent);
    ok(ctx.stub.releaseDetail('T4'), '放行被挂起的详情响应');
    await ticks(ctx.win, 10);
  }, threadFixture());

  /* ---- T12d 折叠掉的那份副本被打开时，留存行必须仍标成「当前」---- */
  await test('T12d 打开的是被折叠的回环副本时，会话面板仍高亮留存行', async (ctx) => {
    // 负控制：确实打开的是副本 T2c，而不是留存行 T2（否则本用例什么都没验证）
    ok(evalIn(ctx, 'state.openId') === 'T2c', '前置：自动打开的是被折叠的副本 T2c',
      evalIn(ctx, 'state.openId'));
    const threadIds = evalIn(ctx, 'currentThread.map((t) => t.id).join(",")');
    ok(threadIds === 'T3,T2',
      '负控制：会话里**没有** T2c（服务端已折叠），且顺序为降序 T3 → T2', threadIds);
    ok(evalIn(ctx, 'JSON.stringify(currentThread.find((t) => t.id === "T2").copy_ids)') === '["T2c"]',
      '负控制：留存行 T2 带着 copy_ids=["T2c"]（折叠关系真的传到了前端）',
      evalIn(ctx, 'JSON.stringify(currentThread.find((t) => t.id === "T2").copy_ids)'));

    const rows = Array.from(ctx.doc.querySelectorAll('.rm-thread .t-item'));
    ok(rows.length === 2, '会话面板渲染 2 行（副本已折叠，不是 3 行）', rows.length);
    const currents = Array.from(ctx.doc.querySelectorAll('.rm-thread .t-item.current'));
    ok(currents.length === 1, '⭐ 恰好一行被标为当前（不多不少）', currents.length);
    ok(currents.length === 1 && currents[0].querySelector('.t-sender').textContent === 'support@x.com → alice@partner.com',
      '⭐ 当前行是**留存行** T2（出站），而不是被折叠掉的副本',
      currents.length ? currents[0].querySelector('.t-sender').textContent : '（无 current 行）');
    ok(currents.length === 1 && currents[0] === rows[1],
      '当前行是第 2 行（不是「碰巧第一行」）—— 证明不是靠索引蒙对',
      currents.length ? String(rows.indexOf(currents[0])) : 'n/a');

    // 点自己这行不得重复打开（否则会被当成「换了一封」而重新拉详情）。
    // ⚠️ 先判空再解引用：若上面「恰好一行 current」已失败，这里直接引用 currents[0] 会抛异常
    //    把整个用例打崩、丢掉后面的断言（历史踩过）。判空时显式记 FAIL，绝不用「跳过」冒充通过。
    const cur = currents.length === 1 ? currents[0] : null;
    if (!cur) {
      ok(false, `无法验证「点当前行不重复打开」：当前行不唯一（${currents.length} 个），上一组断言已失败`);
    } else {
      const before = ctx.stub.counters.detail;
      clickEl(ctx, cur);
      await ticks(ctx.win, 8);
      ok(ctx.stub.counters.detail === before,
        '点击当前行不再发起详情请求（副本行也算「就是这一封」）',
        `${before} → ${ctx.stub.counters.detail}`);
      ok(evalIn(ctx, 'state.openId') === 'T2c', '点当前行后打开的仍是 T2c（视图没有被切走）',
        evalIn(ctx, 'state.openId'));
    }
  }, threadCopyFixture());

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
