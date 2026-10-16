'use strict';

/* =========================================================
 * 邮件收件箱前端（无构建，纯原生）
 * 布局：左侧邮件清单 + 右侧详情（类 Yahoo/常见客户端）
 * 能力：多收件地址 · 会话上下文 · 附件发送 · 富文本
 * 性能：本地持久化缓存（localStorage）优先渲染 + 后台 revalidate + 静默刷新 + 定时同步
 * ========================================================= */

const FOLDERS = [
  { key: 'inbox', label: '收件箱' },
  { key: 'drafts', label: '草稿' },
  { key: 'starred', label: '已加星标' },
  { key: 'sent', label: '已发送' },
  { key: 'trash', label: '已删除' },
];

const PAGE_SIZE = 50;
const MAX_FILE_BYTES = 40 * 1024 * 1024;

const TTL = { folder: 45 * 1000, message: 3 * 60 * 1000, counts: 20 * 1000, mailboxes: 10 * 1000 };
// 后台同步间隔：60s → 5min。理由：计数/列表的 TTL 是 20~45s，60s 一轮几乎每轮都在重拉；
// 而列表/计数只在「有变化」时才需要刷新，5min 已能覆盖「长时间挂着页面」的场景，
// 页面重新可见时还有 visibilitychange 兜底立即同步一次。
const SYNC_MS = 5 * 60 * 1000;

/* 本地持久化缓存：刷新页面后首屏 0 请求即可显示列表 / 计数徽标 / 账号下拉。 */
const CACHE_KEY = 'inbox-cache-v1';
// v2：会话项新增 `copy_ids`、且顺序由升序改为降序（见 src/repo.ts listThread）。
// 旧快照里的 thread 数组带着**旧顺序与重复行**，且 TTL 内不会重新校验，
// 不升版会让「已经修好的会话面板」在刷新后仍显示旧结果（一次全量重拉换立即正确）。
// v3：会话归组的根因修复（Resend 的 References 是 JSON 数组文本，旧解析产出畸形 thread_id）
//     —— 旧快照里的 thread 数组是按错误分组拼出来的，必须整份作废；
//     同时新增「草稿」文件夹，counts 多了 drafts_total 字段。
// v4：列表行的 thread_count 改为「折叠回环副本后」的封数（见 src/repo.ts applyFoldedThreadCounts），
//     与会话面板口径对齐。旧快照里的列表徽标仍是折叠前的原始行数（如 3 vs 2），
//     而列表 revalidate 的指纹不含 thread_count，不升版会一直显示旧徽标。
const CACHE_VERSION = 4;
const PERSIST_DEBOUNCE_MS = 300;

/* 已打开邮件正文的内存 LRU：最多 40 封或合计 2MB，先到为准。 */
const MSG_CACHE_MAX = 40;
const MSG_CACHE_BYTES = 2 * 1024 * 1024;

/*
 * 落盘正文**不另设条数/字节上限**：内存 LRU 里有什么就落什么（LRU 自身已封顶 40 封 / 2MB）。
 * 真正的兜底是 localStorage 的硬配额（通常 5MB/源）—— 见 writePersisted 的对半砍重试。
 * 这样「读过的邮件刷新后免下载」覆盖到全部最近读过的邮件，而不是只有最近 12 封。
 */

/** 后端把 mailbox 为空/NULL 的行归入这个显式分组；必须与 src/repo.ts 的 UNKNOWN_MAILBOX 一致。 */
const UNKNOWN_MAILBOX = '(未识别)';

/*
 * 后台预下载正文：列表渲染完成后，空闲时顺序把当前列表里**尚未缓存**的正文抓回来。
 * 目的：用户点开时正文已经在本地，不再看到「正在下载」。
 */
const PREFETCH_MAX = 50;             // 一次预取上限（正好一页）
const PREFETCH_START_DELAY_MS = 500; // 先让首屏的关键请求走完，再开始预取
const PREFETCH_GAP_MS = 100;         // 每封之间留间隔，不与用户点击争抢
const PREFETCH_PERSIST_EVERY = 5;    // 每预取 N 封落盘一次，中途离开也不会全丢

const STATUS_LABEL = {
  sent: '已发送',
  delivered: '已送达',
  bounced: '退信',
  failed: '失败',
  draft: '草稿',
  delayed: '延迟',
  queued: '排队中',
  complaint: '投诉',
  received: '已收到',
};

const state = {
  folder: 'inbox',
  mailbox: '',
  mailboxList: [],
  items: [],
  itemsKey: null, // 当前 state.items 对应的视图 key，用于判断「同视图刷新」而非清屏重来
  selected: new Set(),
  q: '',
  total: 0,
  offset: 0,
  counts: { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0, drafts_total: 0 },
  composing: null, // { mode, originalId, files:[], rich, original, mailbox }
  canSend: false,
  fromAddress: '',
  fromName: '',
  /** 本地联系人（GET /api/contacts），供收件人输入联想。 */
  contacts: [],
  contactsLoaded: false,
  openId: null,
  pendingOpenId: null, // 从本地缓存恢复、待列表就绪后重新打开的邮件 id
  /** 用户拖动分隔条设定的列表宽度（px）。null = 未自定义，走 CSS 默认值与响应式夹取。 */
  listWidth: null,
  loading: false,
  firstOpen: true,
  cache: {
    folders: new Map(),
    messages: new Map(),
    countsAt: 0,
    mailboxesAt: 0,
    mailboxesLoading: false,
    mailboxesPending: false,
  },
};

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const readEl = $('#read-message');

/* ---------------- 移动端布局（单栏 + 抽屉） ----------------
 * 断点必须与 app.css 里的 `@media (max-width: 768px)` 保持一致。
 */
const MOBILE_MAX_W = 768;

/**
 * 视口宽度。
 *
 * 用 `globalThis` 而不是 `window`：两个 vm 套件（compose-guard / mail-merge）的 sandbox 里
 * **没有 window**，裸访问会 `ReferenceError` 把整个套件打挂；`globalThis` 在浏览器里就是
 * window、在 sandbox 里是 sandbox 自身，两边都安全。
 */
function viewportWidth() {
  const w = globalThis.innerWidth;
  return typeof w === 'number' && w > 0 ? w : 1024;
}

/**
 * 是否走移动端（单栏 + 抽屉）布局。
 *
 * matchMedia 优先：真机上它还能感知旋转 / 分屏，且不依赖读时机的 innerWidth。
 * 缺失时回退到 innerWidth —— jsdom 不实现 matchMedia（实测 `typeof window.matchMedia`
 * 是 `undefined`），不做这层特性检测，4 个 jsdom 套件会在 init() 里直接抛错全挂。
 *
 * ⚠️ 不要用「触摸能力」判断移动端：jsdom 里 `'ontouchstart' in window` 是 **true**，
 * 会把所有测试误判成移动端；`navigator.maxTouchPoints` 在 jsdom 里是 undefined，同样不可靠。
 * 只认宽度。
 */
function isMobile() {
  const mm = globalThis.matchMedia;
  if (typeof mm === 'function') {
    try {
      return mm(`(max-width: ${MOBILE_MAX_W}px)`).matches;
    } catch {
      /* matchMedia 存在但不可用（被桩成不完整对象等）→ 回退到宽度判断 */
    }
  }
  return viewportWidth() <= MOBILE_MAX_W;
}

/** 抽屉是否展开。仅移动端有意义。 */
let drawerOpen = false;

/**
 * 移动端布局的**唯一收敛点**：把 (isMobile, state.openId, drawerOpen) 全量对齐到
 * `#app` 上的状态类。任何地方都不许直接 toggle 这几个类，只调这里。
 *
 * 桌面端下这些类不生效（对应规则全在 @media 内），所以从移动端缩放到桌面时不必额外清理；
 * 但仍在这里把 drawerOpen 归零，避免缩回移动端时抽屉莫名是开着的。
 */
function syncLayout() {
  const app = $('#app');
  if (!app) return;
  const mobile = isMobile();
  if (!mobile) drawerOpen = false;
  app.classList.toggle('is-mobile', mobile);
  app.classList.toggle('mobile-detail', mobile && state.openId !== null);
  app.classList.toggle('drawer-open', mobile && drawerOpen);
  // 写信弹窗的浮动几何：移动端要把内联 left/top/width/height 清掉（内联值优先于媒体查询），
  // 桌面端则把几何重新夹进新视口。放在这里而不是另开一个 resize 监听，是为了让
  // 「断点切换」和「窗口缩放」共用同一个收敛点。
  syncComposerWindowLayout();
  // 同理：列表宽度也要按新视口重新夹取（窗口缩小时不能把详情栏挤没）
  syncListWidth();
}

function setDrawer(open) {
  drawerOpen = !!open;
  syncLayout();
}

/** 收起抽屉。桌面端调用无副作用（drawerOpen 本来就是 false）。 */
function closeDrawer() {
  if (drawerOpen) setDrawer(false);
}

/* ---------------- 列表 / 详情分隔条（可拖动） ----------------
 * 桌面双栏下，用户拖动中间竖线调整列表宽度。
 *
 * 宽度只有一个真值来源：`state.listWidth`（**用户期望宽度**），
 * 唯一出口是 `applyListWidth()`（写 CSS 变量 `--list-w` + 挂 `list-w-custom` 类）。
 * 拖动 / 键盘 / 双击复位 / 窗口缩放全部收敛到这里，任何地方不许自己写 style.width。
 *
 * ⚠️ `state.listWidth` 存期望值而非夹取后的实际值：否则窗口缩小被夹一次、再放大就回不去了。
 */

const LIST_W_KEY = 'inbox-list-w';
const LIST_W_DEFAULT = 430; // 与 app.css 里 :root 的 --list-w 初始值一致
const LIST_W_MIN = 260; // 再窄主题与发件人都显示不全
const LIST_W_MAX_RATIO = 0.7; // 最多占视口 70%，详情栏永远留得住

/** 当前视口允许的最大列表宽度。 */
function listWidthMax() {
  return Math.max(LIST_W_MIN, Math.floor(viewportWidth() * LIST_W_MAX_RATIO));
}

function clampListWidth(px) {
  const n = Math.round(Number(px));
  if (!Number.isFinite(n)) return LIST_W_DEFAULT;
  return Math.min(listWidthMax(), Math.max(LIST_W_MIN, n));
}

/** `px == null` → 恢复默认（清掉自定义类与内联变量，回到 CSS 的 430px + 响应式夹取）。 */
function applyListWidth(px) {
  const app = $('#app');
  if (!app) return;
  if (px == null) {
    state.listWidth = null;
    app.classList.remove('list-w-custom');
    document.documentElement.style.removeProperty('--list-w');
    return;
  }
  state.listWidth = Math.round(Number(px)) || LIST_W_DEFAULT;
  document.documentElement.style.setProperty('--list-w', `${clampListWidth(state.listWidth)}px`);
  app.classList.add('list-w-custom');
}

/** 视口变化后重新夹取（保留期望值，不把「临时夹小」写回 state）。 */
function syncListWidth() {
  if (state.listWidth == null) return;
  applyListWidth(state.listWidth);
}

