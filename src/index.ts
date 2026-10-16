import type { Env, Folder, InboundQueueMessage } from './types';
import { authenticate, unauthorized } from './auth';
import { handleInbound, handleEvents } from './webhook';
import { handleInboundEmail, handleInboundQueue, replayPendingInbound } from './inbound-email';
import * as repo from './repo';
import { resendSend, replySubject, forwardSubject, textToHtml, senderIdentity } from './send';
import type { ResendAttachment } from './send';
import { json, jsonArr, nowSec, parseAddress, parseAddressList, rootThreadId, isSaneThreadId, parseReferences, stripAngle, uuid, base64ToBytes, bytesToBase64, stripHtml } from './util';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/health' && method === 'GET') {
      return json({ status: 'ok', timestamp: nowSec() });
    }

    // Webhook 入口：仅校验签名，不走 Basic Auth
    if (path === '/webhook/inbound' && method === 'POST') return handleInbound(request, env);
    if (path === '/webhook/events' && method === 'POST') return handleEvents(request, env);

    // 其余一律要求认证（API + 页面资源）
    if (!(await authenticate(request, env))) return unauthorized();

    if (path.startsWith('/api/')) {
      return routeApi(request, env, path, url);
    }

    // SPA 静态资源（index.html / app.js / app.css）由 assets 提供
    if ((method === 'GET' || method === 'HEAD') && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return json({ error: 'Not Found' }, 404);
  },

  // CF Email Routing 入向：把原始件落 R2 + 登记 + 入队（见 src/inbound-email.ts 的说明）。
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleInboundEmail(env, message);
  },

  // 入向异步解析消费（never-lose 流水线第二段）。
  async queue(batch: MessageBatch<InboundQueueMessage>, env: Env): Promise<void> {
    await handleInboundQueue(batch, env);
  },

  // 恢复 cron（never-lose 兜底）：把「已落 R2 但没解析完」的入向邮件重新入队。
  // 见 src/inbound-email.ts 的 replayPendingInbound 与 wrangler.toml 的 [triggers]。
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const n = await replayPendingInbound(env);
    if (n) console.log(`inbound: replay enqueued ${n} pending raw message(s)`);
  },
};

