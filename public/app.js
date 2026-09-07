'use strict';

/* =========================================================
 * 简化 Gmail 收件箱前端（无构建，纯原生）
 * 文件夹: inbox / starred / sent / trash
 * ========================================================= */

const FOLDERS = [
  { key: 'inbox', label: '收件箱' },
  { key: 'starred', label: '已加星标' },
  { key: 'sent', label: '已发送' },
  { key: 'trash', label: '已删除' },
];

const PAGE_SIZE = 50;

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
  items: [],
  selected: new Set(),
  q: '',
  total: 0,
  offset: 0,
  counts: { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 },
  composing: null, // { mode: 'compose'|'reply', originalId }
  canSend: false,
  fromAddress: '',
  fromName: '',
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

/* ---------------- 通用小工具 ---------------- */

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
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function jsonArr(v) {
  return Array.isArray(v) ? v : [];
}

function fmtAddr(addr) {
  return addr || '';
}

function timeShort(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const weekAgo = now.getTime() - 7 * 86400000;
  if (d.getTime() > weekAgo) {
    return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function timeLong(sec) {
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

/* ---------------- 侧边栏 ---------------- */

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

async function refreshCounts() {
  try {
    state.counts = await api('/api/counts');
  } catch {
    state.counts = { inbox_unread: 0, inbox_total: 0, sent_total: 0, starred_total: 0, trash_total: 0 };
  }
  renderNav();
}

/* ---------------- 列表 ---------------- */

function openFolder(folder) {
  state.folder = folder;
  state.selected.clear();
  state.offset = 0;
  $('#search-input').value = '';
  state.q = '';
  showList();
  updateBulkBar();
}

async function loadFolder(append = false) {
  if (!append) {
    state.offset = 0;
  }
  state.loading = true;
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(state.offset) });
    if (state.q) params.set('q', state.q);
    const data = await api(`/api/folders/${state.folder}?${params}`);
    state.items = append ? state.items.concat(data.items) : data.items;
    state.total = data.total;
    state.offset += data.items.length;
    renderList();
    $('#list-empty').classList.toggle('hidden', state.items.length !== 0);
    const more = $('#list-more');
    const hasMore = state.items.length < state.total;
    more.classList.toggle('hidden', !hasMore);
    more.textContent = hasMore ? `已显示 ${state.items.length} / ${state.total} 封，点击加载更多` : '';
  } catch (e) {
    showToast(e.message, true);
  } finally {
    state.loading = false;
    renderSelectBar();
    refreshCounts();
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
    toggleStar(item, b);
  });
  return b;
}