function loadListWidth() {
  try {
    const raw = localStorage.getItem(LIST_W_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function saveListWidth() {
  try {
    if (state.listWidth == null) localStorage.removeItem(LIST_W_KEY);
    else localStorage.setItem(LIST_W_KEY, String(state.listWidth));
  } catch {
    /* 存储不可用（隐私模式 / 配额满）：本次会话内仍然生效 */
  }
}

/** 列表当前实际宽度，作为键盘步进的基准。 */
function currentListWidth() {
  const pane = $('#list-pane');
  const w = pane && typeof pane.getBoundingClientRect === 'function' ? pane.getBoundingClientRect().width : 0;
  return w > 0 ? w : (state.listWidth ?? LIST_W_DEFAULT);
}

let splitDrag = null;

function onSplitterDown(e) {
  if (isMobile()) return;
  if (e.button != null && e.button !== 0) return;
  const sp = $('#splitter');
  if (!sp) return;
  // 双击复位：连击时 pointerdown 的 detail 递增（第二次为 2）。
  // 不用 dblclick，是因为下面的 preventDefault 会干扰 click 序列。
  if (e.detail >= 2) {
    applyListWidth(LIST_W_DEFAULT);
    saveListWidth();
    e.preventDefault();
    return;
  }
  splitDrag = { x: e.clientX, start: currentListWidth(), id: e.pointerId };
  const app = $('#app');
  if (app) app.classList.add('resizing');
  // 指针捕获：拖动时即使掠过详情区也能持续收到 move/up
  if (e.pointerId != null && typeof sp.setPointerCapture === 'function') {
    try {
      sp.setPointerCapture(e.pointerId);
    } catch {
      /* 捕获不可用则退化成普通事件流，功能不受影响 */
    }
  }
  e.preventDefault();
}

function onSplitterMove(e) {
  if (!splitDrag) return;
  if (splitDrag.id != null && e.pointerId != null && e.pointerId !== splitDrag.id) return;
  applyListWidth(splitDrag.start + (e.clientX - splitDrag.x));
}

function onSplitterUp(e) {
  if (!splitDrag) return;
  if (splitDrag.id != null && e.pointerId != null && e.pointerId !== splitDrag.id) return;
  splitDrag = null;
  const app = $('#app');
  if (app) app.classList.remove('resizing');
  saveListWidth();
}

/** 键盘调整（分隔条可聚焦）：← → 步进，Shift 加速，Home 复位。 */
function onSplitterKey(e) {
  const step = e.shiftKey ? 50 : 16;
  if (e.key === 'ArrowLeft') applyListWidth(currentListWidth() - step);
  else if (e.key === 'ArrowRight') applyListWidth(currentListWidth() + step);
  else if (e.key === 'Home') applyListWidth(LIST_W_DEFAULT);
  else return;
  saveListWidth();
  e.preventDefault();
}

function setupSplitter() {
  const sp = $('#splitter');
  if (!sp) return;
  sp.addEventListener('pointerdown', onSplitterDown);
  sp.addEventListener('pointermove', onSplitterMove);
  sp.addEventListener('pointerup', onSplitterUp);
  sp.addEventListener('pointercancel', onSplitterUp);
  sp.addEventListener('keydown', onSplitterKey);
}

/* ---------------- API ---------------- */

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  } catch {
    throw new Error('网络错误，请检查 Worker 是否可访问');
  }
  if (res.status === 401) {
    showToast('认证失败，请刷新页面重新登录', true);
    setTimeout(() => location.reload(), 800);
    throw new Error('unauthorized');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : null;
  if (!res.ok) {
    throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  }
  return data;
}

/* ---------------- 缓存 ---------------- */

function folderKey() {
  return `${state.mailbox}|${state.folder}|${state.q}`;
}

/** 轻量指纹：首尾 id + 总数 + 每行 read/starred，用于「数据没变就不重渲染」。 */
function folderFingerprint(items, total) {
  let s = `${total}|${items.length}`;
  for (const it of items) s += `|${it.id}${it.read ? 'r' : 'u'}${it.starred ? 's' : ''}`;
  return s;
}

function storeFolderCache(items, total, fp) {
  state.cache.folders.set(folderKey(), {
    items: [...items],
    total,
    at: Date.now(),
    fp: fp || folderFingerprint(items, total),
  });
}

function findItem(id) {
  for (const it of state.items) if (it.id === id) return it;
  for (const c of state.cache.folders.values()) {
    const f = c.items.find((it) => it.id === id);
    if (f) return f;
  }
  const mc = state.cache.messages.get(id);
  if (mc && mc.message) return mc.message;
  return null;
}

/**
 * 单一来源对齐「当前打开」高亮：列表里最多只有 state.openId 对应的一行带 active。
 * 必须遍历全部行做全量对齐，否则旧行上的 active 会残留，出现多个蓝色选择标记（BUG-1）。
 * 只切 class、不重渲染整表，避免丢失滚动位置。
 */
function syncActiveRow() {
  for (const row of Array.from(document.querySelectorAll('.list-item[data-id]'))) {
    row.classList.toggle('active', row.dataset.id === state.openId);
  }
}

function syncRowUI(id) {
  const item = findItem(id);
  for (const row of Array.from(document.querySelectorAll('.list-item[data-id]'))) {
    if (row.dataset.id !== id) continue;
    row.classList.toggle('unread', !!(item && !item.read));
    const star = row.querySelector('.star-btn');
    if (star) {
      star.classList.toggle('starred', !!(item && item.starred));
      star.textContent = item && item.starred ? '★' : '☆';
    }
  }
  syncActiveRow();
}

function applyLocalPatch(id, patch) {
  const apply = (obj) => {
    if (!obj || obj.id !== id) return;
    for (const k of Object.keys(patch)) obj[k] = patch[k];
  };
  for (const c of state.cache.folders.values()) c.items.forEach((it) => apply(it));
  state.items.forEach((it) => apply(it));
  if (currentMessage && currentMessage.id === id) {
    for (const k of Object.keys(patch)) currentMessage[k] = patch[k];
  }
  for (const c of state.cache.messages.values()) {
    if (c.message && c.message.id === id) {
      for (const k of Object.keys(patch)) c.message[k] = patch[k];
    }
    if (Array.isArray(c.thread)) {
      const t = c.thread.find((x) => x.id === id);
      if (t) for (const k of Object.keys(patch)) t[k] = patch[k];
    }
  }
  if (Array.isArray(currentThread)) {
    const t = currentThread.find((x) => x.id === id);
    if (t) for (const k of Object.keys(patch)) t[k] = patch[k];
  }
  syncRowUI(id);
  persistSoon();
}

function invalidateFolderCaches() {
  state.cache.folders.clear();
}

/* ---------------- 已打开邮件正文的内存 LRU ---------------- */

function entryBytes(entry) {
  const m = entry.message || {};
  return String(m.body_html || '').length + String(m.body_text || '').length + 512;
}

/** 写入并置为最近使用；超上限（40 封 / 2MB）时从最久未使用的一端逐出。 */
function putMessageCache(id, entry) {
  const e = { ...entry, bytes: entryBytes(entry) };
  state.cache.messages.delete(id);
  state.cache.messages.set(id, e);
  let total = 0;
  for (const v of state.cache.messages.values()) total += v.bytes || 0;
  while (state.cache.messages.size > MSG_CACHE_MAX || total > MSG_CACHE_BYTES) {
    const oldest = state.cache.messages.keys().next().value;
    if (oldest === undefined || oldest === id) break;
    total -= state.cache.messages.get(oldest).bytes || 0;
    state.cache.messages.delete(oldest);
  }
}

/** 命中即刷新 LRU 顺序（Map 的插入顺序即使用顺序）。 */
function touchMessageCache(id) {
  const v = state.cache.messages.get(id);
  if (!v) return;
  state.cache.messages.delete(id);
  state.cache.messages.set(id, v);
}

/* ---------------- 后台预下载正文 ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prefetchGen = 0;      // 递增即作废上一轮预取
let prefetchActive = null; // 正在预取的视图 token（同视图不重复启动）

/**
 * 空闲时按顺序预取当前列表里尚未缓存的正文，写入消息 LRU（并随快照落盘）。
 *
 * 约束（每条都对应一个回归用例）：
 *  - 只处理**当前列表** `state.items`，跳过已在缓存里的；上限 PREFETCH_MAX；
 *  - 顺序执行 + 间隔，不与用户点击争抢；页面不可见（document.hidden）立即暂停；
 *  - 视图切换（folder/mailbox/q）通过 token 比对立刻作废；
 *  - **绝不触碰 state.openId / detailSeq / 右侧面板** —— 预取是纯后台行为，
 *    不改变用户看到的任何东西。真正点开时走 openMessage 自己的路径。
 */
function prefetchBodies() {
  if (document.hidden) return;
  const token = folderKey();
  if (prefetchActive === token) return; // 同一视图已在预取，不重开
  prefetchActive = token;
  const gen = ++prefetchGen;
  void (async () => {
    try {
      await sleep(PREFETCH_START_DELAY_MS);
      if (gen !== prefetchGen || token !== folderKey()) return;
      // 用游标扫 state.items，而不是一开始拍一张快照：
      // 「加载更多」会把新页追加进 state.items，游标扫描能自然把它们带上。
      let cursor = 0;
      let done = 0; // 只统计真正发起的请求数，用来卡上限
      while (done < PREFETCH_MAX) {
        if (gen !== prefetchGen || token !== folderKey()) return; // 视图已切换
        if (document.hidden) return;                              // 页面不可见，暂停
        const ids = state.items.map((it) => it.id);
        if (cursor >= ids.length) break; // 当前列表已走完
        const id = ids[cursor++];
        if (state.cache.messages.has(id)) continue; // 已缓存（或期间被别的路径填上）
        done++;
        try {
          const data = await api(`/api/messages/${encodeURIComponent(id)}`);
          putMessageCache(id, {
            message: data.message,
            attachments: data.attachments || [],
            thread: data.thread || [],
            at: Date.now(),
          });
        } catch {
          // 预取失败不打扰用户：真正点开时会重新请求并给出错误态
        }
        if (done % PREFETCH_PERSIST_EVERY === 0) persistSoon();
        await sleep(PREFETCH_GAP_MS);
      }
      persistSoon();
    } finally {
      // 只在「仍是本轮」时清标记：被新视图 / 新预取顶替时，不能把后来者的标记清掉
      if (prefetchGen === gen && prefetchActive === token) prefetchActive = null;
    }
  })();
}

/* ---------------- 本地持久化缓存（localStorage，防抖 + 全链路 try/catch） ---------------- */

let persistTimer = null;

/** 读取本地快照。版本不符 / JSON 损坏 / 隐私模式禁用 localStorage 一律安全降级为 null。 */
function readPersisted() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.v !== CACHE_VERSION) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * 收集要落盘的正文：**内存 LRU 里有什么就收什么**（LRU 自身已封顶 40 封 / 2MB）。
 * Map 的迭代顺序即 LRU 顺序（最久未用在前），所以直接遍历即可得到
 * 「最久未用 → 最近使用」；恢复时按序 set 就能还原 LRU 次序。
 * 不在这里设预算 —— 超配额的退让统一交给 writePersisted（对半砍重试）。
 */
function collectPersistMessages() {
  const out = [];
  for (const [id, entry] of state.cache.messages) {
    if (entry && entry.message) out.push([id, entry]);
  }
  return out;
}

/** 写一次快照。成功返回 true；隐私模式 / 超配额（QuotaExceededError）返回 false。 */
function tryWritePersisted(payload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把当前视图（列表 + 计数 + 账号列表 + openId + 最近读过的正文）写入本地。
 * 空列表不写（避免把 loading 态落盘）。不持久化 state.selected：选中态跨刷新保留会让人困惑。
 *
 * 超配额时**对半砍重试**（保留较新的那一半），而不是一次性全丢：
 * 否则读了几十封大正文的用户，一超限就一封正文都缓存不上，与「不设上限」的意图相反。
 * 砍到一封都写不下时，最后只写列表 —— **列表缓存永远不会被正文赔进去**。
 */
function writePersisted() {
  if (!state.items.length) return;
  const base = {
    v: CACHE_VERSION,
    at: Date.now(),
    folderKey: folderKey(),
    mailbox: state.mailbox,
    folderName: state.folder,
    q: state.q,
    folder: { items: state.items, total: state.total },
    counts: state.counts,
    mailboxes: state.mailboxList,
    openId: state.openId,
  };
  // 顺序为「最久未用 → 最近使用」，所以保留尾部 = 保留较新的
  let messages = collectPersistMessages();
  while (messages.length) {
    if (tryWritePersisted({ ...base, messages })) return;
    messages = messages.slice(Math.ceil(messages.length / 2));
  }
  tryWritePersisted(base);
}

/** 防抖写入，避免读信 / 翻页 / 批量操作时高频 JSON.stringify 卡主线程。 */
function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(writePersisted, PERSIST_DEBOUNCE_MS);
}

/**
 * 启动时**同步**恢复本地快照并立即渲染（0 请求）。
 * 只恢复与当前默认视图（inbox / 无搜索）一致的列表；计数与账号列表始终可用。
 * 正文缓存独立于列表恢复 —— 即使列表不可用（上次在别的文件夹 / 搜索态），
 * 之前读过的邮件仍能立刻打开、不必重新下载。
 * 任何异常都安全降级为「没有缓存」，绝不白屏。返回是否恢复了列表内容。
 */
function restorePersisted() {
  const p = readPersisted();
  if (!p) return false;
  try {
    if (p.counts && typeof p.counts === 'object') state.counts = { ...state.counts, ...p.counts };
    if (Array.isArray(p.mailboxes)) state.mailboxList = p.mailboxes;
    if (typeof p.mailbox === 'string') state.mailbox = p.mailbox;
    if (typeof p.openId === 'string') state.openId = p.openId;
    // 落盘顺序是「最久未用 → 最近使用」，按序 set 即可还原 LRU 次序
    if (Array.isArray(p.messages)) {
      for (const pair of p.messages) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const [id, entry] = pair;
        if (typeof id !== 'string' || !entry || typeof entry !== 'object' || !entry.message) continue;
        putMessageCache(id, entry); // 复用同一套条数/字节上限与 LRU 逻辑
      }
    }
    const listOk =
      p.folder && Array.isArray(p.folder.items) && p.folder.items.length > 0 &&
      p.folderName === state.folder && p.q === '' && p.folderKey === folderKey();
    if (!listOk) return false;
    state.items = p.folder.items;
    state.itemsKey = folderKey();
    state.total = Number(p.folder.total) || p.folder.items.length;
    state.offset = p.folder.items.length;
    state.cache.folders.set(folderKey(), {
      items: [...p.folder.items],
      total: state.total,
      at: p.at || Date.now(),
      fp: folderFingerprint(p.folder.items, state.total),
    });
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 通用 ---------------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function showToast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

/**
 * 把「可能是已解析数组、也可能是库里存的 JSON 文本」的字段统一成数组。
 *
 * ⚠️ **两个接口的形态不一样，两种都必须吃得下**：
 *  - 列表接口 `/api/folders/*` 直接把库列 `to_emails` / `cc` / `bcc` 原样返回 ——
 *    它们是 **JSON 文本**（`'["a@x.com"]'`）；
 *  - 详情 / 会话接口返回的是**已解析数组**。
 *
 * 旧实现只认数组（`Array.isArray(v) ? v : []`），于是列表里的收件人恒为空 ——
 * 实测确认：出站行与草稿行全部显示成「致 (未知)」「(无收件人)」。
 * 这里与 `src/util.ts` 的 jsonArr 保持同一口径（能解析就用，解析不出来当空数组）。
 */
function jsonArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function timeLong(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 列表/会话行显示明确时间：YYYY-MM-DD HH:MM。 */
function fmtDateTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function senderLabel(item) {
  const name = item.from_name;
  const email = item.from_email;
  if (name) return name;
  if (email) return email;
  return '(未知发件人)';
}

function recipientsLabel(toList) {
  return jsonArr(toList).join(', ');
}

/** 收件人角色文案（信封卡摘要行「你是抄送 / 你是密送」角标用）。 */
const ROLE_LABEL = { to: '收件人', cc: '抄送', bcc: '密送' };

/**
 * 「我」在这封**入站**邮件里是以什么身份收到的 → `'to' | 'cc' | 'bcc' | null`。
 *
 * ⚠️ 判定顺序必须是 **cc → bcc → to**，不能反过来。原因：修复前入库的行
 * `to_emails` 存的是**投递地址（信封收件人）**，我方地址必然在里面 —— 先判 to
 * 就会把「我只是被抄送」的邮件标成「收件人」（这正是用户报障的现象）。
 * `cc` / `bcc` 两列存的始终是真实头，先看它们才不会误判。
 *
 * 修复后入库的行 `to_emails` 已是真实 `To:` 头，顺序无关；两代数据用同一条规则。
 */
function myRecipientRole(m) {
  const mine = String(m.mailbox || '').trim().toLowerCase();
  if (!mine) return null;
  const has = (list) => jsonArr(list).some((x) => String(x).trim().toLowerCase() === mine);
  if (has(m.cc)) return 'cc';
  if (has(m.bcc)) return 'bcc';
  if (has(m.to_emails)) return 'to';
  return null;
}

/**
 * 入站邮件详情要显示的「收件人」清单（= 真实 `To:` 头）。
 *
 * 两代数据：
 *  - 修复后入库：详情接口给 `delivered_to`（投递地址），`to_emails` 就是真实 To 头，直接用；
 *  - 修复前入库：`delivered_to` 显式为 `null`，`to_emails` 其实是投递地址，真实 To 头没落库
 *    → 只能把投递地址**减去 cc/bcc**（信封 = To∩本域 ∪ Cc∩本域 ∪ Bcc∩本域）。
 *    减不出来就返回空数组 —— 宁可显示「—」，也不要再把自己显示成收件人。
 *
 * 列表项（乐观渲染）没有 `delivered_to` 字段（`undefined`，不是 `null`），
 * 此时 cc/bcc 也还没拿到，减法无从谈起，直接原样返回。
 */
function inboundRecipients(m) {
  const tos = jsonArr(m.to_emails);
  if (m.delivered_to !== null) return tos;
  const others = new Set(
    [...jsonArr(m.cc), ...jsonArr(m.bcc)].map((x) => String(x).trim().toLowerCase())
  );
  return tos.filter((x) => !others.has(String(x).trim().toLowerCase()));
}

/** 入站邮件详情「收件人」一行的文案（空清单给调用方自己决定占位符）。 */
function inboundRecipientsLabel(m) {
  return recipientsLabel(inboundRecipients(m));
}

/**
 * 会话行 / 信封卡共用的「收发双方」唯一真值 → `[发件方, 收件方]`。
 *
 * ⚠️ 改这里之前先读这两条（都曾踩过）：
 *  1) 详情接口返回的**会话项**收件人字段名是 `to`（见 src/index.ts 里 thread.map），
 *     而**消息本身**用的是 `to_emails`。历史上只读 `t.to_emails` → 恒为 undefined
 *     → 会话行永远显示「我 → ?」。两个字段名都必须兼容。
 *  2) 出站不能用字面量「我」：用户要看到**实际发件信箱**，否则多身份时无法分辨是哪个信箱发的。
 */
function endpointsOf(item) {
  const mine = String(item.mailbox || '').trim();
  const tos = jsonArr(item.to_emails !== undefined ? item.to_emails : item.to);
  if (item.direction === 'inbound') {
    // 对方（有名字优先用名字） → 我方收到的信箱（mailbox 权威，回退收件人首个地址）
    return [senderLabel(item), mine || tos[0] || '?'];
  }
  // 我方实际发件信箱 → 收件人清单（全量，不截成首个地址的 local part）
  return [String(item.from_email || '').trim() || mine || '我', tos.join(', ') || '?'];
}

/** 信封卡第二行：入站「对方邮箱 · 收至 <我的信箱>」，出站「致 <收件人清单>」。 */
function envelopeSubLine(m, pending) {
  if (m.direction === 'inbound') {
    const from = String(m.from_email || '').trim();
    const mine = String(m.mailbox || '').trim();
    const parts = [];
    if (from) parts.push(from);
    // 自己发给自己的邮件两者相同，避免重复显示
    if (mine && mine.toLowerCase() !== from.toLowerCase()) parts.push(`收至 ${mine}`);
    return parts.join(' · ');
  }
  return `致 ${recipientsLabel(m.to_emails) || (pending ? '…' : '')}`;
}

function avatarChar(item) {
  if (item.direction === 'outbound') return '我';
  const name = item.from_name || '';
  const ch = (name.trim()[0] || (item.from_email || '?')[0] || '?').toUpperCase();
  return ch;
}

/* ---------------- 侧边栏 / 多邮箱 ---------------- */

function renderMailboxSelect() {
  const wrap = $('#mailbox-wrap');
  const sel = $('#mailbox-select');
  const list = state.mailboxList;
  if (list.length < 1) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  // 真值来源是 state.mailbox；sel.value 只是它的派生显示，启动恢复路径上 DOM 还可能是空的。
  // '' = 「全部邮箱」，是合法选择，必须原样保留。
  const prev = state.mailbox || '';
  sel.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = '全部邮箱';
  sel.appendChild(allOpt);
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.mailbox;
    opt.textContent = `${m.mailbox}${m.inbox_unread ? ` (${m.inbox_unread} 未读)` : ''}`;
    sel.appendChild(opt);
  }

  // 只有当前选择确实已不存在（账号被删/改名）时才回退；
  // 回退时同时更新下拉显示与 state.mailbox，二者永不脱钩（BUG-3a）。
  const keep = prev === '' || list.some((m) => m.mailbox === prev);
  const target = keep ? prev : (list.find((m) => m.inbox_unread > 0) || list[0]).mailbox;
  sel.value = target;
  state.mailbox = target;
}

function renderNav() {
  const nav = $('#folder-nav');
  nav.innerHTML = '';
  for (const f of FOLDERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'folder-item' + (f.key === state.folder ? ' active' : '');
    btn.dataset.folder = f.key;

    const label = document.createElement('span');
    label.className = 'folder-label';
    label.textContent = f.label;
    btn.appendChild(label);

    // 收件箱徽标 = 未读数；草稿徽标 = 草稿条数（草稿没有「未读」语义，两个口径不混用）
    const badgeN = f.key === 'inbox'
      ? Number(state.counts.inbox_unread) || 0
      : f.key === 'drafts'
        ? Number(state.counts.drafts_total) || 0
        : 0;
    if (badgeN > 0) {
      const badge = document.createElement('span');
      badge.className = 'folder-badge';
      badge.textContent = badgeN > 999 ? '999+' : String(badgeN);
      btn.appendChild(badge);
    }
    btn.addEventListener('click', () => openFolder(f.key));
    nav.appendChild(btn);
  }
  renderTitle();
}

/**
 * 浏览器标签标题：有新邮件时显示「(N) 收件箱」，没有未读时回退纯「收件箱」。
 *
 * 数据源与侧边栏徽标**同一个** `state.counts.inbox_unread`，且由 `renderNav()` 统一驱动 ——
 * 计数变化只有这一处落地，标题不会和徽标各说各话（也不会在切文件夹时被覆盖回默认值）。
 * 超过 999 与徽标同口径截断，避免标题被撑爆。
 */
function renderTitle() {
  const n = Number(state.counts.inbox_unread) || 0;
  document.title = n > 0 ? `(${n > 999 ? '999+' : n}) 收件箱` : '收件箱';
}

function countQuery() {
  return state.mailbox ? `?mailbox=${encodeURIComponent(state.mailbox)}` : '';
}

async function refreshCounts(force = false) {
  const c = state.cache;
  if (!force && Date.now() - c.countsAt < TTL.counts) return;
  try {
    const next = await api(`/api/counts${countQuery()}`);
    c.countsAt = Date.now();
    state.counts = next;
    renderNav();
    persistSoon();
  } catch {
    /* 静默 */
  }
}

/**
 * 拉取收件地址列表。会改变计数状态的操作（读信/标星/删除/批量/发送）后用 force=true 调用，
 * 保证下拉里的「未读」数与实际同步（BUG-3c）；非强制调用走 TTL，且同一时刻只允许一个在途请求，
 * 期间到达的请求合并为一次补拉，避免高频。
 */
async function loadMailboxes(force = false) {
  const c = state.cache;
  if (!force && Date.now() - c.mailboxesAt < TTL.mailboxes) return;
  if (c.mailboxesLoading) {
    c.mailboxesPending = true;
    return;
  }
  c.mailboxesLoading = true;
  try {
    const data = await api('/api/mailboxes');
    state.mailboxList = data.mailboxes || [];
    c.mailboxesAt = Date.now();
    renderMailboxSelect();
    persistSoon();
  } catch {
    /* 保留已有列表：一次网络抖动不该把选择器清空 */
  } finally {
    c.mailboxesLoading = false;
    if (c.mailboxesPending) {
      c.mailboxesPending = false;
      void loadMailboxes(true);
    }
  }
}

/* ---------------- 列表 ---------------- */

function folderLabel() {
  const f = FOLDERS.find((x) => x.key === state.folder);
  return f ? f.label : state.folder;
}

function renderListTitle() {
  // 明确标注口径：这里是「该文件夹总数」，与侧边栏/下拉的「未读」是不同语义，不强行统一（BUG-3d）。
  const extra = state.total ? ` · 共 ${state.total} 封` : '';
  const q = state.q ? `：搜索“${state.q}”` : '';
  $('#list-title').textContent = `${folderLabel()}${q}${extra}`;
}

function openFolder(folder) {
  state.folder = folder;
  state.selected.clear();
  state.q = '';
  const input = $('#search-input');
  if (input) input.value = '';
  state.offset = 0;
  closeMessagePane();
  closeDrawer(); // 移动端：选完文件夹收起抽屉，否则它一直挡着刚切出来的列表
  renderNav();
  renderListTitle();
  renderSelectBar();
  void loadFolder();
}

function renderList() {
  listEl.innerHTML = '';
  for (const item of state.items) listEl.appendChild(itemRow(item));
}

function afterListRender() {
  renderListTitle();
  const empty = $('#list-empty');
  if (state.items.length === 0) {
    empty.textContent = state.loading ? '加载中…' : '这里还没有邮件';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
  }
  const more = $('#list-more');
  const hasMore = state.items.length < state.total;
  more.classList.toggle('hidden', !hasMore);
  more.textContent = hasMore ? `已显示 ${state.items.length} / ${state.total} 封，点击加载更多` : '';
}

/**
 * 渲染列表区（列表 + 空态/更多 + 批量条）。
 * 收敛点：一次加载里每个阶段只调用一次，避免「loading 一次 + 数据一次 + finally 又一次」的重复重建 DOM。
 */
function paintList() {
  renderList();
  afterListRender();
  renderSelectBar();
  prefetchBodies(); // 列表画完就顺手把正文预取回来（空闲、可取消、不碰 UI）
}

/** 后台 revalidate 的比对基准：内存缓存里该视图的指纹。 */
function cachedFolderFingerprint(token) {
  const c = state.cache.folders.get(token);
  return c ? c.fp : null;
}

function fetchFolderPage(offset) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (state.q) params.set('q', state.q);
  if (state.mailbox) params.set('mailbox', state.mailbox);
  return api(`/api/folders/${state.folder}?${params}`);
}

/**
 * 拉取当前视图第 1 页。
 * - first=true：无可用缓存，走 loading 态（首屏必须等它），数据到达后渲染一次。
 * - first=false：stale-while-revalidate 的后台刷新；指纹没变就什么都不做。
 */
async function revalidateFolder(token, first) {
  let data;
  try {
    data = await fetchFolderPage(0);
  } catch (e) {
    if (token !== folderKey()) return;
    state.loading = false;
    if (first) paintList();
    if (!state.items.length) showToast(e.message, true);
    return;
  }
  if (token !== folderKey()) return; // 视图已切换，丢弃过期响应
  state.loading = false;
  const fp = folderFingerprint(data.items, data.total);
  if (!first && fp === cachedFolderFingerprint(token)) return; // 数据没变：不重渲染
  state.items = data.items;
  state.itemsKey = token;
  state.total = data.total;
  state.offset = data.items.length;
  storeFolderCache(state.items, state.total, fp);
  paintList();
  maybeAutoOpen();
  persistSoon();
}

async function loadFolder(append = false, force = false) {
  if (append) {
    if (state.loading) return;
    const token = folderKey();
    state.loading = true;
    try {
      const data = await fetchFolderPage(state.offset);
      if (token !== folderKey()) return;
      state.items = state.items.concat(data.items);
      state.total = data.total;
      state.offset += data.items.length;
      storeFolderCache(state.items, state.total);
      paintList();
      persistSoon();
    } catch (e) {
      if (!state.items.length) showToast(e.message, true);
    } finally {
      if (token === folderKey()) state.loading = false;
    }
    return;
  }

  const token = folderKey();
  const cached = state.cache.folders.get(token);

  if (!force && cached && cached.items.length) {
    // 缓存优先（不再要求「新鲜」）：立即渲染，同时在后台 revalidate
    const painted = state.itemsKey === token && folderFingerprint(state.items, state.total) === cached.fp;
    if (!painted) {
      state.items = cached.items;
      state.itemsKey = token;
      state.total = cached.total;
      state.offset = cached.items.length;
      paintList();
    }
    state.loading = false;
    maybeAutoOpen();
    persistSoon();
    void revalidateFolder(token, false);
    return;
  }

  const sameView = state.itemsKey === token && state.items.length > 0;
  if (!sameView) {
    state.items = [];
    state.itemsKey = null;
    state.total = 0;
    state.offset = 0;
    state.loading = true;
    paintList(); // loading 态渲染一次（清屏）
  }
  await revalidateFolder(token, true);
}

/** 首次进入收件箱时自动打开最新一封，方便看到详情区。 */
function maybeAutoOpen() {
  if (state.firstOpen && !state.openId && !state.q && state.folder === 'inbox' && state.items.length) {
    state.firstOpen = false;
    void openMessage(state.items[0].id);
  }
}

function starBtn(item) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'star-btn' + (item.starred ? ' starred' : '');
  b.title = item.starred ? '取消星标' : '加星标';
  b.textContent = item.starred ? '★' : '☆';
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    void toggleStar(item, b);
  });
  return b;
}