async function routeApi(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const method = request.method;

  // 收件箱/已发送/星标/已删除 文件夹列表（可按 mailbox 过滤）
  const folderMatch = /^\/api\/folders\/(inbox|sent|starred|trash)$/.exec(path);
  if (folderMatch && method === 'GET') {
    const folder = folderMatch[1] as Folder;
    const q = url.searchParams.get('q') || null;
    const unread = url.searchParams.get('unread') === '1';
    const mailbox = url.searchParams.get('mailbox') || undefined;
    const limit = clampInt(url.searchParams.get('limit'), 50, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 100000);
    const result = await repo.listFolder(env, { folder, q, unread, mailbox, limit, offset });
    return json({ folder, items: result.items, total: result.total, limit, offset });
  }

  // 草稿箱列表。草稿在独立表里（见 schema.sql 的 drafts 说明），
  // 但**返回形状与其它文件夹完全一致**（伪装成一封 direction='draft' 的邮件），
  // 前端因此能复用同一套列表渲染 / 缓存 / 分页 / 搜索逻辑。
  if (path === '/api/folders/drafts' && method === 'GET') {
    const q = url.searchParams.get('q') || null;
    const mailbox = url.searchParams.get('mailbox') || undefined;
    const limit = clampInt(url.searchParams.get('limit'), 50, 200);
    const offset = clampInt(url.searchParams.get('offset'), 0, 100000);
    const result = await repo.listDrafts(env, { q, mailbox, limit, offset });
    return json({ folder: 'drafts', items: result.items, total: result.total, limit, offset });
  }

  // 单条草稿：GET 恢复编辑 / PUT 自动保存（upsert）/ DELETE 丢弃
  const draftMatch = /^\/api\/drafts\/([^/]+)$/.exec(path);
  if (draftMatch) {
    const draftId = decodeURIComponent(draftMatch[1]);
    if (method === 'GET') {
      const d = await repo.getDraft(env, draftId);
      if (!d) return json({ error: '草稿不存在' }, 404);
      return json({ draft: draftJson(d) });
    }
    if (method === 'PUT') {
      const body = await request.json().catch(() => null);
      const input = parseDraftInput(draftId, body);
      if (!input) return json({ error: '参数错误' }, 400);
      await repo.upsertDraft(env, input);
      return json({ ok: true, id: draftId });
    }
    if (method === 'DELETE') {
      await repo.deleteDraft(env, draftId);
      return json({ ok: true });
    }
    return json({ error: 'Method Not Allowed' }, 405);
  }

  // 侧边栏计数（可按 mailbox 过滤）
  if (path === '/api/counts' && method === 'GET') {
    const mailbox = url.searchParams.get('mailbox') || undefined;
    return json(await repo.sidebarCounts(env, mailbox));
  }

  // 收件地址列表（多邮箱切换）
  if (path === '/api/mailboxes' && method === 'GET') {
    return json({ mailboxes: await repo.mailboxes(env) });
  }

  // 本地联系人（写信/回复/转发的收件人输入联想）
  if (path === '/api/contacts' && method === 'GET') {
    return json({ contacts: await repo.contacts(env) });
  }

  // 账户/发送能力信息（供写信界面显示发件人）
  if (path === '/api/account' && method === 'GET') {
    return json({
      can_send: Boolean(env.RESEND_API_KEY && env.SEND_FROM_ADDRESS),
      from_name: env.SEND_FROM_NAME || '',
      from_address: env.SEND_FROM_ADDRESS || '',
    });
  }

  // 后端状态：CF（D1/R2 占用 + 入站队列）+ Resend（发信额度）。前端一屏看清，提前知道何时该升级。?refresh=1 强制重算存储。
  if (path === '/api/usage' && method === 'GET') {
    return json(await repo.getBackendStatus(env, { force: url.searchParams.get('refresh') === '1' }));
  }

  // 批量操作：/api/messages/batch
  if (path === '/api/messages/batch' && method === 'POST') {
    const body = (await request.json().catch(() => null)) as { ids?: unknown; action?: unknown } | null;
    if (!body || !Array.isArray(body.ids) || typeof body.action !== 'string') {
      return json({ error: '参数错误' }, 400);
    }
    const ids = (body.ids as unknown[]).filter((x): x is string => typeof x === 'string');
    const result = await repo.batchAction(env, ids, body.action as repo.BatchAction);
    return json(result);
  }

  // 写信：/api/messages
  if (path === '/api/messages' && method === 'POST') {
    return compose(env, request);
  }

  // 回复：/api/messages/:id/reply
  const replyMatch = /^\/api\/messages\/([^/]+)\/reply$/.exec(path);
  if (replyMatch && method === 'POST') {
    return reply(env, request, decodeURIComponent(replyMatch[1]));
  }

  // 转发：/api/messages/:id/forward（任意方向的邮件都可转发）
  const forwardMatch = /^\/api\/messages\/([^/]+)\/forward$/.exec(path);
  if (forwardMatch && method === 'POST') {
    return forward(env, request, decodeURIComponent(forwardMatch[1]));
  }

  // 单封邮件详情 / 更新
  const messageMatch = /^\/api\/messages\/([^/]+)$/.exec(path);
  if (messageMatch) {
    const id = decodeURIComponent(messageMatch[1]);
    if (method === 'GET') return getMessageDetail(env, id);
    if (method === 'PATCH') {
      const body = (await request.json().catch(() => null)) as repo.PatchBody | null;
      if (!body) return json({ error: '参数错误' }, 400);
      const ok = await repo.patchMessage(env, id, body);
      return ok ? json({ ok: true }) : json({ error: '未找到该邮件' }, 404);
    }
    return json({ error: 'Method Not Allowed' }, 405);
  }

  // 附件代理：/api/attachments/:id  （?dl=1 强制下载，不带则按类型决定是否内联预览）
  const attachmentMatch = /^\/api\/attachments\/([^/]+)$/.exec(path);
  if (attachmentMatch && method === 'GET') {
    const resp = await repo.proxyAttachment(env, decodeURIComponent(attachmentMatch[1]), {
      forceDownload: url.searchParams.get('dl') === '1',
    });
    if (!resp) return json({ error: '附件不存在' }, 404);
    return resp;
  }

  // 入站异常看板：CF 入向「收了但没解析进收件箱」的邮件（原始件仍安全保存在 R2）。
  // 这是「什么都不写后台日志、用户无从知晓」的解药——把没收进箱的邮件显式暴露出来。
  if (path === '/api/inbound/alerts' && method === 'GET') {
    const alerts = await repo.listInboundAlerts(env);
    return json({ alerts, count: alerts.length });
  }

  // 手动重放一条入站异常
  const inboundRetryMatch = /^\/api\/inbound\/alerts\/([^/]+)\/retry$/.exec(path);
  if (inboundRetryMatch && method === 'POST') {
    const ok = await repo.retryInbound(env, decodeURIComponent(inboundRetryMatch[1]));
    return ok ? json({ ok: true }) : json({ error: '未找到该入站记录' }, 404);
  }

  // 下载某封入站异常的原始 .eml（收件箱里没有时的人工兜底）
  const inboundRawMatch = /^\/api\/inbound\/alerts\/([^/]+)\/raw$/.exec(path);
  if (inboundRawMatch && method === 'GET') {
    const resp = await repo.proxyInboundRaw(env, decodeURIComponent(inboundRawMatch[1]));
    return resp || json({ error: '原始邮件不存在' }, 404);
  }

  return json({ error: 'Not Found' }, 404);
}

