'use strict';

/* =========================================================
 * 邮件收件箱前端（无构建，纯原生）
 * 布局：左侧邮件清单 + 右侧详情（类 Yahoo/常见客户端）
 * 能力：多收件地址 · 会话上下文 · 附件发送 · 富文本
 * 性能：本地持久化缓存（localStorage）优先渲染 + 后台 revalidate + 静默刷新 + 定时同步
 * ========================================================= */

const FOLDERS = [
  { key: 'inbox', label: '收件箱' },
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
const CACHE_VERSION = 1;
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
  counts: { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 },
  composing: null, // { mode, originalId, files:[], rich, original, mailbox }
  canSend: false,
  fromAddress: '',
  fromName: '',
  openId: null,
  pendingOpenId: null, // 从本地缓存恢复、待列表就绪后重新打开的邮件 id
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

function jsonArr(v) {
  return Array.isArray(v) ? v : [];
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

    if (f.key === 'inbox' && state.counts.inbox_unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'folder-badge';
      badge.textContent = state.counts.inbox_unread > 999 ? '999+' : String(state.counts.inbox_unread);
      btn.appendChild(badge);
    }
    btn.addEventListener('click', () => openFolder(f.key));
    nav.appendChild(btn);
  }
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
  const row = document.createElement('div');
  row.className = 'list-item' + (item.read ? '' : ' unread') + (item.id === state.openId ? ' active' : '');
  row.dataset.id = item.id;

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

  const main = document.createElement('div');
  main.className = 'li-main';
  const av = document.createElement('span');
  av.className = 'li-avatar';
  av.textContent = avatarChar(item);
  main.appendChild(av);
  const sender = document.createElement('span');
  sender.className = 'li-sender';
  if (item.direction === 'inbound') sender.textContent = senderLabel(item);
  else sender.textContent = `致 ${recipientsLabel(item.to_emails) || '(未知)'}`;
  main.appendChild(sender);
  if (item.direction === 'outbound') {
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
  starWrap.appendChild(starBtn(item));
  row.appendChild(starWrap);

  row.addEventListener('click', () => void openMessage(item.id));
  return row;
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
    add('收件人', jsonArr(m.to_emails).join(', '));
    add('抄送', jsonArr(m.cc).join(', '));
    if (m.mailbox) add('收件地址', m.mailbox);
    add('时间', timeLong(m.received_at));
  } else {
    add('收件人', jsonArr(m.to_emails).join(', '));
    add('状态', STATUS_LABEL[m.status] || m.status || '—');
    add('时间', timeLong(m.received_at));
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
  name.textContent = isInbound ? (m.from_name || m.from_email || '(未知发件人)') : '我';
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
  emailLine.textContent = isInbound
    ? (m.from_email || '')
    : `致 ${recipientsLabel(m.to_emails) || (pending ? '…' : '')}`;
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
  actions.appendChild(readBtn(m.read ? '标为未读' : '标为已读', () => { if (isOpen()) void setFlag('read', !m.read); }));
  actions.appendChild(readBtn('删除', () => { if (isOpen()) void deleteFromRead(); }));
  env.appendChild(actions);

  // 详情摘要 + 展开行
  const toLine = document.createElement('div');
  toLine.className = 'env-details';
  const toLabel = isInbound ? '收件人' : '收件人';
  const toggle = document.createElement('a');
  toggle.className = 'toggle-detail';
  toggle.textContent = '查看详情';
  const lines = metaLines();
  toLine.innerHTML = `<b>${toLabel}：</b>${esc(recipientsLabel(m.to_emails) || (pending ? '…' : ''))} `;
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
      const chip = document.createElement('a');
      chip.className = 'att-chip';
      chip.href = a.url;
      chip.target = '_blank';
      chip.rel = 'noopener noreferrer';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = a.filename;
      nm.title = a.filename;
      chip.appendChild(nm);
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = fmtSize(a.size);
      chip.appendChild(sz);
      list.appendChild(chip);
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

function threadPanel() {
  const panel = document.createElement('div');
  panel.className = 'mail-card rm-thread';
  const head = document.createElement('div');
  head.className = 't-head';
  head.textContent = `会话 · ${currentThread.length} 封`;
  panel.appendChild(head);

  for (const t of currentThread) {
    const isUnread = !t.read && !t.deleted;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 't-item' +
      (t.id === currentMessage.id ? ' current' : '') +
      (isUnread ? ' unread' : '');

    if (isUnread) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      btn.appendChild(dot);
    }
    const sender = document.createElement('span');
    sender.className = 't-sender';
    sender.textContent = displayThreadSender(t);
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
      if (t.id !== currentMessage.id) void openMessage(t.id);
    });
    panel.appendChild(btn);
  }
  return panel;
}