async function toggleStar(item, btn) {
  try {
    await api(`/api/messages/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ starred: !item.starred }),
    });
    const next = !item.starred;
    applyLocalPatch(item.id, { starred: next });
    btn.classList.toggle('starred', next);
    btn.textContent = next ? '★' : '☆';
    btn.title = next ? '取消星标' : '加星标';
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // 星标数计入账号计数（BUG-3c）
  } catch (e) {
    showToast(e.message, true);
  }
}

function itemRow(item) {
  // 草稿与普通邮件共用同一套列表结构（服务端把草稿也返回成同形状的行，direction='draft'），
  // 只有三处分叉：勾选框（草稿没有批量操作语义）、发件人位显示收件人、点开是写信弹窗。
  const isDraft = item.direction === 'draft';
  // thread_unread 为后端聚合字段；旧缓存/旧 fixture 里可能不存在，回退到单行的 read 状态。
  const threadUnread = item.thread_unread !== undefined ? item.thread_unread : (item.read ? 0 : 1);
  const hasUnread = threadUnread > 0;
  const row = document.createElement('div');
  row.className = 'list-item' + (hasUnread ? ' unread' : '') + (item.id === state.openId ? ' active' : '');
  row.dataset.id = item.id;

  if (!isDraft) {
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'li-check';
    chk.checked = state.selected.has(item.id);
    chk.addEventListener('click', (ev) => ev.stopPropagation());
    chk.addEventListener('change', () => {
      if (chk.checked) state.selected.add(item.id);
      else state.selected.delete(item.id);
      renderSelectBar();
    });
    row.appendChild(chk);
  }

  const main = document.createElement('div');
  main.className = 'li-main';
  const av = document.createElement('span');
  av.className = 'li-avatar';
  av.textContent = isDraft ? '稿' : avatarChar(item);
  main.appendChild(av);
  const sender = document.createElement('span');
  sender.className = 'li-sender';
  if (isDraft) sender.textContent = recipientsLabel(item.to_emails) || '(无收件人)';
  else if (item.direction === 'inbound') sender.textContent = senderLabel(item);
  else sender.textContent = `致 ${recipientsLabel(item.to_emails) || '(未知)'}`;
  main.appendChild(sender);
  if (item.direction === 'outbound' || isDraft) {
    const chip = document.createElement('span');
    chip.className = 'li-status ' + esc(item.status || 'sent');
    chip.textContent = STATUS_LABEL[item.status] || item.status || 'sent';
    main.appendChild(chip);
  }
  row.appendChild(main);

  const sub = document.createElement('div');
  sub.className = 'li-sub';
  const subject = document.createElement('span');
  subject.className = 'li-subject';
  subject.textContent = item.subject || '(无主题)';
  sub.appendChild(subject);
  const tc = item.thread_count || 1;
  if (tc > 1) {
    const badge = document.createElement('span');
    badge.className = 'li-thread-badge';
    badge.textContent = String(tc);
    sub.appendChild(badge);
  }
  if (item.attachments_count > 0) {
    const af = document.createElement('span');
    af.className = 'li-attach';
    af.textContent = '[附件]';
    sub.appendChild(af);
  }
  const preview = (item.preview || '').trim();
  if (preview) {
    const p = document.createElement('span');
    p.className = 'li-preview';
    p.textContent = preview;
    sub.appendChild(p);
  }
  row.appendChild(sub);

  const time = document.createElement('div');
  time.className = 'li-time';
  time.textContent = fmtDateTime(item.received_at);
  row.appendChild(time);

  const starWrap = document.createElement('span');
  starWrap.className = 'li-star';
  if (isDraft) {
    // 草稿没有「星标」概念，这个位置改放删除按钮（省得为草稿单独开一套行内操作）
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'star-btn draft-del';
    del.title = '删除草稿';
    del.textContent = '×';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void deleteDraftItem(item.id);
    });
    starWrap.appendChild(del);
  } else {
    starWrap.appendChild(starBtn(item));
  }
  row.appendChild(starWrap);

  row.addEventListener('click', () => {
    if (isDraft) void openDraftComposer(item.id);
    else void openMessage(item.id);
  });
  return row;
}

/** 删除一条草稿（列表上的 × 按钮）。 */
async function deleteDraftItem(id) {
  try {
    await api(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.cache.folders.clear(); // 草稿列表与侧边栏计数都变了
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadFolder(false, true);
    showToast('草稿已删除');
  } catch (e) {
    showToast(e.message, true);
  }
}

/**
 * 由 state.selected **单向派生** #select-all 的勾选态，消除「全选框 checked 与选中集合脱钩」（BUG-1b）。
 * #select-all 不再持有独立真值：所有入口只改 state.selected，再经 renderSelectBar() 收敛 UI。
 * 判定口径：pageIds = 当前页 .list-item[data-id] 的 id 集合；sel = state.selected。
 */
function syncSelectAll() {
  const box = $('#select-all');
  if (!box) return;
  const pageIds = Array.from(document.querySelectorAll('.list-item[data-id]')).map((r) => r.dataset.id);
  const sel = state.selected;
  const checked = pageIds.length > 0 && pageIds.every((id) => sel.has(id));
  box.checked = checked;
  box.indeterminate = !checked && pageIds.some((id) => sel.has(id));
}

function renderSelectBar() {
  const bar = $('#list-bulk');
  const hasSel = state.selected.size > 0;
  bar.classList.toggle('hidden', !hasSel);
  if (hasSel) {
    $('#selected-count').textContent = `已选择 ${state.selected.size} 封`;

    const actions = $('#bulk-actions');
    actions.innerHTML = '';
    const mk = (label, action, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + cls;
      b.textContent = label;
      b.addEventListener('click', () => void bulk(action));
      actions.appendChild(b);
    };
    if (state.folder === 'trash') {
      mk('还原', 'restore');
      mk('彻底删除', 'delete', 'btn-danger');
    } else {
      mk('已读', 'read');
      mk('未读', 'unread');
      mk('星标', 'star');
      mk('取消星标', 'unstar');
      mk('删除', 'trash');
    }
  }
  syncSelectAll(); // 收敛点：所有会改 state.selected 的路径都经此对齐全选框
}

async function bulk(action) {
  const ids = [...state.selected];
  if (!ids.length) return;
  try {
    await api('/api/messages/batch', {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    });
    state.selected.clear();
    invalidateFolderCaches();
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // 批量已读/星标/删除都会改变账号计数（BUG-3c）
    await loadFolder(false, true);
  } catch (e) {
    showToast(e.message, true);
  }
}

/* ---------------- 阅读面板 ---------------- */

let currentMessage = null;
let currentAttachments = [];
let currentThread = [];

/**
 * 详情「正文下载中 / 下载失败」的占位状态。
 * 列表项本身已带主题、发件人、时间、星标、方向、附件数，足够立刻画出信封卡；
 * 只有正文 / 附件明细 / 会话上下文必须等详情接口。因此点击后**同步**先渲染头部，
 * 正文位交给这个占位态，详情回来后原地替换——不阻塞点击。
 * 形如 { id, phase: 'loading' | 'error', message? }
 */
let detailPending = null;

/**
 * 详情请求序号。用户快速连点多封时，先发的响应可能后到；
 * 过期响应必须丢弃，否则会把后选的邮件覆盖成先选的那封。
 * closeMessagePane() 也会自增它，使「关闭后又被加载完成重新打开」不可能发生。
 */
let detailSeq = 0;

function closeMessagePane() {
  detailSeq++; // 作废在途详情响应
  detailPending = null;
  state.openId = null;
  currentMessage = null;
  currentAttachments = [];
  currentThread = [];
  $('#read-message').classList.add('hidden');
  $('#read-placeholder').classList.remove('hidden');
  syncActiveRow(); // 关闭后清掉残留的 active 高亮（BUG-1）
  syncLayout(); // 移动端：退出单栏详情视图，让列表重新占满
}

function isReadMode() {
  return state.openId !== null;
}

/**
 * 打开详情后同步「已读」状态（BUG-2）。
 * 服务端 GET 详情时已把 read 置 1 并把新值返回，前端若用 `!currentMessage.read` 判断会永远为假，
 * 导致本地补丁整段被跳过、列表行继续显示未读。这里改为幂等、不依赖服务端返回值：
 * 无条件把 read:1 写入 state.items / 所有文件夹缓存 / 消息缓存 / 当前行 DOM；
 * 是否刷新计数只取决于「打开前本地是否确实观察到未读」（prior 为 null 视为未知，按未读处理）。
 */
function syncOpenedReadState(message, prior) {
  if (!message || message.direction !== 'inbound') return;
  const observed = prior || findItem(message.id);
  const wasUnread = !observed || !observed.read;
  applyLocalPatch(message.id, { read: 1 });
  if (wasUnread) {
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // 账号未读数随阅读一起更新（BUG-3c）
  }
}

async function openMessage(id) {
  const cached = state.cache.messages.get(id);

  // 缓存命中：正文是不可变的，所以**无论缓存多旧都先渲染**（阅读不被网络阻塞），
  // 需要时再后台校验。这样刷新页面后重新点开读过的邮件是即时的。
  if (cached && cached.message) {
    const cacheFresh = Date.now() - cached.at < TTL.message;
    // 入站邮件若在缓存里仍是未读（用户曾手动标为未读），必须请求服务端让它落库「已读」，
    // 否则下次刷新列表又会变回未读。
    const mustRecordRead = cached.message.direction === 'inbound' && !cached.message.read;

    detailSeq++; // 已用缓存立刻出画面，作废任何在途的旧请求
    detailPending = null;
    touchMessageCache(id);
    currentMessage = cached.message;
    currentAttachments = cached.attachments || [];
    currentThread = cached.thread || [];
    state.openId = id;
    syncOpenedReadState(cached.message); // 先补本地已读态，再渲染，按钮文案才是对的
    renderRead();
    persistSoon();
    if (!cacheFresh || mustRecordRead) void revalidateMessage(id);
    return;
  }

  const prior = findItem(id); // 打开前的本地状态，用于判断是否真的发生 0→1 跃迁

  // 乐观渲染：先用列表项把头部画出来，正文位显示「正在下载」。
  // 这样点击的反馈是同步的，不会被详情请求的往返卡住主流程。
  if (prior) {
    state.openId = id;
    currentMessage = prior;
    currentAttachments = [];
    currentThread = [];
    detailPending = { id, phase: 'loading' };
    renderRead();
    syncActiveRow();
    persistSoon();
  }

  const seq = ++detailSeq;
  try {
    const data = await api(`/api/messages/${encodeURIComponent(id)}`);
    // 过期响应（用户已切走 / 已关闭 / 又点了别的邮件）直接丢弃，不覆盖当前视图
    if (seq !== detailSeq) return;
    applyDetailToView(id, data, prior);
  } catch (e) {
    if (seq !== detailSeq) return;
    if (prior) {
      // 保留已经画好的头部，只把正文位换成错误态 + 重试，不留一块空白正文
      detailPending = { id, phase: 'error', message: e.message };
      renderRead();
    }
    showToast(e.message, true);
  }
}

/** 把详情响应写进缓存并更新当前视图（正文位从「下载中」换成真实内容）。 */
function applyDetailToView(id, data, prior) {
  currentMessage = data.message;
  currentAttachments = data.attachments || [];
  currentThread = data.thread || [];
  detailPending = null;
  state.openId = id;
  putMessageCache(id, {
    message: currentMessage,
    attachments: currentAttachments,
    thread: currentThread,
    at: Date.now(),
  });
  syncOpenedReadState(currentMessage, prior);
  renderRead();
  persistSoon();
}

/**
 * 后台校验详情。正文已经用缓存渲染出来了，所以这里**不阻塞、失败静默**。
 * 用途：① 缓存已过期（read / starred / status 可能已变）② 入站未读必须让服务端落库「已读」。
 * 用户若已切走，只更新缓存与列表行，不动右侧面板。
 */
async function revalidateMessage(id) {
  let data;
  try {
    data = await api(`/api/messages/${encodeURIComponent(id)}`);
  } catch {
    return; // 后台校验失败不打扰用户：正文已经可见
  }
  putMessageCache(id, {
    message: data.message,
    attachments: data.attachments || [],
    thread: data.thread || [],
    at: Date.now(),
  });
  syncOpenedReadState(data.message, findItem(id));
  if (state.openId === id && !detailPending) {
    currentMessage = data.message;
    currentAttachments = data.attachments || [];
    currentThread = data.thread || [];
    renderRead();
  }
  persistSoon();
}

function readBtn(label, fn, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

async function setFlag(key, value) {
  if (!currentMessage) return;
  try {
    await api(`/api/messages/${encodeURIComponent(currentMessage.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ [key]: value }),
    });
    applyLocalPatch(currentMessage.id, { [key]: value, read: key === 'read' ? value : currentMessage.read });
    renderRead();
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // 账号未读数随标记一起更新（BUG-3c）
  } catch (e) {
    showToast(e.message, true);
  }
}