/* ---------------- 草稿箱辅助 ---------------- */

/** 草稿行 → 前端形状（收件人拆成数组、rich 转布尔、缺省字段补空串）。 */
function draftJson(d: repo.DraftRow) {
  return {
    id: d.id,
    mailbox: d.mailbox,
    mode: d.mode,
    source_id: d.source_id,
    to: jsonArr(d.to_emails),
    cc: jsonArr(d.cc),
    bcc: jsonArr(d.bcc),
    subject: d.subject || '',
    body_html: d.body_html || '',
    body_text: d.body_text || '',
    rich: d.rich === 1,
    updated_at: d.updated_at,
  };
}

/**
 * 解析自动保存的请求体。
 *
 * 收件人一律走 `normalizeRecipients` 的**同源切分**（逗号 / 分号 / 空白），
 * 保证「草稿里存下的收件人」与「真正发出去时的收件人」逐字一致 ——
 * 两套口径会让用户看到草稿里写着 3 个收件人、发出去却只有 2 个。
 */
function parseDraftInput(id: string, body: unknown): repo.DraftInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const { to, cc, bcc } = normalizeRecipients(parseRecipient(b.to), parseRecipient(b.cc), parseRecipient(b.bcc));
  const mode = b.mode === 'reply' || b.mode === 'forward' ? b.mode : 'new';
  return {
    id,
    mailbox: typeof b.mailbox === 'string' ? b.mailbox.trim().toLowerCase() : '',
    mode,
    sourceId: typeof b.source_id === 'string' && b.source_id ? b.source_id : null,
    to,
    cc,
    bcc,
    subject: typeof b.subject === 'string' ? b.subject : '',
    html: typeof b.html === 'string' ? b.html : '',
    text: typeof b.body === 'string' ? b.body : '',
    rich: b.rich === true,
  };
}

/** 发信成功后丢弃对应草稿。失败**不影响**发送结果（草稿最多多留一条，用户可手动删）。 */
async function dropDraft(env: Env, draftId: string | undefined | null): Promise<void> {
  if (!draftId) return;
  try {
    await repo.deleteDraft(env, draftId);
  } catch (err) {
    console.error('deleteDraft failed:', err);
  }
}

function clampInt(raw: string | null, def: number, max: number): number {
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(Math.floor(n), max);
}

async function getMessageDetail(env: Env, id: string): Promise<Response> {
  const message = await repo.getMessage(env, id);
  if (!message) return json({ error: '邮件不存在' }, 404);

  if (message.direction === 'inbound' && message.read === 0) {
    await repo.markRead(env, id);
    message.read = 1;
  }

  // 附件与会话上下文互不依赖，并行取（少一个串行 D1 往返）；markRead 必须在返回前完成，故留在上面串行。
  const noThread: Awaited<ReturnType<typeof repo.listThread>> = [];
  const [attachmentsRaw, threadRaw] = await Promise.all([
    repo.listAttachments(env, id),
    message.thread_id ? repo.listThread(env, message.thread_id) : Promise.resolve(noThread),
  ]);

  const attachments = attachmentsRaw.map((a) => ({
    id: a.id,
    message_id: a.message_id,
    filename: a.filename,
    content_type: a.content_type,
    size: a.size,
    inline: a.inline === 1,
    content_id: a.content_id,
    url: `/api/attachments/${a.id}`,
  }));

  // 会话上下文（同一 thread_id 内，**降序：最近在前**；回环副本已由 listThread 折叠）
  const thread: Array<Record<string, unknown>> = threadRaw.map((t) => ({
    id: t.id,
    direction: t.direction,
    mailbox: t.mailbox,
    from_name: t.from_name,
    from_email: t.from_email,
    to: jsonArr(t.to_emails),
    subject: t.subject,
    preview: t.preview,
    received_at: t.received_at,
    read: t.read === 1,
    deleted: t.deleted === 1,
    // 同一封物理邮件的其它记录 id（被折叠掉的回环副本）。前端据此把「当前打开的是副本」
    // 也认作当前行；这里顺带把 `current` 一并算对，避免两处口径不一致。
    copy_ids: t.copy_ids ?? [],
    current: t.id === id || (t.copy_ids ?? []).includes(id),
  }));

  const { to_emails, delivered_to, cc, bcc, reply_to, ...rest } = message;
  return json({
    message: {
      ...rest,
      id,
      to_emails: jsonArr(to_emails),
      // 入站：投递地址（信封收件人）。历史行是 null —— 前端据此判定「修复前入库」，
      // 展示收件人时把投递地址减去 cc/bcc，别把自己标成收件人。
      delivered_to: delivered_to ? jsonArr(delivered_to) : null,
      cc: jsonArr(cc),
      bcc: jsonArr(bcc),
      reply_to: jsonArr(reply_to),
    },
    attachments,
    thread,
  });
}