async function toggleStar(item, btn) {
  try {
    await api(`/api/messages/${encodeURIComponent(item.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ starred: !item.starred }),
    });
    item.starred = !item.starred;
    btn.classList.toggle('starred', item.starred);
    btn.textContent = item.starred ? '★' : '☆';
    btn.title = item.starred ? '取消星标' : '加星标';
    refreshCounts();
  } catch (e) {
    showToast(e.message, true);
  }
}

function itemRow(item) {
  const row = document.createElement('div');
  row.className = 'list-item' + (item.read ? '' : ' unread');
  row.dataset.id = item.id;

  if (!item.read) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    row.appendChild(dot);
  }

  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.className = 'chk';
  chk.checked = state.selected.has(item.id);
  chk.addEventListener('click', (ev) => ev.stopPropagation());
  chk.addEventListener('change', () => {
    if (chk.checked) state.selected.add(item.id);
    else state.selected.delete(item.id);
    renderSelectBar();
  });
  row.appendChild(chk);

  const sender = document.createElement('div');
  sender.className = 'sender';
  const isInbound = item.direction === 'inbound';
  if (isInbound) {
    sender.textContent = senderLabel(item);
  } else {
    const to = recipientsLabel(item.to_emails);
    sender.innerHTML = '';
    const small = document.createElement('small');
    small.textContent = `致 ${to || '(无收件人)'}`;
    sender.appendChild(small);
  }
  row.appendChild(sender);

  const subj = document.createElement('div');
  subj.className = 'subject';
  const subjectText = item.subject || '(无主题)';
  const preview = (item.preview || '').trim();
  subj.innerHTML = preview
    ? `${esc(subjectText)} <span class="preview">– ${esc(preview)}</span>`
    : esc(subjectText);
  row.appendChild(subj);

  if (item.attachments_count > 0) {
    const af = document.createElement('span');
    af.className = 'attach-flag';
    af.textContent = `[${item.attachments_count}]`;
    subj.appendChild(af);
  }

  if (item.direction === 'outbound') {
    const chip = document.createElement('span');
    chip.className = 'status-chip ' + esc(item.status || 'sent');
    chip.textContent = STATUS_LABEL[item.status] || item.status || 'sent';
    row.appendChild(chip);
  }

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = timeShort(item.received_at);
  row.appendChild(time);

  row.appendChild(starBtn(item));

  row.addEventListener('click', () => openMessage(item.id));
  return row;
}

function renderList() {
  listEl.innerHTML = '';
  for (const item of state.items) {
    listEl.appendChild(itemRow(item));
  }
}

function renderSelectBar() {
  const bar = $('#select-bar');
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
    b.addEventListener('click', () => bulk(action));
    actions.appendChild(b);
  };
  if (state.folder === 'trash') {
    mk('还原', 'restore');
    mk('彻底删除', 'delete', 'btn-danger');
  } else {
    mk('已读', 'read');
    mk('未读', 'unread');
    mk('加星标', 'star');
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
    if (action === 'delete') {
      // 已删除文件夹内的彻底删除会移出列表
    }
    await loadFolder();
  } catch (e) {
    showToast(e.message, true);
  }
}

/* ---------------- 阅读视图 ---------------- */

let currentMessage = null;
let currentAttachments = [];

function showList() {
  $('#view-read').classList.add('hidden');
  $('#view-list').classList.remove('hidden');
  $('#back-btn-wrap').classList.add('hidden');
  $('#topbar-actions').classList.add('hidden');
  loadFolder();
}

async function openMessage(id) {
  try {
    const data = await api(`/api/messages/${encodeURIComponent(id)}`);
    currentMessage = data.message;
    currentAttachments = data.attachments || [];
    renderRead();
    $('#view-list').classList.add('hidden');
    $('#view-read').classList.remove('hidden');
    $('#back-btn-wrap').classList.remove('hidden');
    renderReadActions();
    // 若是收件箱未读，返回列表时刷新
    if (currentMessage.direction === 'inbound') refreshCounts();
  } catch (e) {
    showToast(e.message, true);
  }
}

function readActionBtn(label, fn, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}

function renderReadActions() {
  const wrap = $('#topbar-actions');
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  if (currentMessage.direction === 'inbound') {
    wrap.appendChild(readActionBtn('回复', openReplyComposer));
  }
  wrap.appendChild(readActionBtn('星标', () => setFlag('starred', !currentMessage.starred)));
  if (currentMessage.direction === 'inbound') {
    wrap.appendChild(readActionBtn(currentMessage.read ? '标为未读' : '标为已读', () => setFlag('read', !currentMessage.read)));
  }
  wrap.appendChild(readActionBtn('删除', async () => {
    try {
      await api(`/api/messages/${encodeURIComponent(currentMessage.id)}`, {
        method: 'PATCH', body: JSON.stringify({ deleted: true }),
      });
      showToast('已移入已删除');
      showList();
    } catch (e) { showToast(e.message, true); }
  }));
}

async function setFlag(key, value) {
  try {
    await api(`/api/messages/${encodeURIComponent(currentMessage.id)}`, {
      method: 'PATCH', body: JSON.stringify({ [key]: value }),
    });
    currentMessage[key] = value;
    renderReadActions();
    refreshCounts();
  } catch (e) { showToast(e.message, true); }
}

function renderRead() {
  const m = currentMessage;
  const isInbound = m.direction === 'inbound';
  readEl.innerHTML = '';

  const actions = document.createElement('div');
  actions.className = 'rm-actions';
  actions.appendChild(readActionBtn('‹ 返回', showList));
  readEl.appendChild(actions);

  const head = document.createElement('div');
  head.className = 'rm-head';

  const h = document.createElement('h2');
  h.className = 'rm-subject';
  h.textContent = m.subject || '(无主题)';
  head.appendChild(h);

  const meta = document.createElement('div');
  meta.className = 'rm-meta';
  let inner = '';
  if (isInbound) {
    inner += `<div class="rm-from"><span class="name">${esc(m.from_name || m.from_email || '(未知)')}</span>`;
    if (m.from_name && m.from_email) inner += ` <span>${esc(m.from_email)}</span>`;
    inner += `</div>`;
    if (m.to_emails && m.to_emails.length) inner += `<div><b>收件人：</b>${esc(m.to_emails.join(', '))}</div>`;
    if (m.cc && m.cc.length) inner += `<div><b>抄送：</b>${esc(m.cc.join(', '))}</div>`;
  } else {
    inner += `<div class="rm-from"><span class="name">发送</span></div>`;
    if (m.to_emails && m.to_emails.length) inner += `<div><b>收件人：</b>${esc(m.to_emails.join(', '))}</div>`;
    if (m.status) {
      inner += `<div><span class="status-chip ${esc(m.status)}">${STATUS_LABEL[m.status] || esc(m.status)}</span></div>`;
    }
  }
  inner += `<div>${timeLong(m.received_at)}</div>`;
  meta.innerHTML = inner;
  head.appendChild(meta);

  readEl.appendChild(head);

  if (currentAttachments.length) {
    const box = document.createElement('div');
    box.className = 'attachments';
    const title = document.createElement('div');
    title.className = 'att-title';
    title.textContent = '附件';
    box.appendChild(title);
    for (const a of currentAttachments) {
      const chip = document.createElement('a');
      chip.className = 'att-chip';
      chip.href = a.url;
      chip.target = '_blank';
      chip.rel = 'noopener noreferrer';
      chip.innerHTML = `<span class="nm">${esc(a.filename)}</span><span class="sz">${fmtSize(a.size)}</span>`;
      box.appendChild(chip);
    }
    readEl.appendChild(box);
  }

  const body = document.createElement('div');
  body.id = 'mail-body';
  body.innerHTML = buildBodyHtml(m);
  readEl.appendChild(body);

  // 链接新窗口打开
  body.querySelectorAll('a').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });
}

function buildBodyHtml(m) {
  const cidMap = {};
  for (const a of currentAttachments) {
    if (a.content_id) cidMap[a.content_id.toLowerCase()] = a.url;
    cidMap[a.id.toLowerCase()] = a.url;
  }
  const html = m.body_html;
  if (html) {
    return sanitizeHtml(html, cidMap);
  }
  return `<pre class="text">${esc(m.body_text || '')}</pre>`;
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------------- HTML 安全清洗 ---------------- */

const SAFE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CENTER', 'CODE', 'DD', 'DEL', 'DIV', 'DL', 'DT',
  'EM', 'FONT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'INS', 'LI', 'OL',
  'P', 'PRE', 'Q', 'S', 'SECTION', 'SMALL', 'SPAN', 'STRONG', 'STRIKE', 'SUB', 'SUP',
  'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'TT', 'U', 'UL',
]);
const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'META', 'LINK', 'BASE',
  'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'SVG', 'MATH', 'VIDEO', 'AUDIO',
  'SOURCE', 'TRACK', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'HTML', 'BODY',
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
  const root = doc.body;

  // 1) 去掉硬性危险标签（连同内容）
  root.querySelectorAll('script,style,iframe,frame,object,embed,meta,link,base,form,input,button,select,textarea,svg,math,video,audio,source,track,template,noscript').forEach((el) => el.remove());

  // 2) 自底向上处理全部元素：不合法的拆包，合法但属性越界的清理
  const all = Array.from(root.querySelectorAll('*'));
  for (const el of all.reverse()) {
    const tag = el.tagName.toUpperCase();
    if (!SAFE_TAGS.has(tag)) {
      unwrap(el);
      continue;
    }
    // 属性白名单
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const allow = ATTR_ALLOW[tag] || new Set();
      if (!allow.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      let value = attr.value;
      if (name === 'href') {
        if (!/^(https?:|mailto:)/i.test(value)) {
          el.removeAttribute('href');
          continue;
        }
        el.setAttribute('href', value);
      }
      if (name === 'src') {
        value = value.trim();
        const m = /^cid:(.*)$/i.exec(value);
        if (m) {
          const key = m[1].replace(/[<>]/g, '').trim().toLowerCase();
          const url = cidMap[key];
          if (url) el.setAttribute('src', url);
          else el.remove(); // 找不到对应的内联附件，移除
        } else if (!/^(https?:|data:image\/)/i.test(value)) {
          el.removeAttribute('src');
        } else {
          el.setAttribute('src', value);
        }
      }
    }
  }
  return root.innerHTML;
}

function unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

/* ---------------- 写信 / 回复 ---------------- */

function openComposer() {
  if (!state.canSend) {
    showToast('服务端未配置发送能力（缺少 RESEND_API_KEY / SEND_FROM_ADDRESS）', true);
    return;
  }
  state.composing = { mode: 'compose' };
  $('#composer-title').textContent = '写信';
  $('#f-to').value = '';
  $('#f-subject').value = '';
  $('#f-body').value = '';
  $('#composer-info').textContent = state.fromName && state.fromAddress
    ? `发件人：${state.fromName} <${state.fromAddress}>`
    : `发件人：${state.fromAddress}`;
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
  state.composing = { mode: 'reply', originalId: m.id };
  $('#composer-title').textContent = '回复';
  const to = m.reply_to && m.reply_to.length ? m.reply_to[0] : m.from_email;
  $('#f-to').value = to || '';
  $('#f-subject').value = /^\s*re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`;
  $('#f-body').value = '';
  $('#composer-info').textContent = state.fromName && state.fromAddress
    ? `发件人：${state.fromName} <${state.fromAddress}>`
    : `发件人：${state.fromAddress}`;
  $('#modal-mask').classList.remove('hidden');
  $('#f-body').focus();
}

function closeComposer() {
  state.composing = null;
  $('#modal-mask').classList.add('hidden');
}

async function sendCompose() {
  const to = $('#f-to').value.trim();
  const subject = $('#f-subject').value.trim();
  const body = $('#f-body').value;
  if (!to) return showToast('请填写收件人', true);
  if (!body.trim()) return showToast('请填写邮件内容', true);

  const sendBtn = $('#composer-send');
  sendBtn.disabled = true;
  try {
    if (state.composing.mode === 'reply') {
      await api(`/api/messages/${encodeURIComponent(state.composing.originalId)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      showToast('回复已发送');
    } else {
      await api('/api/messages', {
        method: 'POST',
        body: JSON.stringify({ to, subject, body }),
      });
      showToast('邮件已发送');
    }
    closeComposer();
    // 跳到已发送
    if (state.folder !== 'sent') openFolder('sent');
    else showList();
  } catch (e) {
    showToast(`发送失败：${e.message}`, true);
  } finally {
    sendBtn.disabled = false;
  }
}

/* ---------------- 顶部操作（搜索、批量等事件绑定） ---------------- */

function setupSearch() {
  const input = $('#search-input');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = input.value.trim();
      state.selected.clear();
      loadFolder();
    }, 400);
  });
}

function setupEvents() {
  $('#compose-btn').addEventListener('click', openComposer);
  $('#composer-cancel').addEventListener('click', closeComposer);
  $('#composer-send').addEventListener('click', sendCompose);
  $('#modal-mask').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeComposer();
  });
  $('#back-btn').addEventListener('click', showList);

  $('#select-all').addEventListener('change', (e) => {
    const check = e.target.checked;
    state.selected.clear();
    if (check) for (const it of state.items) state.selected.add(it.id);
    renderList();
    renderSelectBar();
  });

  $('#list-more').addEventListener('click', () => {
    if (!state.loading) loadFolder(true);
  });

  setupSearch();
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

  renderNav();
  setupEvents();
  showList();

  // 每 30s 刷新一次未读数
  setInterval(refreshCounts, 30000);
}

init();