async function deleteFromRead() {
  if (!currentMessage) return;
  try {
    await api(`/api/messages/${encodeURIComponent(currentMessage.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ deleted: true }),
    });
    invalidateFolderCaches();
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true); // 删除会改变账号计数（BUG-3c）
    showToast('已移入已删除');
    closeMessagePane();
    void loadFolder(false, true);
  } catch (e) {
    showToast(e.message, true);
  }
}

function envelopeDetailToggle(btn, lines) {
  const show = !lines.classList.contains('show');
  lines.classList.toggle('show', show);
  btn.textContent = show ? '收起详情' : '查看详情';
}

function metaLines() {
  const m = currentMessage;
  const lines = document.createElement('div');
  lines.className = 'env-detail-lines';
  const add = (k, v) => {
    const d = document.createElement('div');
    const kk = document.createElement('span');
    kk.className = 'k';
    kk.textContent = k;
    d.appendChild(kk);
    const vv = document.createElement('span');
    vv.textContent = v || '—';
    d.appendChild(vv);
    lines.appendChild(d);
  };
  if (m.direction === 'inbound') {
    add('发件人', m.from_name ? `${m.from_name} <${m.from_email || ''}>` : (m.from_email || ''));
    // ⚠️ 不能直接显示 to_emails：修复前的数据里它是投递地址（信封），会显示成用户自己。
    // 口径统一走 inboundRecipients()（真实 To: 头）。
    add('收件人', inboundRecipientsLabel(m));
    // 抄送/密送只在有内容时列出 —— 与出站分支同一口径。入站邮件绝大多数没有抄送，
    // 无条件列出会给每一封都白多一行「抄送 —」。
    if (jsonArr(m.cc).length) add('抄送', jsonArr(m.cc).join(', '));
    if (jsonArr(m.bcc).length) add('密送', jsonArr(m.bcc).join(', '));
    // ⛔ 这里曾经还有三行，2026-10-08 第三轮按用户要求删掉（都是纯重复，不是信息丢失）：
    //   · 「收件地址」= m.mailbox —— 信封卡副标题已经写了「收至 <mailbox>」（`envelopeSubLine()`，
    //      而且自己发给自己时会自动省略）；侧边栏/收件箱上下文本身也在说明「这是哪个信箱」。
    //   · 「你的身份」= ROLE_LABEL[role] —— 被抄送/密送时，默认可见的摘要行上就有
    //      「你是抄送 / 你是密送」角标；是收件人时「收件人」那一行里就有自己。两条路径全覆盖。
    //   · 「时间」= timeLong() —— 信封卡右上角 fmtDateTime() 渲染的是**同一格式的同一串字符**
    //      （这两个函数是逐字相同的实现），零增量信息。
    //   ⚠️ ROLE_LABEL / myRecipientRole() 仍被摘要行角标使用，**不能跟着一起删**。
  } else {
    add('发件人', m.from_email || m.mailbox || '');
    add('收件人', jsonArr(m.to_emails).join(', '));
    // 抄送/密送只在有内容时列出，避免每封都多两行「—」
    if (jsonArr(m.cc).length) add('抄送', jsonArr(m.cc).join(', '));
    if (jsonArr(m.bcc).length) add('密送', jsonArr(m.bcc).join(', '));
    add('状态', STATUS_LABEL[m.status] || m.status || '—');
  }
  return lines;
}

function renderRead() {
  const m = currentMessage;
  if (!m) return;
  const isInbound = m.direction === 'inbound';
  // 正文是否仍在下载（或下载失败）。头部字段来自列表项，只有正文/附件明细依赖详情接口。
  const pending = detailPending && detailPending.id === m.id ? detailPending : null;

  $('#read-placeholder').classList.add('hidden');
  $('#read-message').classList.remove('hidden');
  readEl.innerHTML = '';
  const isOpen = () => state.openId === m.id && currentMessage === m;

  // 主题
  const subjectWrap = document.createElement('div');
  subjectWrap.className = 'mail-subject';
  const h1 = document.createElement('h1');
  h1.textContent = m.subject || '(无主题)';
  subjectWrap.appendChild(h1);
  const sStar = document.createElement('button');
  sStar.type = 'button';
  sStar.className = 'subj-star' + (m.starred ? ' starred' : '');
  sStar.textContent = m.starred ? '★' : '☆';
  sStar.title = m.starred ? '取消星标' : '加星标';
  sStar.addEventListener('click', () => {
    if (!isOpen()) return;
    void setFlag('starred', !m.starred);
  });
  subjectWrap.appendChild(sStar);
  readEl.appendChild(subjectWrap);

  // 换一封邮件时把附件预览浮层收掉：renderRead 是详情内容的**唯一出口**，放这里天然不漏
  closeAttachmentPreview();

  // 会话上下文
  if (currentThread.length > 1) readEl.appendChild(threadPanel());

  // 信封卡
  const env = document.createElement('div');
  env.className = 'mail-card mail-envelope';

  const top = document.createElement('div');
  top.className = 'env-top';

  const avatar = document.createElement('span');
  avatar.className = 'env-avatar';
  avatar.textContent = avatarChar(m);
  top.appendChild(avatar);

  const who = document.createElement('div');
  who.className = 'env-who';
  const nameRow = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'who-name';
  // 出站显示**实际发件信箱**（不是字面量「我」），入站显示对方；口径统一走 endpointsOf。
  name.textContent = endpointsOf(m)[0];
  nameRow.appendChild(name);
  if (!isInbound && m.status) {
    const chip = document.createElement('span');
    chip.className = 'mail-status-chip ' + esc(m.status);
    chip.textContent = STATUS_LABEL[m.status] || m.status;
    nameRow.appendChild(chip);
  }
  who.appendChild(nameRow);
  const emailLine = document.createElement('div');
  emailLine.className = 'who-email';
  emailLine.textContent = envelopeSubLine(m, pending);
  who.appendChild(emailLine);
  top.appendChild(who);

  const date = document.createElement('div');
  date.className = 'env-date';
  date.textContent = fmtDateTime(m.received_at);
  top.appendChild(date);
  env.appendChild(top);

  // 操作按钮
  const actions = document.createElement('div');
  actions.className = 'env-actions';
  if (isInbound) {
    actions.appendChild(readBtn('回复', () => { if (isOpen()) openReplyComposer(); }, 'btn-primary'));
  }
  // 转发对入站 / 出站邮件都开放（自己的已发送邮件同样可以转给别人）
  actions.appendChild(readBtn('转发', () => { if (isOpen()) openForwardComposer(); }));
  actions.appendChild(readBtn(m.read ? '标为未读' : '标为已读', () => { if (isOpen()) void setFlag('read', !m.read); }));
  actions.appendChild(readBtn('删除', () => { if (isOpen()) void deleteFromRead(); }));
  env.appendChild(actions);

  // 详情摘要 + 展开行
  const toLine = document.createElement('div');
  toLine.className = 'env-details';
  const toggle = document.createElement('a');
  toggle.className = 'toggle-detail';
  toggle.textContent = '查看详情';
  const lines = metaLines();
  // 入站显示**真实 To: 头**（不是投递地址），否则被抄送时会显示成用户自己
  const toText = isInbound ? inboundRecipientsLabel(m) : recipientsLabel(m.to_emails);
  toLine.innerHTML = `<b>收件人：</b>${esc(toText || (pending ? '…' : '—'))} `;
  // 「收件人：—」只有一种成因：这封是**修复前**入库的（`delivered_to` 仍为 null，真实 To 头没落库），
  // 且投递地址减掉 cc/bcc 后为空。能不能补回来取决于上游保留期 —— Resend 只留 30 天，
  // 2026-10-08 回填后仍有 10 行已超期、永久取不回。给个 title 说明，免得被当成 bug 反复排查。
  if (isInbound && !toText && !pending && m.delivered_to === null) {
    toLine.title = '这封邮件入库时未保存原始收件人（To:）信息，且已超出上游保留期，无法恢复';
  }
  // 我只是被抄送/密送时，在默认可见的这一行就给个角标 —— 详情行是折叠的，藏在那里等于没说
  const role = isInbound ? myRecipientRole(m) : null;
  if (role === 'cc' || role === 'bcc') {
    const chip = document.createElement('span');
    chip.className = 'env-role-chip';
    chip.textContent = `你是${ROLE_LABEL[role]}`;
    chip.title = `这封邮件不是发给你的，你是以${ROLE_LABEL[role]}身份收到的`;
    toLine.appendChild(chip);
    toLine.appendChild(document.createTextNode(' '));
  }
  toggle.addEventListener('click', () => envelopeDetailToggle(toggle, lines));
  toLine.appendChild(toggle);
  env.appendChild(toLine);
  env.appendChild(lines);

  // 附件
  if (currentAttachments.length) {
    const box = document.createElement('div');
    box.className = 'attachments';
    const title = document.createElement('div');
    title.className = 'att-title';
    title.textContent = `${currentAttachments.length} 个附件`;
    box.appendChild(title);
    const list = document.createElement('div');
    list.className = 'att-list';
    for (const a of currentAttachments) {
      list.appendChild(attachmentChip(a));
    }
    box.appendChild(list);
    env.appendChild(box);
  } else if (pending && m.attachments_count > 0) {
    // 附件明细要等详情接口，但列表项已带附件数量：先把数量显示出来，
    // 否则用户在下载期间会以为这封邮件没有附件。
    const box = document.createElement('div');
    box.className = 'attachments';
    const title = document.createElement('div');
    title.className = 'att-title';
    title.textContent = `${m.attachments_count} 个附件（随正文下载中…）`;
    box.appendChild(title);
    env.appendChild(box);
  }
  readEl.appendChild(env);

  // 正文：下载中 / 下载失败时用占位态，不渲染一块空正文
  const bodyCard = document.createElement('div');
  bodyCard.className = 'mail-body';
  if (pending) {
    bodyCard.classList.add('mail-body-pending');
    bodyCard.appendChild(detailPlaceholder(pending));
  } else {
    bodyCard.innerHTML = buildBodyHtml(m);
    bodyCard.querySelectorAll('a').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }
  readEl.appendChild(bodyCard);

  syncRowUI(m.id);
  // 详情渲染完再对齐布局。放在这里而不是 openMessage 的每个分支里各加一次：
  // renderRead() 是详情内容出现的**唯一出口**（缓存命中 / 乐观渲染 / 详情返回都走它），
  // 放这里天然不会漏。
  syncLayout();
}

/**
 * 正文位的占位：下载中显示转圈 + 文案；失败显示原因 + 重试。
 * 两种情况都**保留信封卡**，用户始终能看到主题 / 发件人 / 时间。
 */
function detailPlaceholder(pend) {
  const wrap = document.createElement('div');
  wrap.className = 'body-pending' + (pend.phase === 'error' ? ' is-error' : '');
  if (pend.phase === 'loading') {
    const spin = document.createElement('span');
    spin.className = 'spinner';
    spin.setAttribute('aria-hidden', 'true');
    wrap.appendChild(spin);
  }
  const txt = document.createElement('div');
  txt.className = 'body-pending-text';
  txt.setAttribute('role', 'status');
  txt.textContent = pend.phase === 'error' ? `正文加载失败：${pend.message}` : '正在下载邮件正文…';
  wrap.appendChild(txt);
  if (pend.phase === 'error') {
    wrap.appendChild(readBtn('重试', () => { void openMessage(pend.id); }));
  }
  return wrap;
}

/**
 * 该会话行是否代表「当前正在看的那封邮件」。
 *
 * 服务端会把「同一封物理邮件的回环副本」折叠掉（用 `copy_ids` 挂在留存行上，
 * 见 src/repo.ts 的 foldLoopbackCopies）—— 典型场景：我从 bingfeng@ 发信并抄送
 * zhanglili@，这封信又被投递回本账号的 zhanglili@，于是库里既有出站副本、又有入站副本。
 * 此时若用户打开的正是**被折叠的那份**（例如从 zhanglili@ 的收件箱点进来），
 * 只比 id 会导致面板里一行都不高亮，看起来像「我打开的那封不见了」。
 */
function isCurrentThreadRow(t) {
  if (!currentMessage) return false;
  if (t.id === currentMessage.id) return true;
  return jsonArr(t.copy_ids).includes(currentMessage.id);
}

function threadPanel() {
  const panel = document.createElement('div');
  panel.className = 'mail-card rm-thread';
  const head = document.createElement('div');
  head.className = 't-head';
  head.textContent = `会话 · ${currentThread.length} 封`;
  panel.appendChild(head);

  for (const t of currentThread) {
    const isUnread = !t.read && !t.deleted;
    const isCurrent = isCurrentThreadRow(t);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 't-item' +
      (isCurrent ? ' current' : '') +
      (isUnread ? ' unread' : '');

    if (isUnread) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      btn.appendChild(dot);
    }
    const sender = document.createElement('span');
    sender.className = 't-sender';
    const senderText = displayThreadSender(t);
    sender.textContent = senderText;
    // 会话行宽度有限，长地址会被省略号截断；悬停给出完整收发双方。
    sender.title = senderText;
    btn.appendChild(sender);

    const tag = document.createElement('span');
    tag.className = 't-tag ' + (t.direction === 'inbound' ? 'inbound' : '');
    tag.textContent = t.direction === 'inbound' ? '收' : '发';
    btn.appendChild(tag);

    const subject = document.createElement('span');
    subject.className = 't-subject';
    subject.textContent = t.subject || '(无主题)';
    btn.appendChild(subject);

    const time = document.createElement('span');
    time.className = 't-time';
    time.textContent = fmtDateTime(t.received_at);
    btn.appendChild(time);

    btn.addEventListener('click', () => {
      // 已经是当前这封（含「它就是被折叠的副本」）就不重复打开
      if (!isCurrentThreadRow(t)) void openMessage(t.id);
    });
    panel.appendChild(btn);
  }
  return panel;
}

/** 会话行的收发方文案：`发件方 → 收件方`（口径见 endpointsOf）。 */
function displayThreadSender(t) {
  const [from, to] = endpointsOf(t);
  return `${from} → ${to}`;
}

function buildBodyHtml(m) {
  const cidMap = {};
  for (const a of currentAttachments) {
    if (a.content_id) cidMap[a.content_id.toLowerCase()] = a.url;
    cidMap[a.id.toLowerCase()] = a.url;
  }
  if (m.body_html) return sanitizeHtml(m.body_html, cidMap);
  return `<pre class="text">${esc(m.body_text || '')}</pre>`;
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------------- 附件：单击预览 + 独立下载 ----------------
 *
 * 用户诉求：已知格式（图片 / 视频 / PDF / 纯文本…）点一下就能看，下载另给一个按钮。
 *
 * ⚠️ **前端 `attachmentKind()` 与后端 `repo.isInlinePreviewType()` 必须同一口径**：
 * 前端据此决定「点开是预览还是提示下载」，后端据此决定 `Content-Disposition` 是
 * inline 还是 attachment。两边不一致会出现「浮层开了、后端却让浏览器下载」的割裂。
 * 改一边必须改另一边（composer-cc-forward 套件有断言直接比对两份清单）。
 *
 * **SVG 明确不预览**：SVG 能内嵌 `<script>`，内联进本应用的同源上下文等于 XSS。
 * 后端同样把它降级成下载。
 */

/** 可内嵌预览的非 image/video/audio 类型（与后端 isInlinePreviewType 保持一致）。 */
const INLINE_PREVIEW_TYPES = ['application/pdf', 'text/plain', 'text/csv', 'text/markdown', 'application/json'];

/** 附件类型 → 预览方式：`image | video | audio | pdf | text | none`。 */
function attachmentKind(a) {
  const t = String((a && a.content_type) || '').toLowerCase().split(';')[0].trim();
  if (!t) return 'none';
  if (t === 'image/svg+xml') return 'none';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t === 'application/pdf') return 'pdf';
  if (INLINE_PREVIEW_TYPES.indexOf(t) >= 0) return 'text';
  return 'none';
}

/** 预览地址：不带参数，后端按类型给 inline。 */
function attachmentUrl(a) {
  return String((a && a.url) || '');
}

/** 下载地址：`?dl=1` 强制 attachment（否则 PDF/图片会被浏览器就地打开而不是存盘）。 */
function attachmentDownloadUrl(a) {
  const url = attachmentUrl(a);
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'dl=1';
}

/** 附件 chip：文件名可点（预览），右侧独立「下载」按钮。 */
function attachmentChip(a) {
  const kind = attachmentKind(a);
  const chip = document.createElement('span');
  chip.className = 'att-chip';
  chip.dataset.kind = kind;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'att-open';
  open.title = kind === 'none' ? '该格式不支持在线预览，请点右侧「下载」' : '点击预览';
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = a.filename;
  nm.title = a.filename;
  open.appendChild(nm);
  open.addEventListener('click', () => openAttachmentPreview(a));
  chip.appendChild(open);

  const sz = document.createElement('span');
  sz.className = 'sz';
  sz.textContent = fmtSize(a.size);
  chip.appendChild(sz);

  const dl = document.createElement('a');
  dl.className = 'att-dl';
  dl.href = attachmentDownloadUrl(a);
  dl.setAttribute('download', a.filename || '');
  dl.title = '下载';
  dl.textContent = '下载';
  chip.appendChild(dl);

  return chip;
}

/** 预览请求序号：关闭 / 换一个附件后，旧的异步文本回调不许再写进浮层。 */
let attPreviewSeq = 0;

/** 关掉预览浮层。返回「本次是否真的关了」，供 Esc 处理器判断要不要继续往下传。 */
function closeAttachmentPreview() {
  const box = $('#att-preview');
  if (!box || box.classList.contains('hidden')) return false;
  box.classList.add('hidden');
  const body = $('#att-preview-body');
  // 清空内容：`<video>` / `<audio>` 只有在被移出文档后才会停止继续加载
  if (body) body.innerHTML = '';
  attPreviewSeq++;
  return true;
}

function openAttachmentPreview(a) {
  const kind = attachmentKind(a);
  if (kind === 'none') {
    showToast('该格式不支持在线预览，请点「下载」保存后打开', true);
    return;
  }
  const box = $('#att-preview');
  const body = $('#att-preview-body');
  if (!box || !body) return;
  const seq = ++attPreviewSeq;

  const name = $('#att-preview-name');
  if (name) name.textContent = a.filename || '';
  const dl = $('#att-preview-dl');
  if (dl) dl.href = attachmentDownloadUrl(a);

  const url = attachmentUrl(a);
  body.innerHTML = '';
  let node;
  if (kind === 'image') {
    node = document.createElement('img');
    node.src = url;
    node.alt = a.filename || '';
  } else if (kind === 'pdf') {
    // PDF 交给浏览器内置查看器：iframe 内嵌，不离开当前页面
    node = document.createElement('iframe');
    node.src = url;
    node.title = a.filename || 'PDF 预览';
  } else if (kind === 'video') {
    node = document.createElement('video');
    node.src = url;
    node.controls = true;
  } else if (kind === 'audio') {
    node = document.createElement('audio');
    node.src = url;
    node.controls = true;
  } else {
    // 文本类自己拉回来渲染：用 iframe 会让浏览器把它当独立页面加载，样式和交互都不受控
    node = document.createElement('pre');
    node.className = 'att-preview-text';
    node.textContent = '加载中…';
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((txt) => {
        if (seq === attPreviewSeq) node.textContent = txt;
      })
      .catch(() => {
        if (seq === attPreviewSeq) node.textContent = '（内容加载失败，请用「下载」按钮保存后打开）';
      });
  }
  body.appendChild(node);
  box.classList.remove('hidden');
}

function setupAttachmentPreview() {
  const box = $('#att-preview');
  if (!box) return;
  const close = $('#att-preview-close');
  if (close) close.addEventListener('click', closeAttachmentPreview);
  // 点浮层空白（不是内容盒）关闭
  box.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAttachmentPreview();
  });
  // Esc 关预览。**必须挂在捕获阶段**并 stopPropagation：
  // 全局那个 Esc 处理器（收抽屉 / 确认框 / 关写信弹窗）在 setupEvents 里，而那两个 vm 套件
  // 会把 setupEvents 中间那段整段抽出来单独执行 —— 在那里调用本模块的函数会直接
  // ReferenceError 打挂套件。挂捕获阶段还有个好处：预览是最外层浮层，Esc 天然优先，
  // 预览关掉后事件不再下传，不会顺手把抽屉也关了。
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') return;
      if (closeAttachmentPreview()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
}

/* ---------------- HTML 清洗 ---------------- */

const SAFE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CENTER', 'CODE', 'DD', 'DEL', 'DIV', 'DL', 'DT',
  'EM', 'FONT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'INS', 'LI', 'OL',
  'P', 'PRE', 'Q', 'S', 'SECTION', 'SMALL', 'SPAN', 'STRONG', 'STRIKE', 'SUB', 'SUP',
  'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'TT', 'U', 'UL',
]);
const ATTR_ALLOW = {
  A: new Set(['href', 'title']),
  IMG: new Set(['src', 'width', 'height', 'alt']),
  TABLE: new Set(['border', 'cellpadding', 'cellspacing', 'width', 'align', 'bgcolor']),
  TD: new Set(['colspan', 'rowspan', 'width', 'align', 'valign', 'bgcolor']),
  TH: new Set(['colspan', 'rowspan', 'width', 'align', 'valign', 'bgcolor']),
  TR: new Set(['align', 'valign', 'bgcolor']),
  FONT: new Set(['color', 'size', 'face']),
  BLOCKQUOTE: new Set(['type']),
  P: new Set(['align']),
  DIV: new Set(['align']),
};

function sanitizeHtml(html, cidMap) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.body
    .querySelectorAll('script,style,iframe,frame,object,embed,meta,link,base,form,input,button,select,textarea,svg,math,video,audio,source,track,template,noscript')
    .forEach((el) => el.remove());

  const all = Array.from(doc.body.querySelectorAll('*'));
  for (const el of all.reverse()) {
    const tag = el.tagName.toUpperCase();
    if (!SAFE_TAGS.has(tag)) {
      unwrap(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const allow = ATTR_ALLOW[tag] || new Set();
      if (!allow.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      const value = attr.value;
      if (name === 'href') {
        if (!/^(https?:|mailto:)/i.test(value)) {
          el.removeAttribute('href');
          continue;
        }
        el.setAttribute('href', value);
      }
      if (name === 'src') {
        const trimmed = value.trim();
        const m = /^cid:(.*)$/i.exec(trimmed);
        if (m) {
          const key = m[1].replace(/[<>]/g, '').trim().toLowerCase();
          const url = cidMap[key];
          if (url) el.setAttribute('src', url);
          else el.remove();
        } else if (!/^(https?:|data:image\/)/i.test(trimmed)) {
          el.removeAttribute('src');
        } else {
          el.setAttribute('src', trimmed);
        }
      }
    }
  }
  return doc.body.innerHTML;
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/* ---------------- 写信 / 回复 / 附件 / 富文本 ---------------- */

function plainToHtmlText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => esc(l))
    .join('<br>');
}

function isRich() {
  return state.composing && state.composing.rich === true;
}

/**
 * 解析收件人输入：逗号 / 分号（含中文全角）/ 空白均为分隔符，
 * 每段 trim 后去空，再按小写去重（保留首次出现的写法）。
 * 与后端 parseRecipient() 的字符串分支同一口径，避免前后端解析结果漂移。
 */
function parseRecipients(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw == null ? '' : raw).split(/[,;，；\s]+/)) {
    const addr = part.trim();
    const key = addr.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/** 更新「合并发送」提示：勾选且收件人 > 1 时显示将分别发送的封数，否则清空。 */
function updateMergeHint() {
  const n = parseRecipients($('#f-to').value).length;
  $('#merge-hint').textContent = $('#f-merge').checked && n > 1 ? `将分别单独发送给 ${n} 位收件人` : '';
}

/* ---------------- 收件人联想（本地联系人） ---------------- */

const RECIPIENT_FIELDS = ['#f-to', '#f-cc', '#f-bcc'];
const SUGGEST_MAX = 8;

/** 当前联想状态；field 为 null 表示下拉未打开。 */
let addrSuggest = { field: null, items: [], index: -1, query: '', start: 0, end: 0 };

/** 懒加载本地联系人；失败只是联想不可用，不能影响发信，所以静默降级。 */
async function loadContacts(force = false) {
  if (state.contactsLoaded && !force) return;
  try {
    const data = await api('/api/contacts');
    state.contacts = data && Array.isArray(data.contacts) ? data.contacts : [];
    state.contactsLoaded = true;
  } catch {
    state.contacts = [];
  }
}

/**
 * 取光标所在的那一段地址（逗号 / 分号 / 空白为分隔）。
 * 返回 start/end 供替换用 —— 选中后只替换这一段，字段里其余收件人保持不动。
 */
function recipientToken(input) {
  const v = String(input.value || '');
  const caret = typeof input.selectionStart === 'number' ? input.selectionStart : v.length;
  const before = v.slice(0, caret);
  let start = 0;
  for (const d of [',', ';', '，', '；', ' ', '\t', '\n']) {
    const i = before.lastIndexOf(d);
    if (i + 1 > start) start = i + 1;
  }
  return { start, end: caret, text: before.slice(start) };
}

/**
 * 联想排序：姓名前缀 > 姓名包含 > 邮箱前缀 > 邮箱包含，同级按往来次数降序。
 * 输入 lili 时，名字里带 lili 的人排在「只是邮箱碰巧含 lili」的前面。
 */
function contactScore(c, q) {
  const name = String(c.name || '').toLowerCase();
  const email = String(c.email || '').toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if (email.startsWith(q)) return 2;
  if (email.includes(q)) return 3;
  return -1;
}

function matchContacts(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  // `|| []`：联想跑在每次按键上，任何情况下都不能让输入框抛错（联系人未加载完也是合法状态）
  for (const c of state.contacts || []) {
    const score = contactScore(c, q);
    if (score < 0) continue;
    hits.push({ c, score });
  }
  hits.sort((a, b) => a.score - b.score || (b.c.count || 0) - (a.c.count || 0) || (a.c.email < b.c.email ? -1 : 1));
  return hits.slice(0, SUGGEST_MAX).map((h) => h.c);
}

/** 转义后再把命中的那段包 <mark>（先插标签再转义会把标签一起转掉）。 */
function highlightMatch(text, query) {
  const t = String(text == null ? '' : text);
  const q = String(query || '');
  const i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return esc(t);
  return `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`;
}

/**
 * 联想下拉的几何：**宽度不跟随输入框**。
 *
 * 输入框在手机上只有一百多像素（收件人那行还要和别的控件分宽度），跟着它走会把
 * `zhanglili@notionmanager.com` 这类邮箱截断成看不见。改为铺满写信弹窗的**内容宽度**
 * （左边界对齐内容左边缘，右边界对齐内容右边缘），一行就够放下完整邮箱。
 *
 * 抽成纯函数（只吃数字、不读 DOM）：jsdom 没有真实布局，clientWidth 恒为 0，
 * 直接断言 positionSuggest 只能测出「设了 0px」，测不出真正的宽度策略。
 */
function suggestBoxGeom({ hostWidth, padLeft, padRight, anchorTop, anchorHeight }) {
  const width = Math.max(0, hostWidth - padLeft - padRight);
  return { left: padLeft, top: anchorTop + anchorHeight + 4, width };
}

function positionSuggest(anchor) {
  const box = $('#addr-suggest');
  const host = $('#composer');
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(host) : null;
  const padLeft = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
  const padRight = cs ? parseFloat(cs.paddingRight) || 0 : 0;
  const g = suggestBoxGeom({
    hostWidth: host.clientWidth || 0,
    padLeft,
    padRight,
    anchorTop: anchor.offsetTop || 0,
    anchorHeight: anchor.offsetHeight || 0,
  });
  box.style.left = `${g.left}px`;
  box.style.top = `${g.top}px`;
  box.style.width = `${g.width}px`;
}

function hideSuggest() {
  addrSuggest = { field: null, items: [], index: -1, query: '', start: 0, end: 0 };
  const box = $('#addr-suggest');
  box.classList.add('hidden');
  box.innerHTML = '';
}

function paintSuggest() {
  const box = $('#addr-suggest');
  if (!addrSuggest.field || !addrSuggest.items.length) {
    hideSuggest();
    return;
  }
  box.innerHTML = '';
  addrSuggest.items.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'addr-suggest-item' + (i === addrSuggest.index ? ' active' : '');
    row.setAttribute('role', 'option');
    const nm = document.createElement('span');
    nm.className = 'nm';
    // 没有姓名时用邮箱当主标签，保证每行都有可读的主字段
    nm.innerHTML = highlightMatch(c.name || c.email, addrSuggest.query);
    row.appendChild(nm);
    if (c.name) {
      const em = document.createElement('span');
      em.className = 'em';
      em.innerHTML = highlightMatch(c.email, addrSuggest.query);
      row.appendChild(em);
    }
    // mousedown + preventDefault：点下拉项时不夺走输入框焦点（否则 blur 会先把下拉关掉）
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySuggest(i);
    });
    box.appendChild(row);
  });
  box.classList.remove('hidden');
  positionSuggest(addrSuggest.field);
}

/** 把光标所在的这一段替换为联系人的纯邮箱（其余收件人原样保留）。 */
function applySuggest(i) {
  const input = addrSuggest.field;
  const item = addrSuggest.items[i];
  if (!input || !item) return;
  const v = String(input.value || '');
  const { start, end } = addrSuggest;
  // 在末尾选中时补一个分隔符，方便接着输下一个收件人
  const insert = end >= v.length ? `${item.email}, ` : item.email;
  input.value = v.slice(0, start) + insert + v.slice(end);
  const caret = start + insert.length;
  hideSuggest();
  input.focus();
  try {
    input.setSelectionRange(caret, caret);
  } catch {
    /* 老浏览器忽略 */
  }
  // 不派发合成 input 事件（否则会立刻拿刚插入的邮箱再触发一次联想），只手工跑联动
  updateMergeHint();
}

function moveSuggest(step) {
  const n = addrSuggest.items.length;
  if (!n) return;
  addrSuggest.index = (addrSuggest.index + step + n) % n;
  paintSuggest();
}

/** 输入变化：重算光标所在段，按需显示/更新/收起下拉。 */
function refreshSuggest(input) {
  const { start, end, text } = recipientToken(input);
  const items = matchContacts(text);
  if (!items.length) {
    hideSuggest();
    return;
  }
  addrSuggest = { field: input, items, index: 0, query: text.trim(), start, end };
  paintSuggest();
}

/** 收件人字段键盘导航；下拉未打开时一律放行（不干扰正常输入，也不吃掉 Esc 关弹窗）。 */
function onRecipientKeydown(e) {
  if (!addrSuggest.field || addrSuggest.field !== e.target || !addrSuggest.items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSuggest(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSuggest(-1);
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    applySuggest(addrSuggest.index);
  } else if (e.key === 'Escape') {
    // 只收起下拉，不能顺带把整个写信弹窗关掉
    e.preventDefault();
    e.stopPropagation();
    hideSuggest();
  }
}

/** 给三个收件人字段挂上联想：输入 / 键盘导航 / 失焦收起 / 聚焦时按需拉联系人。 */
function bindRecipientSuggest() {
  for (const sel of RECIPIENT_FIELDS) {
    const input = $(sel);
    input.addEventListener('input', () => refreshSuggest(input));
    input.addEventListener('keydown', onRecipientKeydown);
    input.addEventListener('focus', () => void loadContacts());
    input.addEventListener('blur', () => {
      // 延迟收起：给下拉项的 mousedown 一个先手（正常点击路径下其实不会 blur）
      setTimeout(() => {
        if (addrSuggest.field === input) hideSuggest();
      }, 120);
    });
  }
}

/* ---------------- 抄送 / 密送展开 ---------------- */

// 用显式 id 而不是 querySelectorAll('.cc-field')：零依赖的 DOM 桩（test/compose-guard.test.js）
// 只实现了 querySelector，没有 querySelectorAll，用类选择器会让那套件直接抛错。
const CC_ROWS = ['#f-cc-row', '#f-bcc-row'];

function recipientsExpanded() {
  return !$('#f-cc-row').classList.contains('hidden');
}

function setRecipientsExpanded(show) {
  for (const sel of CC_ROWS) $(sel).classList.toggle('hidden', !show);
  $('#f-cc-toggle').textContent = show ? '－ 收起抄送 / 密送' : '＋ 抄送 / 密送';
}

/**
 * 切换抄送/密送行。**已有内容时不允许收起** —— 收起后字段仍会参与发送，
 * 用户看不见却发出去，是最容易造成误抄送的一类事故。
 */
function toggleRecipientsExpanded() {
  if (!recipientsExpanded()) {
    setRecipientsExpanded(true);
    return;
  }
  const filled = parseRecipients($('#f-cc').value).length + parseRecipients($('#f-bcc').value).length;
  if (filled) {
    showToast('抄送 / 密送里已有内容，清空后才能收起', true);
    return;
  }
  setRecipientsExpanded(false);
}

/** 打开弹窗时重置「合并发送」：取消勾选并清空提示。勾选不算用户输入，不进基线。 */
function resetMergePick() {
  $('#f-merge').checked = false;
  updateMergeHint();
}

/** 合并发送只在写信模式可用：回复模式的收件人由后端从原邮件推导，显示该控件会误导用户。 */
function setMergeRowVisible(visible) {
  $('.merge-row').classList.toggle('hidden', !visible);
}

/* ---------------- 发件人（独立一行，默认折叠） ---------------- */

/**
 * 发件人折叠态只显示一行摘要（「发件人 xxx@yyy ▾」），点开才展开下拉选择。
 *
 * 和抄送 / 密送的关键差别：收起来**不会丢内容** —— 当前发件人始终写在摘要行里，
 * 选择值也一直留在 select 上（发送时照常读取）。所以这里没有「有内容不许收起」
 * 那条限制，收起纯属省版面。
 */
function senderExpanded() {
  return !$('#f-mailbox-row').classList.contains('hidden');
}

function setSenderExpanded(show) {
  $('#f-mailbox-row').classList.toggle('hidden', !show);
  const caret = $('#f-sender-caret');
  if (caret) caret.textContent = show ? '▴' : '▾';
  $('#f-sender-toggle').setAttribute('aria-expanded', show ? 'true' : 'false');
}

/** 摘要行始终反映 select 的当前值；只有一个可选项时藏掉箭头（点开也没有可选的）。 */
function renderSenderSummary() {
  const list = composerMailboxOptions();
  const row = $('#f-sender-row');
  if (!list.length) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');
  row.classList.toggle('sender-solo', list.length < 2);
  $('#f-sender-current').textContent = $('#f-mailbox').value;
}

function toggleSenderExpanded() {
  // 只有一个发件地址时没有可选项，点开是空转
  if ($('#f-sender-row').classList.contains('sender-solo')) return;
  setSenderExpanded(!senderExpanded());
}

function composerMailboxOptions() {
  // 「(未识别)」是聚合用的展示分组，不是可发送地址，不能出现在发件人选择里。
  const list = state.mailboxList.map((m) => m.mailbox).filter((m) => m && m !== UNKNOWN_MAILBOX);
  if (state.fromAddress && !list.includes(state.fromAddress.toLowerCase())) list.unshift(state.fromAddress.toLowerCase());
  const def = state.composing && state.composing.mailbox ? state.composing.mailbox : '';
  if (def && !list.includes(def)) list.unshift(def);
  return list;
}

function renderMailboxPicker() {
  const list = composerMailboxOptions();
  const sel = $('#f-mailbox');
  if (!list.length) {
    $('#f-mailbox-row').classList.add('hidden');
    $('#f-sender-row').classList.add('hidden');
    return;
  }
  const cur = state.composing ? state.composing.mailbox : (state.mailbox || state.fromAddress || list[0]);
  sel.innerHTML = '';
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }
  sel.value = list.includes(cur) ? cur : list[0];
  if (state.composing) state.composing.mailbox = sel.value;
  // 每次打开弹窗都回到折叠态：默认只占一行，要改发件人时再点开
  setSenderExpanded(false);
  renderSenderSummary();
}

function resetComposerEditor() {
  const ed = $('#f-body-rich');
  const ta = $('#f-body');
  if (isRich()) {
    ta.classList.add('hidden');
    ed.classList.remove('hidden');
    $('#rich-toolbar').classList.remove('hidden');
  } else {
    ta.classList.remove('hidden');
    ed.classList.add('hidden');
    $('#rich-toolbar').classList.add('hidden');
  }
}

/**
 * 打开写信弹窗的公共收尾。三个入口（写信 / 回复 / 转发）只在「预填什么、显示哪些控件」上不同，
 * 其余（清空、渲染发件人、记录基线、显示弹窗）必须完全一致 —— 分开写迟早漂移成
 * 「回复能联想、转发不能」这类只在某个模式出现的怪问题。
 */
function openComposerShell(opts) {
  const {
    mode, title, to = '', cc = '', bcc = '', subject = '', body = '',
    original = null, originalId = null, mailbox, showMerge, showQuote, focus,
    draftId = null, bodyHtml = '', rich = false,
  } = opts;

  // 草稿 id 在这里就定下来（新建或恢复草稿）：自动保存走 upsert，不必「先创建再拿 id」。
  state.composing = {
    mode,
    originalId,
    files: [],
    rich: rich === true,
    original,
    mailbox,
    draftId: draftId || newDraftId(),
  };
  draftEverSaved = Boolean(draftId); // 从草稿箱恢复的，服务端本来就有这份记录

  $('#composer-title').textContent = title;
  $('#f-to').value = to;
  $('#f-cc').value = cc;
  $('#f-bcc').value = bcc;
  $('#f-subject').value = subject;
  $('#f-body').value = body;
  $('#f-body-rich').innerHTML = bodyHtml;
  $('#f-attach-list').innerHTML = '';
  setRecipientsExpanded(Boolean(cc || bcc));
  $('#f-quote').classList.toggle('hidden', !showQuote);
  $('#f-forward-note').textContent = opts.forwardNote || '';
  hideSuggest();
  renderAttachChips();
  renderMailboxPicker();
  resetComposerEditor();
  hideDiscardConfirm(false);
  resetMergePick();
  setMergeRowVisible(!!showMerge);
  composerLastFocus = null;
  // 记录基线：预填的收件人 / 主题 / 引用正文都不算用户输入
  composerBaseline = {
    to: $('#f-to').value,
    cc: $('#f-cc').value,
    bcc: $('#f-bcc').value,
    subject: $('#f-subject').value,
    body: $('#f-body').value,
    richText: richPlainText($('#f-body-rich')),
    mailbox: $('#f-mailbox').value,
  };
  $('#modal-mask').classList.remove('hidden');
  // 会话内记住上次的浮动几何；移动端 / 没几何时这里会把内联值清空，回落到 CSS 布局
  applyComposerGeom();
  closeDrawer(); // 移动端：写信弹窗是全屏的，抽屉必须先收起
  void loadContacts(); // 联想数据懒加载，失败不影响发信
  $(focus).focus();
}

function openComposer() {
  if (!state.canSend) {
    showToast('服务端未配置发送能力（缺少 RESEND_API_KEY / SEND_FROM_ADDRESS）', true);
    return;
  }
  openComposerShell({
    mode: 'compose',
    title: '写信',
    mailbox: state.mailbox || undefined,
    showMerge: true, // 写信模式：显示合并发送
    showQuote: false,
    focus: '#f-to',
  });
}

function openReplyComposer() {
  if (!state.canSend) {
    showToast('服务端未配置发送能力', true);
    return;
  }
  const m = currentMessage;
  if (!m) return;
  const to = m.reply_to && m.reply_to.length ? m.reply_to[0] : m.from_email;
  openComposerShell({
    mode: 'reply',
    title: '回复',
    original: m,
    originalId: m.id,
    to: to || '',
    subject: /^\s*re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`,
    mailbox: m.mailbox || undefined,
    showMerge: false, // 回复模式：合并发送无意义，隐藏该控件避免误导
    showQuote: true,
    focus: '#f-body',
  });
}

