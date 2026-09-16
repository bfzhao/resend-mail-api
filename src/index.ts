import type { Env, Folder } from './types';
import { authenticate, unauthorized } from './auth';
import { handleInbound, handleEvents } from './webhook';
import * as repo from './repo';
import { resendSend, replySubject, textToHtml, senderFromMailbox } from './send';
import type { ResendAttachment } from './send';
import { json, jsonArr, nowSec, parseAddress, parseAddressList, rootThreadId, uuid, base64ToBytes, stripHtml } from './util';

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

  // 侧边栏计数（可按 mailbox 过滤）
  if (path === '/api/counts' && method === 'GET') {
    const mailbox = url.searchParams.get('mailbox') || undefined;
    return json(await repo.sidebarCounts(env, mailbox));
  }

  // 收件地址列表（多邮箱切换）
  if (path === '/api/mailboxes' && method === 'GET') {
    return json({ mailboxes: await repo.mailboxes(env) });
  }

  // 账户/发送能力信息（供写信界面显示发件人）
  if (path === '/api/account' && method === 'GET') {
    return json({
      can_send: Boolean(env.RESEND_API_KEY && env.SEND_FROM_ADDRESS),
      from_name: env.SEND_FROM_NAME || '',
      from_address: env.SEND_FROM_ADDRESS || '',
    });
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

  // 附件代理：/api/attachments/:id
  const attachmentMatch = /^\/api\/attachments\/([^/]+)$/.exec(path);
  if (attachmentMatch && method === 'GET') {
    const resp = await repo.proxyAttachment(env, decodeURIComponent(attachmentMatch[1]));
    if (!resp) return json({ error: '附件不存在' }, 404);
    return resp;
  }

  return json({ error: 'Not Found' }, 404);
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

  const attachments = (await repo.listAttachments(env, id)).map((a) => ({
    id: a.id,
    message_id: a.message_id,
    filename: a.filename,
    content_type: a.content_type,
    size: a.size,
    inline: a.inline === 1,
    content_id: a.content_id,
    url: `/api/attachments/${a.id}`,
  }));

  // 会话上下文（同一 thread_id 内，按时间升序）
  let thread: Array<Record<string, unknown>> = [];
  if (message.thread_id) {
    thread = (await repo.listThread(env, message.thread_id)).map((t) => ({
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
      current: t.id === id,
    }));
  }

  const { to_emails, cc, bcc, reply_to, ...rest } = message;
  return json({
    message: {
      ...rest,
      id,
      to_emails: jsonArr(to_emails),
      cc: jsonArr(cc),
      bcc: jsonArr(bcc),
      reply_to: jsonArr(reply_to),
    },
    attachments,
    thread,
  });
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
  if (typeof raw === 'string') return [raw.trim()].filter(Boolean);
  return [];
}

const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024; // 对齐 Resend 附件上限

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

/** 决定发件人：优先请求指定 mailbox，仅当其域名属于已验证发送域名时采用。 */
function resolveSender(env: Env, mailboxCandidate?: string): { from: string; mailbox: string } {
  const defaultAddr = (env.SEND_FROM_ADDRESS || '').trim().toLowerCase();
  const from = senderFromMailbox(env, mailboxCandidate || '');
  // senderFromMailbox 已回退到默认地址；这里把实际使用的地址取出来作为 mailbox 存库
  const used = /<([^>]+)>/.exec(from)?.[1] || from || '';
  const mailbox = used.toLowerCase() || defaultAddr;
  return { from, mailbox };
}

async function compose(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { to?: unknown; cc?: unknown; subject?: unknown; body?: unknown; html?: unknown; mailbox?: unknown; attachments?: unknown }
    | null;
  if (!body) return json({ error: '参数错误' }, 400);

  const to = parseRecipient(body.to);
  if (!to.length) return json({ error: '缺少收件人' }, 400);
  const cc = parseRecipient(body.cc);
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const content = bodyFrom(body);
  const attachments = parseAttachments(body.attachments);
  if (attachments === null) return json({ error: '附件格式错误' }, 400);

  const sender = resolveSender(env, typeof body.mailbox === 'string' ? body.mailbox : undefined);

  const result = await resendSend(env, {
    from: sender.from,
    to,
    cc,
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
    fromName: env.SEND_FROM_NAME || null,
    fromEmail: sender.mailbox,
    to,
    cc,
    subject,
    html: content.html,
    text: content.text,
    resendId: result.id!,
    receivedAt: nowSec(),
  });

  await storeOutboundAttachments(env, rowId, attachments).catch((err) => {
    console.error('storeOutboundAttachments failed:', err);
  });

  return json({ ok: true, id: rowId, resend_id: result.id });
}

async function reply(env: Env, request: Request, id: string): Promise<Response> {
  const original = await repo.getMessage(env, id);
  if (!original) return json({ error: '原邮件不存在' }, 404);
  if (original.direction !== 'inbound') {
    return json({ error: '只能回复收到的邮件' }, 400);
  }

  const raw = (await request.json().catch(() => null)) as { body?: unknown; html?: unknown; attachments?: unknown } | null;
  const content = bodyFrom(raw || {});
  if (!content.text.trim() && !content.html.trim()) return json({ error: '回复内容为空' }, 400);

  const replyTo = parseAddressList(original.reply_to)[0] ?? parseAddress(original.from_email);
  if (!replyTo) return json({ error: '原邮件缺少发件地址' }, 400);

  const attachments = parseAttachments(raw?.attachments);
  if (attachments === null) return json({ error: '附件格式错误' }, 400);

  const origMessageId = original.message_id || original.id;
  const newReferences = [original.references, `<${origMessageId}>`]
    .filter((s): s is string => Boolean(s && s.trim()))
    .map((s) => s.trim())
    .join(' ')
    .replace(/\s+/g, ' ');

  const subject = replySubject(original.subject);
  const sender = resolveSender(env, original.mailbox || undefined);

  const result = await resendSend(env, {
    from: sender.from,
    to: [replyTo.email],
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

  const threadId = rootThreadId({
    references: newReferences,
    inReplyTo: origMessageId,
    messageId: origMessageId,
    fallback: original.thread_id ?? uuid(),
  });

  const rowId = await repo.saveOutbound(env, {
    inReplyTo: origMessageId,
    references: newReferences || null,
    threadId,
    mailbox: sender.mailbox,
    fromName: env.SEND_FROM_NAME || null,
    fromEmail: sender.mailbox,
    to: [replyTo.email],
    cc: [],
    subject,
    html: content.html,
    text: content.text,
    resendId: result.id!,
    receivedAt: nowSec(),
  });

  await storeOutboundAttachments(env, rowId, attachments).catch((err) => {
    console.error('storeOutboundAttachments failed:', err);
  });

  return json({ ok: true, id: rowId, resend_id: result.id, original_id: original.id });
}
