'use strict';

/* =========================================================
 * 邮件收件箱前端（无构建，纯原生）
 * 布局：左侧邮件清单 + 右侧详情（类 Yahoo/常见客户端）
 * 能力：多收件地址 · 会话上下文 · 附件发送 · 富文本
 * 性能：列表/详情/计数 TTL 缓存 + 静默刷新 + 定时同步
 * ========================================================= */

const FOLDERS = [
  { key: 'inbox', label: '收件箱' },
  { key: 'starred', label: '已加星标' },
  { key: 'sent', label: '已发送' },
  { key: 'trash', label: '已删除' },
];

const PAGE_SIZE = 50;
const MAX_FILE_BYTES = 40 * 1024 * 1024;

const TTL = { folder: 45 * 1000, message: 3 * 60 * 1000, counts: 20 * 1000 };
const SYNC_MS = 60 * 1000;

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
  loading: false,
  firstOpen: true,
  cache: { folders: new Map(), messages: new Map(), countsAt: 0 },
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

function freshFolderCache() {
  const c = state.cache.folders.get(folderKey());
  return c && Date.now() - c.at < TTL.folder ? c : null;
}

function storeFolderCache(items, total) {
  state.cache.folders.set(folderKey(), { items: [...items], total, at: Date.now() });
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

function syncRowUI(id) {
  const item = findItem(id);
  for (const row of Array.from(document.querySelectorAll('.list-item[data-id]'))) {
    if (row.dataset.id !== id) continue;
    const active = id === state.openId;
    row.classList.toggle('unread', !!(item && !item.read));
    row.classList.toggle('active', active);
    const star = row.querySelector('.star-btn');
    if (star) {
      star.classList.toggle('starred', !!(item && item.starred));
      star.textContent = item && item.starred ? '★' : '☆';
    }
  }
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
}

function invalidateFolderCaches() {
  state.cache.folders.clear();
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
  const prev = sel.value;
  sel.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = '全部邮箱';
  sel.appendChild(allOpt);
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.mailbox;
    opt.textContent = `${m.mailbox}${m.inbox_unread ? ` (${m.inbox_unread})` : ''}`;
    sel.appendChild(opt);
  }
  const hasPrev = list.some((m) => m.mailbox === prev);
  const target = hasPrev ? prev : (list.find((m) => m.inbox_unread > 0) || list[0]).mailbox;
  sel.value = target;
  if (!hasPrev && state.mailbox === '') state.mailbox = target;
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
  } catch {
    /* 静默 */
  }
}

async function loadMailboxes() {
  try {
    const data = await api('/api/mailboxes');
    state.mailboxList = data.mailboxes || [];
  } catch {
    state.mailboxList = [];
  }
  renderMailboxSelect();
}

/* ---------------- 列表 ---------------- */

function folderLabel() {
  const f = FOLDERS.find((x) => x.key === state.folder);
  return f ? f.label : state.folder;
}

function renderListTitle() {
  const extra = state.total ? ` · ${state.total}` : '';
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

async function loadFolder(append = false, force = false) {
  if (append && state.loading) return;
  const token = `${state.mailbox}|${state.folder}|${state.q}|${append ? 'more' : 'top'}`;

  if (!append && !force) {
    const cached = freshFolderCache();
    if (cached && cached.items.length) {
      state.items = cached.items;
      state.total = cached.total;
      state.offset = cached.items.length;
      state.loading = false;
      renderList();
      afterListRender();
      renderSelectBar();
      maybeAutoOpen();
      return;
    }
    state.offset = 0;
    state.items = [];
  }

  state.loading = true;
  renderList();
  afterListRender();
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(state.offset) });
    if (state.q) params.set('q', state.q);
    if (state.mailbox) params.set('mailbox', state.mailbox);
    const data = await api(`/api/folders/${state.folder}?${params}`);
    if (token !== `${state.mailbox}|${state.folder}|${state.q}|${append ? 'more' : 'top'}`) return;
    const items = append ? state.items.concat(data.items) : data.items;
    state.items = items;
    state.total = data.total;
    state.offset += data.items.length;
    storeFolderCache(items, state.total);
    renderList();
    afterListRender();
    maybeAutoOpen();
  } catch (e) {
    if (token === `${state.mailbox}|${state.folder}|${state.q}|${append ? 'more' : 'top'}` && !state.items.length) {
      showToast(e.message, true);
    }
  } finally {
    if (token === `${state.mailbox}|${state.folder}|${state.q}|${append ? 'more' : 'top'}`) {
      state.loading = false;
      afterListRender();
      renderSelectBar();
    }
  }
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