/**
 * 转发：**任意方向**的邮件都能转发给任意收件人。
 * 与回复不同，收件人**不预填**（转发本来就是发给新的人），正文预填原文引用块。
 */
function openForwardComposer() {
  if (!state.canSend) {
    showToast('服务端未配置发送能力', true);
    return;
  }
  const m = currentMessage;
  if (!m) return;
  const n = forwardAttachmentCount();
  openComposerShell({
    mode: 'forward',
    title: '转发',
    original: m,
    originalId: m.id,
    subject: /^\s*fwd?\s*:/i.test(m.subject || '') ? m.subject : `Fwd: ${m.subject || ''}`,
    body: forwardQuoteText(m),
    mailbox: m.mailbox || undefined,
    showMerge: false,
    showQuote: false, // 正文里已经带了原文引用，不再需要「引用原文」按钮
    focus: '#f-to',
    forwardNote: n ? `将附带原邮件的 ${n} 个附件` : '',
  });
}

/** 转发会带上的原邮件附件数量（内联图片不算 —— 服务端也会跳过它们）。 */
function forwardAttachmentCount() {
  return currentAttachments.filter((a) => !a.inline).length;
}

/** 转发正文里的原文引用块（含转发头，纯文本）。 */
function forwardQuoteText(m) {
  const from = m.from_name ? `${m.from_name} <${m.from_email || ''}>` : (m.from_email || '—');
  const head = [
    '---------- 转发的邮件 ----------',
    `发件人: ${from}`,
    `收件人: ${jsonArr(m.to_emails).join(', ') || '—'}`,
    `主题: ${m.subject || '(无主题)'}`,
    `时间: ${timeLong(m.received_at)}`,
    '',
  ].join('\n');
  const body = (m.body_text || '').split('\n').map((l) => `> ${l}`).join('\n');
  return `${head}\n${body || '(无内容)'}\n`;
}