/** 收件人按小写去重（保留首次出现的原始写法），顺带 trim 与去空。 */
function dedupeRecipients(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const addr = raw.trim();
    const key = addr.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/**
 * 切分多收件人字符串：逗号 / 分号（含中文全角）/ 空白均为分隔符，
 * 每段 trim 后去空，再按小写去重。与前端 parseRecipients 同一口径。
 */
function splitRecipients(raw: string): string[] {
  return dedupeRecipients(raw.split(/[,;，；\s]+/));
}

function parseRecipient(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const r of raw) {
      if (typeof r === 'string') out.push(r.trim());
      else if (r && typeof r === 'object') {
        const o = r as Record<string, unknown>;
        if (typeof o.email === 'string') out.push(o.email.trim());
      }
    }
    return out.filter(Boolean);
  }
  if (typeof raw === 'string') return splitRecipients(raw);
  return [];
}

/**
 * 归一化 to / cc / bcc 三组收件人：
 * - **to 原样保留**（顺序与重复项都不动）—— 这是 B13 锁定的既有行为，改动会让老断言变红；
 * - cc / bcc 去重，并剔除已出现在更高优先级分组里的地址（to > cc > bcc）。
 *
 * 剔除重复是必须的：同一地址同时出现在 to 和 cc 时，Resend 会把同一封信投两次，
 * 收件人会收到两封一模一样的邮件。
 */
function normalizeRecipients(
  to: string[],
  cc: string[],
  bcc: string[]
): { to: string[]; cc: string[]; bcc: string[] } {
  const toClean = to.filter((x) => x.trim());
  const taken = new Set(toClean.map((x) => x.trim().toLowerCase()));
  const ccClean = dedupeRecipients(cc).filter((x) => !taken.has(x.toLowerCase()));
  for (const x of ccClean) taken.add(x.toLowerCase());
  const bccClean = dedupeRecipients(bcc).filter((x) => !taken.has(x.toLowerCase()));
  return { to: toClean, cc: ccClean, bcc: bccClean };
}

/** base64 长度 -> 原始字节数（仅用于「总大小是否超限」的粗略预检，不解码）。 */
function approxBase64Bytes(b64: string): number {
  const n = b64.replace(/\s+/g, '').length;
  return Math.floor((n * 3) / 4);
}

const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024; // 对齐 Resend 附件上限
/**
 * 每位收件人在合并发送中消耗的子请求数：
 *   1 次 Resend fetch + 1 次 D1 .run()（saveOutbound）
 *   + 每个附件 1 次 R2 put + 有附件时 1 次 D1 .batch()（写附件元数据）。
 *
 * ⚠️ Cloudflare 的子请求口径**包含对 R2 / D1 的调用**，不只是 fetch。
 * 此处假设 `DB.batch()` 计 1 次子请求（单次事务往返）。
 */
function perRecipientSubrequests(attachmentCount: number): number {
  return 2 + attachmentCount + (attachmentCount > 0 ? 1 : 0);
}

/** 绝对上限：串行发送的兜底，防止预算被配得过大导致单请求过久。 */
const MAX_MERGE_RECIPIENTS = 200;

/**
 * 合并发送单次最多收件人数（按附件数动态计算）。
 * 预算默认 45（免费版 50 子请求留 5 余量）。触顶会在循环中途抛错 → 部分邮件已发出、
 * 用户重试可能重复投递，所以必须留余量，不能贴着 50 用。
 * 付费版可在 wrangler.toml 把 MERGE_SUBREQ_BUDGET 调大。
 */
function mergeRecipientCap(env: Env, attachmentCount: number): number {
  const budget = clampInt(env.MERGE_SUBREQ_BUDGET ?? null, 45, 10000);
  const cost = perRecipientSubrequests(attachmentCount);
  return Math.max(1, Math.min(MAX_MERGE_RECIPIENTS, Math.floor(budget / cost)));
}

function parseAttachments(raw: unknown): ResendAttachment[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out: ResendAttachment[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') return null;
    const o = it as Record<string, unknown>;
    if (typeof o.filename !== 'string' || typeof o.content !== 'string') return null;
    if (o.content_type != null && typeof o.content_type !== 'string') return null;
    out.push({ filename: o.filename, content: o.content, content_type: o.content_type || undefined });
  }
  return out;
}

function safeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9._()+\- ]/g, '_').slice(0, 120) || 'attachment';
  return base;
}

/** 已发送附件：base64 -> R2 + attachments 行（供「已发送」回看/下载）。 */
async function storeOutboundAttachments(env: Env, messageId: string, files: ResendAttachment[]): Promise<void> {
  const rows: Array<{ filename: string; contentType: string; size: number; r2Key: string }> = [];
  for (const f of files) {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(f.content);
    } catch {
      continue;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) continue;
    const r2Key = `attachments/${messageId}/${uuid()}-${safeFilename(f.filename)}`;
    await env.BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType: f.content_type || 'application/octet-stream' },
    });
    rows.push({ filename: f.filename || 'attachment', contentType: f.content_type || 'application/octet-stream', size: bytes.length, r2Key });
  }
  if (rows.length) {
    await repo.insertOutboundAttachments(env, messageId, rows);
  }
}

/** 写信/回复统一正文：body 纯文本 + html 可选（富文本），互推回退。 */
function bodyFrom(b: { body?: unknown; html?: unknown }): { text: string; html: string } {
  const text = typeof b.body === 'string' ? b.body : '';
  const rawHtml = typeof b.html === 'string' ? b.html : '';
  if (rawHtml) {
    const fallbackText = text || stripHtml(rawHtml);
    return { text: fallbackText, html: rawHtml };
  }
  return { text, html: textToHtml(text) };
}

/**
 * 决定发件人：优先请求指定 mailbox，仅当其域名属于已验证发送域名时采用。
 * 同时返回**实际使用的显示名**，供出站入库（`from_name`）使用 ——
 * 否则收件箱里所有账户发出去的信都显示成全局 `SEND_FROM_NAME`。
 */
function resolveSender(
  env: Env,
  mailboxCandidate?: string
): { from: string; mailbox: string; fromName: string | null } {
  const identity = senderIdentity(env, mailboxCandidate || '');
  const mailbox = identity.address || (env.SEND_FROM_ADDRESS || '').trim().toLowerCase();
  return { from: identity.from, mailbox, fromName: identity.name || null };
}

interface MergeInput {
  recipients: string[];
  cc: string[];
  subject: string;
  content: { text: string; html: string };
  attachments: ResendAttachment[];
  sender: { from: string; mailbox: string; fromName: string | null };
  /** 全部发送成功后要丢弃的草稿 id。 */
  draftId?: string;
}

/**
 * 合并发送：串行地为每位收件人单独发送一封（正文/主题/附件完全相同），
 * 每人各存一条独立 outbound 记录（独立会话），单个失败不中断后续。
 *
 * 一律返回 HTTP 200：部分成功既非全对也非全错，前端据 `failed` 明细做「只重发失败者」。
 * `ok` 表示「是否**全部**成功」（`failed.length === 0`）；部分成功或全部失败都为 `false`，
 * 但状态码一律 200，调用方须看 `sent`/`failed` 明细。
 */
async function composeMerge(env: Env, input: MergeInput): Promise<Response> {
  const sent: Array<{ to: string; id: string; resend_id: string }> = [];
  const failed: Array<{ to: string; error: string }> = [];

  for (const addr of input.recipients) {
    let resendId: string;
    try {
      const result = await resendSend(env, {
        from: input.sender.from,
        to: [addr],
        cc: input.cc,
        subject: input.subject,
        text: input.content.text,
        html: input.content.html,
        attachments: input.attachments,
      });
      if (!result.ok) {
        failed.push({ to: addr, error: result.error || '发送失败' });
        continue;
      }
      resendId = result.id!;
    } catch (err) {
      failed.push({ to: addr, error: `发送失败: ${String(err)}` });
      continue;
    }

    // 邮件已经投递出去了：存库失败不能算「未发送」，否则用户重试会重复投递
    let rowId = '';
    try {
      rowId = await repo.saveOutbound(env, {
        inReplyTo: null,
        references: null,
        threadId: uuid(), // 每人独立会话
        mailbox: input.sender.mailbox,
        fromName: input.sender.fromName,
        fromEmail: input.sender.mailbox,
        to: [addr],
        cc: input.cc,
        subject: input.subject,
        html: input.content.html,
        text: input.content.text,
        resendId,
        receivedAt: nowSec(),
      });
      await storeOutboundAttachments(env, rowId, input.attachments).catch((err) => {
        console.error('storeOutboundAttachments failed:', err);
      });
    } catch (err) {
      console.error('merge saveOutbound failed:', err);
    }
    sent.push({ to: addr, id: rowId, resend_id: resendId });
  }

  // **全部成功**才丢弃草稿：部分成功时保留，用户可以从草稿箱重发失败的那几个
  // （删了草稿又没全发出去，等于把内容丢了）。
  if (failed.length === 0) await dropDraft(env, input.draftId);

  return json({
    ok: failed.length === 0,
    merge: true,
    total: input.recipients.length,
    sent_count: sent.length,
    failed_count: failed.length,
    sent,
    failed,
  });
}