function displayThreadSender(t) {
  if (t.direction === 'inbound') return senderLabel(t);
  return `我 → ${(jsonArr(t.to_emails)[0] || '').split('@')[0] || '?'}`;
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

/** 打开弹窗时重置「合并发送」：取消勾选并清空提示。勾选不算用户输入，不进基线。 */
function resetMergePick() {
  $('#f-merge').checked = false;
  updateMergeHint();
}

/** 合并发送只在写信模式可用：回复模式的收件人由后端从原邮件推导，显示该控件会误导用户。 */
function setMergeRowVisible(visible) {
  $('.merge-row').classList.toggle('hidden', !visible);
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
  const wrap = $('#f-mailbox-label');
  const sel = $('#f-mailbox');
  const list = composerMailboxOptions();
  if (!list.length) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
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

function openComposer() {
  if (!state.canSend) {
    showToast('服务端未配置发送能力（缺少 RESEND_API_KEY / SEND_FROM_ADDRESS）', true);
    return;
  }
  state.composing = { mode: 'compose', files: [], rich: false, original: null, mailbox: state.mailbox || undefined };
  $('#composer-title').textContent = '写信';
  $('#f-to').value = '';
  $('#f-subject').value = '';
  $('#f-body').value = '';
  $('#f-body-rich').innerHTML = '';
  $('#f-attach-list').innerHTML = '';
  $('#f-quote').classList.add('hidden');
  renderAttachChips();
  renderMailboxPicker();
  resetComposerEditor();
  $('#composer-info').textContent = `${state.fromName ? state.fromName + ' ' : ''}<${state.fromAddress}>`;
  hideDiscardConfirm(false);
  resetMergePick();
  setMergeRowVisible(true); // 写信模式：显示合并发送
  composerLastFocus = null;
  // 记录基线：此后任何与基线的差异都算「用户输入」
  composerBaseline = {
    to: $('#f-to').value,
    subject: $('#f-subject').value,
    body: $('#f-body').value,
    richText: richPlainText($('#f-body-rich')),
    mailbox: $('#f-mailbox').value,
  };
  $('#modal-mask').classList.remove('hidden');
  $('#f-to').focus();
}

function openReplyComposer() {
  if (!state.canSend) {
    showToast('服务端未配置发送能力', true);
    return;
  }
  const m = currentMessage;
  if (!m) return;
  state.composing = {
    mode: 'reply',
    originalId: m.id,
    files: [],
    rich: false,
    original: m,
    mailbox: m.mailbox || undefined,
  };
  $('#composer-title').textContent = '回复';
  const to = m.reply_to && m.reply_to.length ? m.reply_to[0] : m.from_email;
  $('#f-to').value = to || '';
  $('#f-subject').value = /^\s*re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`;
  $('#f-body').value = '';
  $('#f-body-rich').innerHTML = '';
  $('#f-attach-list').innerHTML = '';
  $('#f-quote').classList.remove('hidden');
  renderAttachChips();
  renderMailboxPicker();
  resetComposerEditor();
  const mailboxInfo = m.mailbox ? m.mailbox : state.fromAddress;
  $('#composer-info').textContent = `${state.fromName ? state.fromName + ' ' : ''}<${mailboxInfo}>`;
  hideDiscardConfirm(false);
  resetMergePick();
  setMergeRowVisible(false); // 回复模式：收件人由后端从原邮件推导，隐藏该控件避免误导
  composerLastFocus = null;
  // 记录基线：预填的收件人/主题不算用户输入
  composerBaseline = {
    to: $('#f-to').value,
    subject: $('#f-subject').value,
    body: $('#f-body').value,
    richText: richPlainText($('#f-body-rich')),
    mailbox: $('#f-mailbox').value,
  };
  $('#modal-mask').classList.remove('hidden');
  $('#f-body').focus();
}

/* 关闭写信弹窗的「放弃确认」守卫 */

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
 * 用户是否已输入任何信息（与打开弹窗时的快照比对）。
 * 收件人 / 主题 / 发件人 / 当前可见的正文编辑器与基线不同，或已添加附件，
 * 即视为「脏」。回复弹窗预填的收件人、主题属于系统行为，不算用户输入。
 * 只敲空格不算输入；切换富文本模式本身不算脏。
 * 正文只认当前可见的那个编辑器，避免隐藏编辑器里的残留造成「假提示」。
 */
function isComposerDirty() {
  const c = state.composing;
  if (!c) return false;
  if (c.files.length > 0) return true;
  const b = composerBaseline;
  if (!b) {
    // 兜底：没有基线时退回「任一非空即脏」
    if (norm($('#f-to').value) !== '') return true;
    if (norm($('#f-subject').value) !== '') return true;
    if (isRich()) return richPlainText($('#f-body-rich')) !== '';
    return norm($('#f-body').value) !== '';
  }
  if (norm($('#f-to').value) !== norm(b.to)) return true;
  if (norm($('#f-subject').value) !== norm(b.subject)) return true;
  if (norm($('#f-mailbox').value) !== norm(b.mailbox)) return true;
  if (isRich()) {
    if (richPlainText($('#f-body-rich')) !== b.richText) return true;
  } else if (norm($('#f-body').value) !== norm(b.body)) return true;
  return false;
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
 * 请求关闭写信弹窗：无内容时直接关闭；有内容时先弹确认。
 * 遮罩空白区点击、取消按钮、Esc 三个入口都走这里。
 */
function requestCloseComposer() {
  if (!state.composing) return;
  if (sendInFlight) {
    showToast('邮件正在发送中，请稍候…');
    return;
  }
  if (!isComposerDirty()) {
    closeComposer();
    return;
  }
  showDiscardConfirm();
}

function closeComposer() {
  hideDiscardConfirm(false);
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

function insertQuote() {
  const c = state.composing;
  if (!c) return;
  if (isRich()) {
    const ed = $('#f-body-rich');
    ed.insertAdjacentHTML('beforeend', quoteHtml());
    ed.focus();
  } else {
    const ta = $('#f-body');
    const m = c.original;
    const who = (m && (m.from_name || m.from_email)) || '';
    const date = m ? timeLong(m.received_at) : '';
    const body = (m && m.body_text) ? m.body_text.split('\n').map((l) => `> ${l}`).join('\n') : '';
    const block = `${who} ${date} 写道：\n${body || '(无内容)'}\n`;
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
  const recipients = parseRecipients($('#f-to').value);
  const subject = $('#f-subject').value.trim();
  if (!recipients.length) return showToast('请填写收件人', true);

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

  const mailbox = $('#f-mailbox-label').classList.contains('hidden') ? undefined : $('#f-mailbox').value;
  // 硬防御：合并发送只对写信接口生效，绝不向 /api/messages/:id/reply 发 merge
  const merge = c.mode === 'compose' && $('#f-merge').checked;

  const payload = {
    to: recipients,
    subject,
    body: body || undefined,
    html: html && htmlHasText ? html : undefined,
    attachments: c.files.map((f) => ({ filename: f.name, content: f.content, content_type: f.type })),
  };
  if (mailbox) payload.mailbox = mailbox;
  if (merge) payload.merge = true;

  const sendBtn = $('#composer-send');
  sendBtn.disabled = true;
  sendInFlight = true; // 发送中禁止放弃，避免失败时内容丢失
  try {
    const url = c.mode === 'reply'
      ? `/api/messages/${encodeURIComponent(c.originalId)}/reply`
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
    } else {
      showToast(c.mode === 'reply' ? '回复已发送' : '邮件已发送');
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
  // 合并发送：勾选状态与收件人数量都会影响提示文案
  $('#f-merge').addEventListener('change', updateMergeHint);
  $('#f-to').addEventListener('input', updateMergeHint);
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
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (discardConfirmPending) {
      e.preventDefault();
      hideDiscardConfirm();
      return;
    }
    if (!state.composing) return;
    e.preventDefault();
    requestCloseComposer();
  });

  setupSearch();
}

/**
 * 定时后台同步：页面不可见直接跳过；只刷新「超过 TTL」的缓存，不做无条件 force；
 * 列表刷新在阅读态让路（避免打断阅读），数据没变时由指纹短路、不重建 DOM。
 */
async function periodicSync() {
  if (document.hidden) return;
  void refreshCounts(false); // 内部按 TTL.counts 判断
  void loadMailboxes(false); // 内部按 TTL.mailboxes 判断
  if (isReadMode() || state.loading) return;
  const c = state.cache.folders.get(folderKey());
  if (!c || Date.now() - c.at >= TTL.folder) void loadFolder(false, false);
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