/* ---------------- 草稿：自动保存 ----------------
 * 需求：写了一半的邮件自动进草稿箱，关闭弹窗不再弹「是否放弃」。
 *
 * 草稿 id 在**打开弹窗时**就生成（`newDraftId()`），保存走 PUT upsert ——
 * 这样自动保存不需要「先创建拿到 id」的往返，也不会因为第一次保存失败而丢掉后续。
 *
 * 唯一真值：`state.composing.draftId`。所有保存/删除都经 `flushDraft()` 这一个出口。
 * ⚠️ 附件不随草稿持久化（见交付说明）：内存里的 base64 太大，落库会撑爆 D1 单行上限。
 *    恢复草稿时附件需要重新添加，弹窗里会给一句提示。
 */

const DRAFT_SAVE_DEBOUNCE_MS = 1200;

let draftSaveTimer = null;
/**
 * 当前这封草稿是否**已经写进过服务端**。
 * 决定「空表单关窗」要不要发 DELETE —— 从没存过的新弹窗直接不发请求，
 * 免得每次打开又关掉都在服务端留一次无意义的往返。
 */
let draftEverSaved = false;

/** 新草稿 id。优先 crypto.randomUUID（安全上下文），否则退回时间戳 + 随机串。 */
function newDraftId() {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* 非安全上下文（file:// 等）：走下面的回退 */
  }
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clearDraftTimer() {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
  }
}

/** 当前表单 → 自动保存请求体。正文按当前可见的编辑器取（与发送口径一致）。 */
function draftPayload() {
  const c = state.composing;
  if (!c) return null;
  const rich = isRich();
  const html = rich ? $('#f-body-rich').innerHTML : '';
  const text = rich ? richPlainText($('#f-body-rich')) : $('#f-body').value;
  return {
    mode: c.mode,
    source_id: c.originalId || null,
    mailbox: $('#f-mailbox').value || '',
    to: $('#f-to').value,
    cc: $('#f-cc').value,
    bcc: $('#f-bcc').value,
    subject: $('#f-subject').value,
    body: text,
    html,
    rich,
  };
}

/**
 * 是否值得存成草稿 —— 「要不要落库」的**唯一判据**。
 *
 * 口径与 `isComposerDirty()` 共用同一个内核 `contentDiffersFromBaseline()`，
 * 只差「发件人下拉」一项：
 *  - 回复/转发弹窗**预填**的收件人、主题不算「写了一半」——
 *    否则用户点开回复又关掉，草稿箱里就会多出一堆自己没写过的回信；
 *  - 只敲空格不算；只换发件人也不算（下拉位置不是邮件内容，没什么可存的）；
 *  - 加了附件算 —— 附件虽然不落库（体积超 D1 单行上限），但用户确实动过手，
 *    得让他知道东西去哪了（见 closeComposerWithDraft 的提示）。
 */
function hasDraftContent() {
  const c = state.composing;
  if (!c) return false;
  if (c.files.length > 0) return true;
  // 没有基线时退回「任一非空即算」（openComposerShell 正常总会建基线，这里是兜底）
  if (!composerBaseline) return isComposerDirty();
  return contentDiffersFromBaseline();
}

/** 草稿变化后让「草稿箱」的缓存与计数失效（当前不在草稿箱时也要，否则切过去看到旧列表）。 */
function invalidateDraftCaches() {
  // 防御：vm 套件的 sandbox 里 state.cache 没有 folders（只桩了 countsAt），
  // 裸访问会让异步保存路径抛 unhandledRejection、把整个套件打崩。
  const folders = state.cache && state.cache.folders;
  if (folders && typeof folders.keys === 'function') {
    for (const k of Array.from(folders.keys())) {
      if (k.includes('|drafts|')) folders.delete(k);
    }
  }
  state.cache.countsAt = 0;
  void refreshCounts();
}

/**
 * 落盘一份草稿快照：有内容 → PUT upsert；无内容 → DELETE（避免草稿箱里出现空条目）。
 *
 * 失败策略分两种（静默失败是这个项目最危险的 bug 类，不能一律吞掉）：
 *  - 自动保存（防抖）失败**静默** —— 不该打断写信，下次输入还会再试；
 *  - 手动关窗触发的保存失败**必须出声**（`surfaceErrors`）—— 那时弹窗已经关了，
 *    再不提示，用户的内容就真的一声不响地没了。
 */
async function saveDraftSnapshot(id, payload, hasContent, opts) {
  if (!id) return false;
  // 从没存过 + 现在也没内容 → 无事可做（空弹窗开关不该产生任何请求）
  if (!hasContent && !draftEverSaved) return true;
  try {
    if (!hasContent) {
      await api(`/api/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      draftEverSaved = false;
    } else {
      await api(`/api/drafts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      draftEverSaved = true;
    }
    invalidateDraftCaches();
    return true;
  } catch (e) {
    if (opts && opts.surfaceErrors) {
      showToast(`草稿保存失败：${e && e.message ? e.message : e}`, true);
    }
    return false;
  }
}

/** 防抖到点时的保存：从当前表单现取快照。 */
function flushDraft() {
  clearDraftTimer();
  const c = state.composing;
  if (!c || !c.draftId) return Promise.resolve();
  return saveDraftSnapshot(c.draftId, draftPayload(), hasDraftContent());
}

/** 输入防抖保存。 */
function scheduleDraftSave() {
  if (!state.composing) return;
  clearDraftTimer();
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null;
    void flushDraft();
  }, DRAFT_SAVE_DEBOUNCE_MS);
}

/**
 * 从草稿箱打开写信弹窗继续编辑。
 * 先取回完整草稿（列表接口只带摘要），回复/转发草稿还要把原邮件取回来 ——
 * 「引用原文」按钮与转发附件都依赖 `original`。
 */
async function openDraftComposer(id) {
  if (!state.canSend) {
    showToast('服务端未配置发送能力（缺少 RESEND_API_KEY / SEND_FROM_ADDRESS）', true);
    return;
  }
  let d;
  try {
    d = (await api(`/api/drafts/${encodeURIComponent(id)}`)).draft;
  } catch (e) {
    showToast(e.message, true);
    return;
  }
  if (!d) return;

  let original = null;
  if (d.source_id && d.mode !== 'new') {
    try {
      original = (await api(`/api/messages/${encodeURIComponent(d.source_id)}`)).message;
    } catch {
      /* 原邮件可能已被删除：退化成普通写信，草稿内容不丢 */
    }
  }

  const isReply = d.mode === 'reply';
  const isForward = d.mode === 'forward';
  openComposerShell({
    mode: isReply ? 'reply' : isForward ? 'forward' : 'compose',
    title: isReply ? '回复' : isForward ? '转发' : '写信',
    to: (d.to || []).join(', '),
    cc: (d.cc || []).join(', '),
    bcc: (d.bcc || []).join(', '),
    subject: d.subject || '',
    body: d.body_text || '',
    bodyHtml: d.body_html || '',
    rich: d.rich === true,
    original,
    originalId: d.source_id || null,
    mailbox: d.mailbox || undefined,
    showMerge: !isReply && !isForward,
    showQuote: isReply,
    focus: '#f-to',
    draftId: d.id,
  });
  if (isForward && original) {
    const n = forwardAttachmentCount();
    if (n) $('#f-forward-note').textContent = `将附带原邮件的 ${n} 个附件`;
  }
  showToast('已打开草稿');
}

/* 关闭写信弹窗的守卫（语义已从「放弃确认」改为「自动存草稿」，见 requestCloseComposer） */

let discardConfirmPending = false; // 确认框是否已弹出（防重入）
let composerLastFocus = null; // 确认框收起后要归还焦点的元素
let composerBaseline = null; // 打开弹窗时的表单快照，用于识别「用户实际输入」
let sendInFlight = false; // 是否正在发送，发送中禁止放弃

/** 归一化文本输入：null/undefined 视为空串，并去掉首尾空白。 */
function norm(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * 富文本编辑器的纯文本内容（忽略标签、<br>、空 div 与 &nbsp;）。
 * 只用 textContent 而不用 innerText，原因有三：
 * 1) 不依赖渲染结果，守卫与发送校验才能对同一份内容得出同一结论；
 * 2) jsdom 等测试环境没有 innerText，用 textContent 才可被自动化真实覆盖；
 * 3) 避免 CSS 伪元素占位符（.rich-editor:empty::before）污染渲染文本。
 */
function richPlainText(el) {
  return String(el.textContent || '').replace(/\u00a0/g, ' ').trim();
}

/**
 * 「相对打开弹窗时的快照，内容是否真的变了」——**不含发件人下拉**。
 *
 * 这是 `isComposerDirty()` 与 `hasDraftContent()` 的**共同内核**：
 * 两套口径一旦各写一遍就会漂移（判脏却没存、或没写却存了空草稿）。
 * 只敲空格不算输入（norm 去首尾空白）；正文只认当前可见的那个编辑器，
 * 避免隐藏编辑器里的残留造成「假脏」。
 */
function contentDiffersFromBaseline() {
  const b = composerBaseline;
  if (!b) return false;
  if (norm($('#f-to').value) !== norm(b.to)) return true;
  if (norm($('#f-cc').value) !== norm(b.cc)) return true;
  if (norm($('#f-bcc').value) !== norm(b.bcc)) return true;
  if (norm($('#f-subject').value) !== norm(b.subject)) return true;
  if (isRich()) return richPlainText($('#f-body-rich')) !== b.richText;
  return norm($('#f-body').value) !== norm(b.body);
}

/**
 * 用户是否已输入任何信息（与打开弹窗时的快照比对）。
 * 收件人 / 主题 / 发件人 / 当前可见的正文编辑器与基线不同，或已添加附件，
 * 即视为「脏」。回复弹窗预填的收件人、主题属于系统行为，不算用户输入。
 * 只敲空格不算输入；切换富文本模式本身不算脏。
 * 比 `hasDraftContent()` 多算一项「发件人下拉」——换了发信身份算用户操作，
 * 但光换发件人没有可落库的内容，所以那一项不参与「要不要存草稿」。
 */
function isComposerDirty() {
  const c = state.composing;
  if (!c) return false;
  if (c.files.length > 0) return true;
  const b = composerBaseline;
  if (!b) {
    // 兜底：没有基线时退回「任一非空即脏」
    if (norm($('#f-to').value) !== '') return true;
    if (norm($('#f-cc').value) !== '') return true;
    if (norm($('#f-bcc').value) !== '') return true;
    if (norm($('#f-subject').value) !== '') return true;
    if (isRich()) return richPlainText($('#f-body-rich')) !== '';
    return norm($('#f-body').value) !== '';
  }
  if (norm($('#f-mailbox').value) !== norm(b.mailbox)) return true;
  return contentDiffersFromBaseline();
}

function showDiscardConfirm() {
  if (discardConfirmPending) return; // 已弹出则不重复弹
  discardConfirmPending = true;
  $('#confirm-text').textContent = '这封邮件还没有发送，确定要放弃吗？已填写的内容将被丢弃。';
  $('#confirm-mask').classList.remove('hidden');
  $('#confirm-ok').focus();
}

/** 收起确认框（不关闭写信弹窗），焦点归还到用户原先编辑的位置。 */
function hideDiscardConfirm(restoreFocus = true) {
  if (!discardConfirmPending && $('#confirm-mask').classList.contains('hidden')) return;
  discardConfirmPending = false;
  $('#confirm-mask').classList.add('hidden');
  if (!restoreFocus) return;
  const el = composerLastFocus;
  if (el && document.body.contains(el) && !el.classList.contains('hidden')) {
    try {
      el.focus();
    } catch {
      /* 元素已不可聚焦，忽略 */
    }
  }
}

/**
 * 请求关闭写信弹窗：**存草稿后直接关闭，不再弹「是否放弃」**。
 *
 * 遮罩空白区点击、取消按钮、Esc 三个入口都走这里。既然写了一半的内容会自动落进草稿箱，
 * 「关窗」就不再是破坏性操作，也就没有需要用户确认的东西了。
 * 唯一仍然拦住的情况是「正在发送」—— 那时关窗会让用户误以为没发出去。
 */