async function compose(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; body?: unknown; html?: unknown; mailbox?: unknown; attachments?: unknown; merge?: unknown; draft_id?: unknown }
    | null;
  if (!body) return json({ error: '参数错误' }, 400);

  const { to, cc, bcc } = normalizeRecipients(
    parseRecipient(body.to),
    parseRecipient(body.cc),
    parseRecipient(body.bcc)
  );
  // to / cc / bcc 任一非空即可（只密送的邮件是合法的）
  if (!to.length && !cc.length && !bcc.length) return json({ error: '缺少收件人' }, 400);
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const content = bodyFrom(body);
  const attachments = parseAttachments(body.attachments);
  if (attachments === null) return json({ error: '附件格式错误' }, 400);

  const sender = resolveSender(env, typeof body.mailbox === 'string' ? body.mailbox : undefined);
  // 发信成功后要丢弃的草稿（前端自动保存时用的 id）
  const draftId = typeof body.draft_id === 'string' ? body.draft_id : '';

  // 合并发送：每位收件人各发一封独立邮件（内容与主题不变）
  if (body.merge === true) {
    // 合并发送的语义是「给每个人单独发一封」，而密送会让被密送者收到 N 封重复邮件。
    // 两者语义冲突 → 明确拒绝，而不是静默忽略 bcc（用户会以为密送生效了）。
    if (bcc.length) return json({ error: '合并发送不支持密送（BCC），请取消其中一个' }, 400);
    const recipients = dedupeRecipients(to);
    if (!recipients.length) return json({ error: '缺少收件人' }, 400);
    const cap = mergeRecipientCap(env, attachments.length);
    if (recipients.length > cap) {
      const why = attachments.length > 0 ? `（当前 ${attachments.length} 个附件）` : '';
      return json({ error: `单次合并发送最多 ${cap} 位收件人${why}` }, 400);
    }
    return composeMerge(env, { recipients, cc, subject, content, attachments, sender, draftId });
  }

  const result = await resendSend(env, {
    from: sender.from,
    to,
    cc,
    bcc,
    subject,
    text: content.text,
    html: content.html,
    attachments,
  });
  if (!result.ok) return json({ error: result.error }, 400);

  const rowId = await repo.saveOutbound(env, {
    inReplyTo: null,
    references: null,
    threadId: uuid(), // 独立会话
    mailbox: sender.mailbox,
    fromName: sender.fromName,
    fromEmail: sender.mailbox,
    to,
    cc,
    bcc,
    subject,
    html: content.html,
    text: content.text,
    resendId: result.id!,
    receivedAt: nowSec(),
  });

  await storeOutboundAttachments(env, rowId, attachments).catch((err) => {
    console.error('storeOutboundAttachments failed:', err);
  });
  await dropDraft(env, draftId);

  return json({ ok: true, id: rowId, resend_id: result.id });
}