function renderSelectBar() {
  const bar = $('#list-bulk');
  const hasSel = state.selected.size > 0;
  bar.classList.toggle('hidden', !hasSel);
  if (!hasSel) return;
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
    await loadFolder(false, true);
  } catch (e) {
    showToast(e.message, true);
  }
}

/* ---------------- 阅读面板 ---------------- */

let currentMessage = null;
let currentAttachments = [];
let currentThread = [];

function closeMessagePane() {
  state.openId = null;
  currentMessage = null;
  currentAttachments = [];
  currentThread = [];
  $('#read-message').classList.add('hidden');
  $('#read-placeholder').classList.remove('hidden');
}

function isReadMode() {
  return state.openId !== null;
}

async function openMessage(id) {
  const cached = state.cache.messages.get(id);
  if (cached && Date.now() - cached.at < TTL.message) {
    currentMessage = cached.message;
    currentAttachments = cached.attachments || [];
    currentThread = cached.thread || [];
    state.openId = id;
    renderRead();
    return;
  }

  try {
    const data = await api(`/api/messages/${encodeURIComponent(id)}`);
    currentMessage = data.message;
    currentAttachments = data.attachments || [];
    currentThread = data.thread || [];
    state.cache.messages.set(id, {
      message: currentMessage,
      attachments: currentAttachments,
      thread: currentThread,
      at: Date.now(),
    });
    state.openId = id;
    if (currentMessage.direction === 'inbound' && !currentMessage.read) {
      applyLocalPatch(id, { read: 1 });
      state.cache.countsAt = 0;
      void refreshCounts();
    }
    renderRead();
  } catch (e) {
    showToast(e.message, true);
  }
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
  emailLine.textContent = isInbound ? (m.from_email || '') : `致 ${recipientsLabel(m.to_emails)}`;
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
  toLine.innerHTML = `<b>${toLabel}：</b>${esc(isInbound ? recipientsLabel(m.to_emails) : recipientsLabel(m.to_emails))} `;
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
  }
  readEl.appendChild(env);

  // 正文
  const bodyCard = document.createElement('div');
  bodyCard.className = 'mail-body';
  bodyCard.innerHTML = buildBodyHtml(m);
  bodyCard.querySelectorAll('a').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
  readEl.appendChild(bodyCard);

  syncRowUI(m.id);
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

function composerMailboxOptions() {
  const list = state.mailboxList.map((m) => m.mailbox);
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
  const to = $('#f-to').value.trim();
  const subject = $('#f-subject').value.trim();
  if (!to) return showToast('请填写收件人', true);

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

  const payload = {
    to,
    subject,
    body: body || undefined,
    html: html && htmlHasText ? html : undefined,
    attachments: c.files.map((f) => ({ filename: f.name, content: f.content, content_type: f.type })),
  };
  if (mailbox) payload.mailbox = mailbox;

  const sendBtn = $('#composer-send');
  sendBtn.disabled = true;
  sendInFlight = true; // 发送中禁止放弃，避免失败时内容丢失
  try {
    if (c.mode === 'reply') {
      await api(`/api/messages/${encodeURIComponent(c.originalId)}/reply`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast('回复已发送');
    } else {
      await api('/api/messages', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast('邮件已发送');
    }
    closeComposer();
    invalidateFolderCaches();
    state.cache.countsAt = 0;
    void refreshCounts();
    void loadMailboxes();
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

/** 定时后台同步：刷新计数 + 当前列表。 */
async function periodicSync() {
  await refreshCounts(true);
  if (!isReadMode() && !state.loading) void loadFolder(false, true);
}

/* ---------------- 初始化 ---------------- */

async function init() {
  try {
    const account = await api('/api/account');
    state.canSend = !!account.can_send;
    state.fromAddress = account.from_address;
    state.fromName = account.from_name;
  } catch (e) {
    showToast(e.message, true);
  }

  await loadMailboxes();
  renderNav();
  setupEvents();
  renderListTitle();
  closeMessagePane();
  void loadFolder();
  void refreshCounts(true);

  setInterval(periodicSync, SYNC_MS);
}

init();