function requestCloseComposer() {
  if (!state.composing) return;
  if (sendInFlight) {
    showToast('邮件正在发送中，请稍候…');
    return;
  }
  void closeComposerWithDraft();
}

/** 落草稿 → 关窗。有内容时给一句提示，让用户知道东西去哪了。 */
function closeComposerWithDraft() {
  const c = state.composing;
  if (!c) return;
  // 快照必须在 closeComposer() **之前**取：关窗会清掉 state.composing 与表单状态。
  const id = c.draftId;
  const hasContent = hasDraftContent();
  const payload = draftPayload();
  const inDraftsFolder = state.folder === 'drafts';
  // 同步关窗：点一下要立刻见效，不能等一次网络往返
  closeComposer();
  if (hasContent) showToast('已存入草稿');
  // 正停在草稿箱就刷新，让刚存下的草稿立刻出现
  if (inDraftsFolder) void loadFolder(false, true);
  // 手动关窗触发的保存：失败必须出声（此时弹窗已关，静默 = 内容无声消失）
  void saveDraftSnapshot(id, payload, hasContent, { surfaceErrors: true });
}

function closeComposer() {
  clearDraftTimer(); // 关窗后不许再有在途的自动保存定时器
  hideDiscardConfirm(false);
  hideSuggest();
  endComposerDrag(); // 关窗时若正拖着，把拖动状态一起收掉（否则 body 的类会残留）
  composerLastFocus = null;
  composerBaseline = null;
  state.composing = null;
  $('#modal-mask').classList.add('hidden');
}

/* 附件 */

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const dataUrl = String(fr.result || '');
      const idx = dataUrl.indexOf(',');
      resolve(idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl);
    };
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

async function onPickFiles(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  const c = state.composing;
  if (!c) return;
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showToast(`「${file.name}」超过 40MB 上限，已跳过`, true);
      continue;
    }
    try {
      const content = await readFileAsBase64(file);
      c.files.push({ name: file.name, type: file.type || 'application/octet-stream', size: file.size, content });
    } catch (err) {
      showToast(err.message, true);
    }
  }
  renderAttachChips();
}

function renderAttachChips() {
  const box = $('#f-attach-list');
  box.innerHTML = '';
  const files = (state.composing && state.composing.files) || [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const item = document.createElement('span');
    item.className = 'att-item';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = f.name;
    nm.title = f.name;
    item.appendChild(nm);
    const sz = document.createElement('span');
    sz.textContent = fmtSize(f.size);
    item.appendChild(sz);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '×';
    rm.title = '移除';
    rm.addEventListener('click', () => {
      state.composing.files.splice(i, 1);
      renderAttachChips();
    });
    item.appendChild(rm);
    box.appendChild(item);
  }
}

/* 富文本 */

function quoteHtml() {
  const m = state.composing && state.composing.original;
  if (!m) return '';
  const who = m.from_name || m.from_email || '';
  const date = timeLong(m.received_at);
  const text = (m.body_text || '')
    .split('\n')
    .map((l) => `&gt; ${esc(l)}`)
    .join('<br>');
  return `<blockquote>${esc(who)} ${esc(date)} 写道：<br>${text || '(无内容)'}</blockquote><br>`;
}

/** 回复引用的纯文本块（富文本模式下走 quoteHtml，两者内容口径保持一致）。 */
function quoteText() {
  const m = state.composing && state.composing.original;
  const who = (m && (m.from_name || m.from_email)) || '';
  const date = m ? timeLong(m.received_at) : '';
  const body = m && m.body_text ? m.body_text.split('\n').map((l) => `> ${l}`).join('\n') : '';
  return `${who} ${date} 写道：\n${body || '(无内容)'}\n`;
}

function insertQuote() {
  const c = state.composing;
  if (!c) return;
  if (isRich()) {
    const ed = $('#f-body-rich');
    ed.insertAdjacentHTML('beforeend', quoteHtml());
    ed.focus();
  } else {
    const ta = $('#f-body');
    const block = quoteText();
    ta.value = ta.value ? `${ta.value}\n\n${block}` : block;
    ta.focus();
  }
}

function toggleRich() {
  const c = state.composing;
  if (!c) return;
  if (!c.rich) {
    const ta = $('#f-body');
    $('#f-body-rich').innerHTML = plainToHtmlText(ta.value);
    c.rich = true;
  } else {
    const ed = $('#f-body-rich');
    $('#f-body').value = ed.innerText;
    c.rich = false;
  }
  resetComposerEditor();
}

function bindToolbar() {
  const bar = $('#rich-toolbar');
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd;
    const ed = $('#f-body-rich');
    ed.focus();
    if (cmd === 'createLink') {
      const url = prompt('链接地址 (https://…)');
      if (url) document.execCommand('createLink', false, url);
    } else {
      document.execCommand(cmd);
    }
  });
}

async function sendCompose() {
  const c = state.composing;
  if (!c) return;
  const to = parseRecipients($('#f-to').value);
  const cc = parseRecipients($('#f-cc').value);
  const bcc = parseRecipients($('#f-bcc').value);
  const subject = $('#f-subject').value.trim();
  // to / cc / bcc 任一非空即可发（只密送的邮件是合法的）
  if (!to.length && !cc.length && !bcc.length) return showToast('请填写收件人', true);

  let body = $('#f-body').value;
  let html = null;
  let htmlHasText = false;
  if (isRich()) {
    const ed = $('#f-body-rich');
    html = ed.innerHTML;
    body = ed.innerText || '';
    // 与 isComposerDirty() 共用同一个「有内容」定义，避免两套口径漂移
    htmlHasText = richPlainText(ed) !== '';
  }
  if (!body.trim() && !htmlHasText) return showToast('请填写邮件内容', true);

  // 判据是「有没有可选的发件地址」，不是「那一行有没有展开」：折叠只是收起 UI，
  // 选择值一直有效，必须照常进请求体（否则改选发件人会静默失效）。
  const mailbox = composerMailboxOptions().length ? $('#f-mailbox').value : undefined;
  // 硬防御：合并发送只对写信接口生效，绝不向 /reply 或 /forward 发 merge
  const merge = c.mode === 'compose' && $('#f-merge').checked;
  // 合并发送是「每人单独一封」，密送会让被密送者收到 N 封重复邮件 → 前端先拦，后端也会拒
  if (merge && bcc.length) return showToast('合并发送不支持密送（BCC），请取消其中一个', true);

  const payload = {
    to,
    subject,
    body: body || undefined,
    html: html && htmlHasText ? html : undefined,
    attachments: c.files.map((f) => ({ filename: f.name, content: f.content, content_type: f.type })),
  };
  if (cc.length) payload.cc = cc;
  if (bcc.length) payload.bcc = bcc;
  if (mailbox) payload.mailbox = mailbox;
  if (merge) payload.merge = true;
  // 带上草稿 id：服务端发送成功后会删掉对应草稿（全成功才删，合并发送部分失败时保留）
  if (c.draftId) payload.draft_id = c.draftId;
  // 转发：原邮件附件由服务端从 R2 复制，前端不需要把它们下载再上传一遍
  if (c.mode === 'forward') payload.include_original_attachments = true;

  const sendBtn = $('#composer-send');
  sendBtn.disabled = true;
  sendInFlight = true; // 发送中禁止放弃，避免失败时内容丢失
  try {
    const url = c.mode === 'reply'
      ? `/api/messages/${encodeURIComponent(c.originalId)}/reply`
      : c.mode === 'forward'
        ? `/api/messages/${encodeURIComponent(c.originalId)}/forward`
        : '/api/messages';
    const res = await api(url, { method: 'POST', body: JSON.stringify(payload) });

    if (merge && res && res.merge) {
      // 合并发送：可能部分失败。失败者写回收件人框，重试时只发给失败的人，
      // 不会重复投递给已成功的人；弹窗保持打开，已输入内容不丢。
      if (res.failed_count > 0) {
        const failed = res.failed || [];
        $('#f-to').value = failed.map((f) => f.to).join(', ');
        updateMergeHint();
        const first = failed[0] || {};
        showToast(`已发送 ${res.sent_count} 封，${res.failed_count} 封失败：${first.to}（${first.error}）`, true);
        return;
      }
      showToast(`已分别发送给 ${res.sent_count} 位收件人`);
    } else if (c.mode === 'forward' && res && Array.isArray(res.skipped_attachments) && res.skipped_attachments.length) {
      // 少发了附件必须说出来，不能让用户以为附件跟着走了
      showToast(`已转发，但有 ${res.skipped_attachments.length} 个原附件读取失败已跳过：${res.skipped_attachments.join('、')}`, true);
    } else {
      showToast(c.mode === 'reply' ? '回复已发送' : c.mode === 'forward' ? '邮件已转发' : '邮件已发送');
    }

    closeComposer();
    invalidateFolderCaches();
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes(true);
    if (state.folder !== 'sent') openFolder('sent');
    else void loadFolder(false, true);
  } catch (e) {
    showToast(`发送失败：${e.message}`, true);
  } finally {
    sendBtn.disabled = false;
    sendInFlight = false;
  }
}

/* ---------------- 写信弹窗：可拖动 / 可缩放 / 可最大化（仅桌面端） ----------------
 *
 * 背景：回复 / 转发时弹窗正对着原邮件，想对照着写很别扭。这里把桌面端的写信弹窗做成
 * 一个可以随手拖走、可以放大、可以最大化的浮动窗口；移动端保持原来的全屏布局。
 *
 * ⚠️ 内联 width/height 的优先级**高于**媒体查询，所以切到移动端时必须把内联几何清掉，
 * 否则会出现「手机上弹窗还是桌面尺寸」。清理由 syncLayout()（布局的唯一收敛点）驱动。
 *
 * 几何状态只有一份真值：composerGeom。
 *   null      = 不浮动 —— 沿用 CSS 的居中 + 自适应高度，即改动前的样子；
 *   {left,top,width,height} = 浮动窗口，由内联样式驱动。
 * 任何改几何的地方都必须落到 applyComposerGeom() 这一个出口，不许自己写 style。
 */

/** 浮动窗口的最小尺寸：再小就挤不下「收件人 / 正文 / 发送」三块。 */
const COMPOSER_MIN_W = 420;
const COMPOSER_MIN_H = 320;
/** 最大化时四周留的边距，免得贴着屏幕边缘。 */
const COMPOSER_MAX_GAP = 12;
/** 判定「真的在拖」的最小位移：低于它就只是点了一下标题栏。 */
const COMPOSER_DRAG_THRESHOLD = 3;

let composerGeom = null;      // { left, top, width, height } | null（见上方说明）
let composerPrevGeom = null;  // 最大化之前的几何，供「还原」用
let composerMaximized = false;
let composerDrag = null;      // 进行中的拖动 / 缩放 { mode, x, y, geom, moved }
/**
 * 最近一次 pointerdown 是否落在弹窗内部。
 *
 * 用来区分「真的点了遮罩空白」和「在弹窗里按下、把鼠标抬到遮罩上」——后者浏览器会把
 * click 派发到两者的共同祖先（也就是遮罩自己），于是 target === currentTarget 成立、
 * 弹窗被误关。拖动标题栏天然就是这种手势，所以这个区分是必需的。
 */
let composerPressInside = false;

/** 视口尺寸。与 viewportWidth() 同源；缺失时给桌面默认值，别让 NaN 传染进几何。 */
function viewportSize() {
  const w = globalThis.innerWidth;
  const h = globalThis.innerHeight;
  return {
    width: typeof w === 'number' && w > 0 ? w : 1024,
    height: typeof h === 'number' && h > 0 ? h : 768,
  };
}

/**
 * 把任意几何夹进视口。纯函数（只吃数字），便于在无布局的测试环境里直接验证策略。
 *
 * 位置夹取的目标是「**整窗**都在视口内」，而不是「标题栏露一点就行」。
 * 尺寸在上面已经夹到不超过视口，所以整窗夹进去是可行的 —— 这样标题栏和右下角
 * 缩放把手就永远都够得着。
 *
 * ⚠️ 别退化成「保证标题栏留 80px」那种写法：真实 Chromium 实测过，窗口往下拖
 * 150px 后右下角就被推到屏幕外，`elementFromPoint` 返回 null，把手既点不到也拖不动 ——
 * 用户把窗口拖到某个位置后**再也调不回来**。这是浮动窗口最经典的死锁。
 */
function clampComposerGeom(g, vp) {
  const maxW = Math.max(COMPOSER_MIN_W, vp.width - COMPOSER_MAX_GAP * 2);
  const maxH = Math.max(COMPOSER_MIN_H, vp.height - COMPOSER_MAX_GAP * 2);
  const width = Math.min(Math.max(g.width, COMPOSER_MIN_W), maxW);
  const height = Math.min(Math.max(g.height, COMPOSER_MIN_H), maxH);
  const maxLeft = Math.max(0, vp.width - width);
  const maxTop = Math.max(0, vp.height - height);
  const left = Math.min(Math.max(g.left, 0), maxLeft);
  const top = Math.min(Math.max(g.top, 0), maxTop);
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * 取 #composer 的「真实元素」。
 * 两个 vm 套件（compose-guard / mail-merge）用的是极简 DOM 桩，元素没有 style；
 * 拿不到 style 就说明不是浏览器，几何相关的代码一律跳过（返回 null 由调用方早退）。
 */
function composerBox() {
  const el = $('#composer');
  return el && el.style ? el : null;
}

/** 拖动期间给 body 加类（禁掉文字选择）。桩 DOM 的 body 没有 classList，做特性检测。 */
function setComposerDragging(on) {
  const b = document.body;
  if (!b || !b.classList) return;
  b.classList.toggle('composer-dragging', !!on);
}

function syncComposerMaxButton() {
  const btn = $('#composer-max');
  if (!btn || !btn.style) return;
  btn.textContent = composerMaximized ? '⤡' : '⤢';
  if (typeof btn.setAttribute === 'function') {
    const label = composerMaximized ? '还原大小' : '最大化';
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  }
}

/**
 * 几何的**唯一出口**：把 composerGeom 全量对齐到内联样式 + 状态类。
 * 非浮动（移动端 / 没几何）时把内联值清空，让 CSS 重新说了算。
 */
function applyComposerGeom() {
  const el = composerBox();
  if (!el) return;
  const floating = !!composerGeom && !isMobile();
  el.classList.toggle('floating', floating);

  const mask = $('#modal-mask');
  if (mask && mask.classList) mask.classList.toggle('composer-float', floating);

  const grip = $('#composer-resize');
  if (grip && grip.style && grip.classList) {
    grip.classList.toggle('hidden', !floating);
    // 把手用 fixed 定位：弹窗内部滚动时它不会被滚走（绝对定位会跟着内容跑，
    // 窗口被压到比内容还矮时就再也点不到了）。
    if (floating) {
      grip.style.left = `${composerGeom.left + composerGeom.width - 18}px`;
      grip.style.top = `${composerGeom.top + composerGeom.height - 18}px`;
    } else {
      grip.style.left = '';
      grip.style.top = '';
    }
  }

  if (floating) {
    el.style.left = `${composerGeom.left}px`;
    el.style.top = `${composerGeom.top}px`;
    el.style.width = `${composerGeom.width}px`;
    el.style.height = `${composerGeom.height}px`;
  } else {
    el.style.left = '';
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
  }
  syncComposerMaxButton();
}

/**
 * 由 syncLayout() 在断点切换 / 窗口尺寸变化时调用：
 * 重新夹取几何，并（在移动端）清掉内联值让全屏布局生效。
 */
function syncComposerWindowLayout() {
  if (!composerGeom) return;
  // 移动端只是「这份几何暂时用不上」：不夹取、也不丢弃，切回桌面端原样恢复。
  // 若在这里夹一次，窄视口会把用户挑的尺寸**永久压小**（夹取是单向的，缩回去长不回来）。
  if (!isMobile()) composerGeom = clampComposerGeom(composerGeom, viewportSize());
  applyComposerGeom();
}

/** 开始拖动 / 缩放：先把当前（可能由 CSS 决定的）几何量出来，真正移动时才固化成浮动。 */
function startComposerDrag(mode, e) {
  if (isMobile()) return false; // 移动端是全屏，不参与浮动
  const el = composerBox();
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const r = el.getBoundingClientRect();
  composerDrag = {
    mode,
    x: e.clientX,
    y: e.clientY,
    moved: false,
    geom: clampComposerGeom(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      viewportSize()
    ),
  };
  return true;
}

/** 拖动 / 缩放的位移换算。resize 只改右下角，move 只改位置。 */
function dragComposerTo(x, y) {
  const d = composerDrag;
  if (!d) return;
  if (!d.moved) {
    // 只是点了一下标题栏（没真拖动）：不进浮动，免得「点一下遮罩就变淡」
    if (Math.abs(x - d.x) + Math.abs(y - d.y) < COMPOSER_DRAG_THRESHOLD) return;
    d.moved = true;
    composerMaximized = false; // 手动拖动即退出最大化
    composerPrevGeom = null;
    setComposerDragging(true);
  }
  const vp = viewportSize();
  if (d.mode === 'move') {
    composerGeom = clampComposerGeom(
      { left: d.geom.left + (x - d.x), top: d.geom.top + (y - d.y), width: d.geom.width, height: d.geom.height },
      vp
    );
  } else {
    // 缩放的尺寸上限 = 「当前位置到视口右下角」的可用空间。
    // 少了这一步，放大时会先把窗口撑出屏幕、再被 clampComposerGeom 整体拽回左上角 ——
    // 用户看到的是「我明明只往右下拖把手，窗口却自己往左上跑」（真实 Chromium 实测踩到）。
    // 卡住尺寸、让左上角一动不动，才是符合直觉的。
    const maxW = Math.max(COMPOSER_MIN_W, vp.width - d.geom.left);
    const maxH = Math.max(COMPOSER_MIN_H, vp.height - d.geom.top);
    composerGeom = clampComposerGeom(
      {
        left: d.geom.left,
        top: d.geom.top,
        width: Math.min(d.geom.width + (x - d.x), maxW),
        height: Math.min(d.geom.height + (y - d.y), maxH),
      },
      vp
    );
  }
  applyComposerGeom();
}

function endComposerDrag() {
  if (!composerDrag) return;
  composerDrag = null;
  setComposerDragging(false);
}

/** 最大化 / 还原（还原回到最大化之前的几何）。 */
function toggleComposerMax() {
  if (isMobile()) return;
  const el = composerBox();
  if (!el || typeof el.getBoundingClientRect !== 'function') return;
  const vp = viewportSize();
  if (composerMaximized) {
    if (composerPrevGeom) composerGeom = clampComposerGeom(composerPrevGeom, vp);
    composerPrevGeom = null;
    composerMaximized = false;
  } else {
    const r = el.getBoundingClientRect();
    composerPrevGeom = clampComposerGeom(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      vp
    );
    composerGeom = clampComposerGeom(
      { left: COMPOSER_MAX_GAP, top: COMPOSER_MAX_GAP, width: vp.width - COMPOSER_MAX_GAP * 2, height: vp.height - COMPOSER_MAX_GAP * 2 },
      vp
    );
    composerMaximized = true;
  }
  applyComposerGeom();
}

/** 回到默认的居中自适应布局（放弃浮动几何）。 */
function resetComposerGeom() {
  composerGeom = null;
  composerPrevGeom = null;
  composerMaximized = false;
  applyComposerGeom();
}

/**
 * 拖动 / 缩放 / 最大化的接线。在 setupEvents() 里调用。
 * 用 pointer 事件统一鼠标与触摸；移动端由 isMobile() 早退，所以这里不必再分平台。
 */
function setupComposerWindow() {
  const head = $('#composer-head');
  const grip = $('#composer-resize');
  const maxBtn = $('#composer-max');
  const fitBtn = $('#composer-fit');

  // 标题栏上的按钮是「点」不是「拖」，别把点击当成拖动起点
  const onButton = (e) => {
    const t = e.target;
    return !!(t && typeof t.closest === 'function' && t.closest('button'));
  };

  if (head) {
    head.addEventListener('pointerdown', (e) => {
      if (onButton(e)) return;
      if (e.button != null && e.button !== 0) return;
      if (!startComposerDrag('move', e)) return;
      e.preventDefault();
    });
    head.addEventListener('dblclick', (e) => {
      if (onButton(e)) return;
      toggleComposerMax();
    });
  }
  if (grip) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      if (!startComposerDrag('resize', e)) return;
      e.preventDefault();
    });
  }
  if (maxBtn) maxBtn.addEventListener('click', toggleComposerMax);
  if (fitBtn) fitBtn.addEventListener('click', resetComposerGeom);

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('pointermove', (e) => dragComposerTo(e.clientX, e.clientY));
    document.addEventListener('pointerup', endComposerDrag);
    document.addEventListener('pointercancel', endComposerDrag);
    // 每次按下都重新记录「按在弹窗里还是遮罩上」，供遮罩的 click 处理器判断
    document.addEventListener('pointerdown', (e) => {
      const t = e.target;
      composerPressInside = !!(t && typeof t.closest === 'function' && t.closest('#composer'));
    }, true);
  }

  // 草稿自动保存：弹窗内任何输入都触发（事件委托，一次绑定覆盖全部字段与富文本编辑器）。
  // input + change 双事件：文本框/富文本走 input，下拉（发件人）与复选框只发 change。
  const composerEl = $('#composer');
  if (composerEl && typeof composerEl.addEventListener === 'function') {
    composerEl.addEventListener('input', () => scheduleDraftSave());
    composerEl.addEventListener('change', () => scheduleDraftSave());
  }
}