async function reply(env: Env, request: Request, id: string): Promise<Response> {
  const original = await repo.getMessage(env, id);
  if (!original) return json({ error: '原邮件不存在' }, 404);
  if (original.direction !== 'inbound') {
    return json({ error: '只能回复收到的邮件' }, 400);
  }

  const raw = (await request.json().catch(() => null)) as
    | { to?: unknown; cc?: unknown; bcc?: unknown; body?: unknown; html?: unknown; attachments?: unknown; mailbox?: unknown; draft_id?: unknown }
    | null;
  const content = bodyFrom(raw || {});
  if (!content.text.trim() && !content.html.trim()) return json({ error: '回复内容为空' }, 400);

  const replyTo = parseAddressList(original.reply_to)[0] ?? parseAddress(original.from_email);
  if (!replyTo) return json({ error: '原邮件缺少发件地址' }, 400);

  // ⚠️ 曾经无条件 to: [replyTo.email] → 用户在回复框里补的收件人（逗号分隔）被**整段丢弃**：
  // 新人收不到信，发件箱记录也只留原发件人一人。
  // 现在以请求体的 to 为准（前端回复框预填原发件人，用户可再追加/编辑）；
  // 仅在请求体完全没给 to（老客户端 / 直接调 API）时才回退到从原邮件推导的那一个地址。
  const requestedTo = dedupeRecipients(parseRecipient(raw?.to));
  // cc / bcc 由用户自己填（不自动「回复全部」）；归一化会剔除与 to 重复的地址，避免重复投递。
  const { to, cc, bcc } = normalizeRecipients(
    requestedTo.length ? requestedTo : [replyTo.email],
    parseRecipient(raw?.cc),
    parseRecipient(raw?.bcc)
  );

  const attachments = parseAttachments(raw?.attachments);
  if (attachments === null) return json({ error: '附件格式错误' }, 400);

  const origMessageId = original.message_id || original.id;
  // References 链 = 原邮件的 References + 原邮件的 Message-ID（去重）。
  // ⚠️ 原邮件的 references 列存的是 Resend 给的 **JSON 数组文本**（见 util.parseReferences），
  // 旧实现把它整段拼进头部发回 Resend，导致转义层级逐轮嵌套（生产实测已到四层），
  // 且 thread_id 随之每轮漂移 —— 必须解析成规范的 `<id>` 列表再拼。
  const refChain = parseReferences(original.references);
  const seenRefs = new Set(refChain.map((x) => stripAngle(x)));
  if (origMessageId && !seenRefs.has(origMessageId)) refChain.push(`<${origMessageId}>`);
  const newReferences = refChain.join(' ');

  const subject = replySubject(original.subject);
  // 发件人：优先用户在「发件人」下拉里的选择（与 compose 完全同一口径），
  // 未指定时才沿用「收到原邮件的那个信箱」。
  // ⚠️ 曾经无条件用 original.mailbox → 回复时改选发件人完全不生效，发出的仍是原邮件的收件信箱。
  // 域名校验由 senderFromMailbox 兜底（非默认域会回退默认发件人），此处不做额外白名单。
  const requestedMailbox = typeof raw?.mailbox === 'string' ? raw.mailbox.trim() : '';
  const sender = resolveSender(env, requestedMailbox || original.mailbox || undefined);

  const result = await resendSend(env, {
    from: sender.from,
    to,
    cc,
    bcc,
    subject,
    text: content.text,
    html: content.html,
    attachments,
    headers: {
      'In-Reply-To': `<${origMessageId}>`,
      References: newReferences || `<${origMessageId}>`,
    },
  });
  if (!result.ok) return json({ error: result.error }, 400);

  // 会话归属：**优先继承原邮件（干净的）thread_id**。
  // 只按 References 推导是不够的 —— 对方客户端若只发 In-Reply-To 不发 References，
  // 推导出的根会退化成「原邮件的 message_id」，于是每往返一轮就新开一个会话，
  // 表现为「来回好几次却只显示两封」。原 thread_id 畸形（历史数据）时才回退推导。
  const derivedThread = rootThreadId({
    references: newReferences,
    inReplyTo: origMessageId,
    messageId: origMessageId,
    fallback: original.thread_id ?? uuid(),
  });
  const threadId = isSaneThreadId(original.thread_id) ? String(original.thread_id) : derivedThread;

  const rowId = await repo.saveOutbound(env, {
    inReplyTo: origMessageId,
    references: newReferences || null,
    threadId,
    mailbox: sender.mailbox,
    fromName: sender.fromName,
    fromEmail: sender.mailbox,
    to,
    cc,
    bcc,
    subject,
    html: content.html,
    text: content.text,
    resendId: result.id!,
    receivedAt: nowSec(),
  });

  await storeOutboundAttachments(env, rowId, attachments).catch((err) => {
    console.error('storeOutboundAttachments failed:', err);
  });
  await dropDraft(env, typeof raw?.draft_id === 'string' ? raw.draft_id : '');

  return json({ ok: true, id: rowId, resend_id: result.id, original_id: original.id });
}

/** 转发时原邮件附件的总大小上限（对齐 Resend 单封 40 MB）。 */
const MAX_FORWARD_TOTAL_BYTES = 40 * 1024 * 1024;

/** 把源邮件的附件复制到目标消息名下（新 R2 key），供转发使用。 */
async function copyAttachmentsToMessage(
  env: Env,
  messageId: string,
  source: Array<{ r2_key: string; filename: string; content_type: string }>
): Promise<void> {
  const rows: Array<{ filename: string; contentType: string; size: number; r2Key: string }> = [];
  for (const a of source) {
    const obj = await env.BUCKET.get(a.r2_key);
    if (!obj) continue;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const r2Key = `attachments/${messageId}/${uuid()}-${safeFilename(a.filename)}`;
    await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: a.content_type } });
    rows.push({ filename: a.filename, contentType: a.content_type, size: bytes.length, r2Key });
  }
  if (rows.length) await repo.insertOutboundAttachments(env, messageId, rows);
}