/* ---------------- 搜索 / 键盘 / 事件 / 同步 ---------------- */

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function setupSearch() {
  const input = $('#search-input');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = input.value.trim();
      state.selected.clear();
      state.offset = 0;
      closeMessagePane();
      void loadFolder(false, true);
    }, 400);
  });
}

function moveSelection(step) {
  if (!state.items.length) return;
  let idx = state.items.findIndex((it) => it.id === state.openId);
  if (idx === -1) idx = step > 0 ? -1 : 0;
  idx = Math.min(Math.max(idx + step, 0), state.items.length - 1);
  const target = state.items[idx];
  if (target) void openMessage(target.id);
}

function setupEvents() {
  $('#compose-btn').addEventListener('click', openComposer);
  $('#composer-cancel').addEventListener('click', requestCloseComposer);
  $('#composer-send').addEventListener('click', () => void sendCompose());
  $('#modal-mask').addEventListener('click', (e) => {
    // 按下点在弹窗内部、鼠标抬到遮罩上时，浏览器会把 click 派发到共同祖先（遮罩本身），
    // 光看 target === currentTarget 会把它当成「点空白关闭」。拖动标题栏就是这个手势，
    // 所以必须结合「按下点在哪」判断（见 composerPressInside）。
    if (composerPressInside) return;
    if (e.target === e.currentTarget) requestCloseComposer();
  });

  // 记录写信弹窗内最后获得焦点的元素，确认框收起后归还焦点
  $('#composer').addEventListener('focusin', (e) => {
    composerLastFocus = e.target;
  });

  // 放弃确认框：点空白区或「继续编辑」= 保留内容；点「放弃」= 真正关闭
  $('#confirm-cancel').addEventListener('click', () => hideDiscardConfirm());
  $('#confirm-ok').addEventListener('click', closeComposer);
  $('#confirm-mask').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideDiscardConfirm();
  });

  $('#mailbox-select').addEventListener('change', (e) => {
    state.mailbox = e.target.value || '';
    state.selected.clear();
    state.cache.countsAt = 0;
    closeMessagePane();
    void refreshCounts(true);
    void loadFolder();
  });

  $('#select-all').addEventListener('change', (e) => {
    const check = e.target.checked;
    state.selected.clear();
    if (check) for (const it of state.items) state.selected.add(it.id);
    renderList();
    renderSelectBar();
  });

  $('#list-more').addEventListener('click', () => void loadFolder(true));

  $('#f-attachments').addEventListener('change', (e) => void onPickFiles(e));
  $('#f-mode').addEventListener('click', toggleRich);
  $('#f-quote').addEventListener('click', insertQuote);
  $('#f-cc-toggle').addEventListener('click', toggleRecipientsExpanded);
  // 发件人：摘要行点开/收起；改选后摘要要跟着变（否则收起来会显示旧地址）
  $('#f-sender-toggle').addEventListener('click', toggleSenderExpanded);
  $('#f-mailbox').addEventListener('change', renderSenderSummary);
  // 合并发送：勾选状态与收件人数量都会影响提示文案
  $('#f-merge').addEventListener('change', updateMergeHint);
  $('#f-to').addEventListener('input', updateMergeHint);
  // 收件人联想：to / cc / bcc 三个字段共用一套下拉
  bindRecipientSuggest();
  bindToolbar();

  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    }
  });

  // Esc：确认框优先收起；否则请求关闭写信弹窗（无内容时直接关闭）
  // 注意：不跳过输入框，写信时按 Esc 同样生效
  // 移动端：抽屉开着时 Esc 先收抽屉（此时确认框 / 写信弹窗都还没出现，先关最外那层）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (drawerOpen) {
      e.preventDefault();
      closeDrawer();
      return;
    }
    if (discardConfirmPending) {
      e.preventDefault();
      hideDiscardConfirm();
      return;
    }
    if (!state.composing) return;
    e.preventDefault();
    requestCloseComposer();
  });

  // ---- 移动端：抽屉 + 单栏详情返回 ----
  $('#drawer-btn').addEventListener('click', () => setDrawer(!drawerOpen));
  $('#drawer-mask').addEventListener('click', closeDrawer);
  // 返回列表：closeMessagePane() 内部会 syncLayout()
  $('#read-back-btn').addEventListener('click', closeMessagePane);
  // 移动端侧边栏收进抽屉后，顶栏需要一个直接可点的写信入口
  $('#topbar-compose').addEventListener('click', openComposer);
  // 旋转 / 分屏 / 桌面端拖窗口：重新对齐布局（syncLayout 幂等）
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('resize', syncLayout);
  }

  setupSearch();
  // 写信弹窗的拖动 / 缩放 / 最大化接线。放在 setupSearch() **之后**：
  // 上面那段事件接线会被两个 vm 套件按注释标记整段抽取执行，这里不再往里塞东西。
  setupComposerWindow();
  // 列表/详情分隔条的拖动接线。同理放在抽取范围之外。
  setupSplitter();
  // 附件预览浮层（关闭按钮 / 点空白关闭；Esc 挂在全局键盘处理器里）
  setupAttachmentPreview();
}

/**
 * 定时后台同步：页面不可见直接跳过；只刷新「超过 TTL」的缓存，不做无条件 force；
 * 列表刷新在阅读态让路（避免打断阅读），数据没变时由指纹短路、不重建 DOM。
 */
async function periodicSync() {
  if (document.hidden) return;
  void refreshCounts(false); // 内部按 TTL.counts 判断
  void loadMailboxes(false); // 内部按 TTL.mailboxes 判断
  void loadInboundAlerts();  // 入站异常提示（每次同步都查，保证卡住的邮件能被看到）
  void loadBackendStatus();  // 后端状态（CF 存储/入站 + Resend 额度；存储走 TTL 缓存，很便宜）
  if (isReadMode() || state.loading) return;
  const c = state.cache.folders.get(folderKey());
  if (!c || Date.now() - c.at >= TTL.folder) void loadFolder(false, false);
}

/* ---------------- 入站异常提示（CF 入向「收了但没进收件箱」） ----------------
 * CF Email Routing 不存信，收信链路是「先落 R2 + 登记，再异步解析」；一旦解析因
 * CPU/内存（免费档 10ms）、瞬时故障或大附件而没能完成，邮件就只躺在后台 —— 用户无从知晓。
 * 这里把它显式暴露成顶部提示条：显示发件人/主题/大小/原因，并给「重试 / 下载原件」两个动作。 */

let inboundAlertsExpanded = false;

async function loadInboundAlerts() {
  let data;
  try {
    data = await api('/api/inbound/alerts');
  } catch {
    return; // 附加能力：拉取失败静默，不打扰主流程
  }
  renderInboundAlerts((data && data.alerts) || []);
}

function renderInboundAlerts(alerts) {
  const box = $('#inbound-alerts');
  if (!box) return;
  if (!alerts.length) {
    box.classList.add('hidden');
    box.textContent = '';
    return;
  }
  box.classList.remove('hidden');
  const items = alerts.map((a) => {
    const subject = a.subject
      ? `<span class="ia-subject" title="${esc(a.subject)}">${esc(a.subject)}</span>`
      : '<span class="ia-subject"><span class="ia-empty">（无主题）</span></span>';
    const metaParts = [];
    if (a.from) metaParts.push(`来自 ${esc(a.from)}`);
    if (a.to) metaParts.push(`投递给 ${esc(a.to)}`);
    if (a.size) metaParts.push(fmtSize(a.size));
    if (a.received_at) metaParts.push(fmtDateTime(a.received_at));
    const errText = a.error ? esc(a.error) : '仍在处理，或邮件过大（免费档 CPU 限制）';
    return `<li class="ia-item" data-id="${esc(a.id)}">
        <div class="ia-main">
          ${subject}
          <span class="ia-meta">${metaParts.join(' · ')}</span>
          <span class="ia-error">${errText}</span>
        </div>
        <div class="ia-actions">
          <button class="btn ia-retry" type="button">重试</button>
          <a class="btn" href="/api/inbound/alerts/${encodeURIComponent(a.id)}/raw">下载原件</a>
        </div>
      </li>`;
  }).join('');
  box.innerHTML = `<div class="ia-head">
      <span class="ia-icon" aria-hidden="true">⚠️</span>
      <span class="ia-title">有 ${alerts.length} 封邮件已收到，但还没进入收件箱</span>
      <button class="link-btn ia-toggle" type="button">${inboundAlertsExpanded ? '收起' : '查看'}</button>
    </div>
    <ul class="ia-list"${inboundAlertsExpanded ? '' : ' hidden'}>${items}</ul>`;
  if (!box.dataset.bound) {
    box.dataset.bound = '1';
    box.addEventListener('click', onInboundAlertClick);
  }
}

async function onInboundAlertClick(e) {
  const toggle = e.target.closest('.ia-toggle');
  if (toggle) {
    inboundAlertsExpanded = !inboundAlertsExpanded;
    const list = $('#inbound-alerts .ia-list');
    if (list) list.classList.toggle('hidden', !inboundAlertsExpanded);
    toggle.textContent = inboundAlertsExpanded ? '收起' : '查看';
    return;
  }
  const retry = e.target.closest('.ia-retry');
  if (!retry) return;
  const item = retry.closest('.ia-item');
  const id = item && item.dataset.id;
  if (!id) return;
  retry.disabled = true;
  retry.textContent = '重试中…';
  try {
    await api(`/api/inbound/alerts/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    showToast('已重新入队，稍后会再次尝试解析');
    setTimeout(() => void loadInboundAlerts(), 1500);
  } catch (err) {
    showToast(err.message, true);
    retry.disabled = false;
    retry.textContent = '重试';
  }
}

/* ---------------- 后端基础状态：CF（存储/入站队列）+ Resend（发信额度） ----------------
 * 一屏看清后端：CF 免费档 D1 500MB / R2 10GB、Resend 免费档 100 封/天 · 3000 封/月。
 * D1/R2 是后端估算并按 TTL 缓存；入站计数与发信额度实时。贴近上限 / 有异常积压时变色提醒。 */

async function loadBackendStatus() {
  let u;
  try {
    u = await api('/api/usage');
  } catch {
    return; // 附加能力：拉取失败静默，不打扰主流程
  }
  renderBackendStatus(u);
}

function renderBackendStatus(u) {
  const box = $('#backend-status');
  if (!box || !u || !u.d1 || !u.r2) return;
  const inbound = u.inbound || { pending: 0, alerts: 0 };
  const resend = u.resend || null;
  const percents = [u.d1.percent, u.r2.percent];
  if (resend && resend.configured) percents.push(resend.day.percent, resend.month.percent);
  const max = percents.length ? Math.max(...percents) : 0;
  box.classList.remove('hidden', 'warn', 'danger');
  if (max >= 95) box.classList.add('danger');
  else if (max >= 80) box.classList.add('warn');

  const rows = [
    `<span class="bs-row" title="${esc(`D1 约 ${fmtSize(u.d1.usedBytes)} / ${fmtSize(u.d1.limitBytes)}`)}">D1 <b>${u.d1.percent}%</b></span>`,
    `<span class="bs-row" title="${esc(`R2 约 ${fmtSize(u.r2.usedBytes)} / ${fmtSize(u.r2.limitBytes)} · ${u.r2.objects} 个对象`)}">R2 <b>${u.r2.percent}%</b></span>`,
    `<span class="bs-row${inbound.alerts ? ' bs-attn' : ''}" title="待解析 / 异常 / 累计收信">收件 <b>${inbound.pending}</b> 待处理${inbound.alerts ? ` · <b>${inbound.alerts}</b> 异常` : ''}</span>`,
  ];
  if (resend && resend.configured) {
    rows.push(
      `<span class="bs-row" title="${esc(`Resend 今日 ${resend.day.used}/${resend.day.limit} · 本月 ${resend.month.used}/${resend.month.limit}`)}">发件 <b>${resend.day.used}</b>/${resend.day.limit} · 月 <b>${resend.month.used}</b>/${resend.month.limit}</span>`
    );
  }
  box.innerHTML =
    '<span class="bs-title">后端状态</span>' +
    rows.join('') +
    `<span class="bs-note">${esc(u.approximate ? '存储为估算值' : '')}${u.approximate ? '·' : ''}贴近上限或积压会变色提醒</span>`;
}

/* ---------------- 初始化 ---------------- */

async function loadAccount() {
  try {
    const account = await api('/api/account');
    state.canSend = !!account.can_send;
    state.fromAddress = account.from_address;
    state.fromName = account.from_name;
  } catch (e) {
    showToast(e.message, true);
  }
}

async function init() {
  // 1) 同步恢复本地缓存 → 首屏 0 请求即可显示列表 / 计数徽标 / 账号下拉
  const restored = restorePersisted();
  const mailboxAtStart = state.mailbox;

  setupEvents();
  applyListWidth(loadListWidth()); // 恢复上次拖动设定的列表宽度（无自定义则为 null，走 CSS 默认）
  syncLayout(); // 先把布局状态对齐（首屏就可能落在移动端断点内）
  renderNav();
  renderMailboxSelect();
  renderListTitle();

  if (restored) {
    state.loading = false;
    paintList();
    syncActiveRow();
    if (state.openId && state.items.some((it) => it.id === state.openId)) {
      state.pendingOpenId = state.openId; // 稍后按需重开（正文若已在本地快照里就直接渲染，不会发请求）
    } else {
      state.openId = null;
    }
  } else {
    closeMessagePane();
  }

  // 2) 四个请求并发发起，不再串行 await（loadFolder 用缓存里的 mailbox，账号列表回来后若有出入再纠正）
  await Promise.all([
    loadAccount(),
    loadMailboxes(true),
    refreshCounts(true),
    loadFolder(),
    loadInboundAlerts(),
    loadBackendStatus(),
  ]);

  if (state.mailbox !== mailboxAtStart) void loadFolder(false, true); // 缓存里的账号已失效，按纠正后的账号重拉

  // 3) 恢复上次打开的邮件（仅当它仍在当前列表里）
  if (state.pendingOpenId) {
    const id = state.pendingOpenId;
    state.pendingOpenId = null;
    void openMessage(id);
  }

  setInterval(periodicSync, SYNC_MS);
  // 页面重新可见时补一次同步（隐藏期间跳过的刷新在这里补齐），并继续未完成的正文预取
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void periodicSync();
      prefetchBodies();
    }
  });
}

init();