/**
 * 转发：**任意方向**的邮件都可以转发给任意收件人（不像回复只能回收到的邮件）。
 *
 * 关键语义：
 * - 主题补 `Fwd:` 前缀（已有则不重复叠加）；
 * - **不设** `In-Reply-To` / `References` —— 转发是**新会话**，带上就会串进原会话；
 * - 原邮件附件由**服务端**从 R2 读出随信发出，并复制到新 R2 key 落库
 *   （不能共用 key：`permanentDelete` 会删 R2 对象，共用会让「删除原邮件」连带删掉转发件的附件）；
 * - 内联图片（cid）不转发：正文引用走纯文本，带过去只会变成一堆无引用的图片附件；
 * - 附件读不到 / 合计超限时**不静默**：前者跳过并在响应里列出 `skipped_attachments`，
 *   后者直接 400 说明原因（宁可让用户自己删附件，也不要发出去一封少了一半附件的信）。
 */
async function forward(env: Env, request: Request, id: string): Promise<Response> {
  const original = await repo.getMessage(env, id);
  if (!original) return json({ error: '原邮件不存在' }, 404);

  const raw = (await request.json().catch(() => null)) as
    | {
        to?: unknown;
        cc?: unknown;
        bcc?: unknown;
        body?: unknown;
        html?: unknown;
        attachments?: unknown;
        mailbox?: unknown;
        include_original_attachments?: unknown;
        draft_id?: unknown;
      }
    | null;

  const { to, cc, bcc } = normalizeRecipients(
    parseRecipient(raw?.to),
    parseRecipient(raw?.cc),
    parseRecipient(raw?.bcc)
  );
  if (!to.length && !cc.length && !bcc.length) return json({ error: '缺少收件人' }, 400);

  const content = bodyFrom(raw || {});
  if (!content.text.trim() && !content.html.trim()) return json({ error: '转发内容为空' }, 400);

  const extra = parseAttachments(raw?.attachments);
  if (extra === null) return json({ error: '附件格式错误' }, 400);

  const includeOriginal = raw?.include_original_attachments !== false;
  const requestedMailbox = typeof raw?.mailbox === 'string' ? raw.mailbox.trim() : '';
  const sender = resolveSender(env, requestedMailbox || original.mailbox || undefined);

  // 读原附件：内联图片（cid）跳过；单个读不到也跳过，但**记录下来告知用户**
  const sourceRows = includeOriginal
    ? (await repo.listAttachments(env, id)).filter((a) => a.inline !== 1)
    : [];
  let totalBytes = extra.reduce((n, f) => n + approxBase64Bytes(f.content), 0);
  const originalFiles: ResendAttachment[] = [];
  const skipped: string[] = [];
  for (const a of sourceRows) {
    const obj = await env.BUCKET.get(a.r2_key);
    if (!obj) {
      skipped.push(a.filename);
      continue;
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    totalBytes += bytes.length;
    if (totalBytes > MAX_FORWARD_TOTAL_BYTES) {
      return json(
        { error: `附件合计超过 ${Math.floor(MAX_FORWARD_TOTAL_BYTES / 1024 / 1024)} MB，无法转发（可先删除部分附件）` },
        400
      );
    }
    originalFiles.push({ filename: a.filename, content: bytesToBase64(bytes), content_type: a.content_type });
  }

  const subject = forwardSubject(original.subject);
  const result = await resendSend(env, {
    from: sender.from,
    to,
    cc,
    bcc,
    subject,
    text: content.text,
    html: content.html,
    attachments: [...originalFiles, ...extra],
  });
  if (!result.ok) return json({ error: result.error }, 400);

  const rowId = await repo.saveOutbound(env, {
    inReplyTo: null,
    references: null,
    threadId: uuid(), // 转发开启新会话
    mailbox: sender.mailbox,
    fromName: sender.fromName,
    fromEmail: sender.mailbox,
    to,
    cc,
    bcc,
    subject,
    html: content.html,
    text: content.text,
    resendId: result.id!,
    receivedAt: nowSec(),
  });

  // 邮件已经投递出去了：附件落库失败不能当成「没发出去」（否则用户重试会重复投递）
  await storeOutboundAttachments(env, rowId, extra).catch((err) => {
    console.error('forward: storeOutboundAttachments failed:', err);
  });
  await copyAttachmentsToMessage(env, rowId, sourceRows).catch((err) => {
    console.error('forward: copyAttachmentsToMessage failed:', err);
  });
  await dropDraft(env, typeof raw?.draft_id === 'string' ? raw.draft_id : '');

  return json({
    ok: true,
    id: rowId,
    resend_id: result.id,
    original_id: original.id,
    forwarded_attachments: originalFiles.length,
    skipped_attachments: skipped,
  });
}
