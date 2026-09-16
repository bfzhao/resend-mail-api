import type { Env } from './types';
import { json, nowSec, parseAddress, parseAddressList, headerValueMap, stripAngle, stripHtml, uuid, rootThreadId } from './util';
import { Resend } from 'resend';
import { saveInbound, findInboundByResendId } from './repo';
import type { InboundInput } from './repo';
import { fetchReceivedEmail, listReceivedAttachmentDownloads, downloadSignedUrl } from './receiving';
import type { ReceivedEmail, AttachmentDownloadItem } from './receiving';

// ============ Resend 标准 Webhook 签名校验 ============
// 使用 Resend 官方 SDK 的 resend.webhooks.verify（内部基于 Svix 的 standardwebhooks 库做 HMAC-SHA256 校验）。
// 参考: https://resend.com/docs/webhooks/verify-webhooks-requests
// verify 只做本地计算、不发网络请求；构造 Resend 仅需要一个占位 key。
const resendClient = new Resend('re_00000000000000000000000000000000');

/** 基于原始 body 文本校验 Svix 签名。非法/缺失返回 false。 */
export function verifySignature(secret: string, rawBody: string, headers: Headers): boolean {
  const id = headers.get('svix-id') ?? headers.get('webhook-id');
  const timestamp = headers.get('svix-timestamp') ?? headers.get('webhook-timestamp');
  const signature = headers.get('svix-signature') ?? headers.get('webhook-signature');
  if (!id || !timestamp || !signature) return false;

  try {
    const options = {
      payload: rawBody,
      headers: { id, timestamp, signature },
      webhookSecret: secret,
    } as Parameters<typeof resendClient.webhooks.verify>[0];
    resendClient.webhooks.verify(options);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(request: Request): Promise<{ text: string; payload: T | null }> {
  const text = await request.text();
  try {
    return { text, payload: JSON.parse(text) as T };
  } catch {
    return { text, payload: null };
  }
}

// ============ 入站收信 (email.received) ============

interface SvixEnvelope {
  id?: string;
  type?: string;
  created_at?: string;
  data?: Record<string, unknown>;
}

function safeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9._()+\- ]/g, '_').slice(0, 120) || 'attachment';
  return base;
}

async function uploadToBucket(
  env: Env,
  messageId: string,
  filename: string,
  contentType: string,
  bytes: Uint8Array
): Promise<string> {
  const key = `attachments/${messageId}/${uuid()}-${safeFilename(filename)}`;
  await env.BUCKET.put(key, bytes, {
    httpMetadata: { contentType: contentType || 'application/octet-stream' },
  });
  return key;
}

function eventIdFrom(request: Request, payload?: SvixEnvelope | null): string | null {
  // Svix 事件 ID 在请求头里（svix-id / webhook-id），payload 里通常没有顶层 id
  return (
    request.headers.get('svix-id') ??
    request.headers.get('webhook-id') ??
    payload?.id ??
    null
  );
}

/** 判断这封入站邮件属于哪个本地收件地址（mailbox）。 */
function pickMailbox(email: ReceivedEmail, data: Record<string, unknown>): string {
  const receivedFor = data['received_for'];
  if (Array.isArray(receivedFor) && receivedFor.length && typeof receivedFor[0] === 'string') {
    const m = receivedFor[0].trim();
    if (m) return m.toLowerCase();
  }
  const candidates = (email.to?.length ? email.to : []) as Array<string | unknown>;
  const firstRaw = candidates.find((x): x is string => typeof x === 'string' && x.includes('@'));
  if (firstRaw) {
    const parsed = parseAddress(firstRaw);
    return (parsed?.email ?? firstRaw.trim()).toLowerCase();
  }
  const dataTo = data['to'];
  if (Array.isArray(dataTo) && dataTo.length && typeof dataTo[0] === 'string') {
    const parsed = parseAddress(dataTo[0]);
    if (parsed?.email) return parsed.email.toLowerCase();
  }
  return '';
}

export async function handleInbound(request: Request, env: Env): Promise<Response> {
  if (!env.RESEND_WEBHOOK_SECRET) {
    return json({ error: 'webhook secret not configured (RESEND_WEBHOOK_SECRET)' }, 503);
  }
  if (!env.RESEND_API_KEY) {
    return json({ error: 'RESEND_API_KEY not configured (needed to fetch received email content)' }, 503);
  }

  const { text, payload } = await readJson<SvixEnvelope>(request);
  const valid = verifySignature(env.RESEND_WEBHOOK_SECRET, text, request.headers);
  if (!valid) return json({ error: 'invalid signature' }, 401);

  const eventId = eventIdFrom(request, payload);
  const data = payload?.data;
  // 官方 email.received payload 顶层只有 type/created_at/data，无 id
  if (!eventId || !payload || payload.type !== 'email.received' || !data) {
    return json({ error: 'unexpected payload' }, 400);
  }
  const emailId = data && typeof data['email_id'] === 'string' ? data['email_id'] : null;
  if (!emailId) {
    return json({ error: 'unexpected payload: missing email_id' }, 400);
  }

  // 幂等：同一事件已处理过直接 200
  const dup = await env.DB.prepare('SELECT id FROM webhook_deliveries WHERE id = ?')
    .bind(eventId)
    .first();
  if (dup) return new Response('OK', { status: 200 });

  // 同一封邮件已入库（重复投递），仅记录本次事件
  const existingId = await findInboundByResendId(env, emailId);
  if (existingId) {
    await env.DB.prepare('INSERT OR IGNORE INTO webhook_deliveries (id, processed_at) VALUES (?, ?)')
      .bind(eventId, nowSec())
      .run();
    return new Response('OK', { status: 200 });
  }

  // webhook 只含元数据，正文/头需通过 Received Emails API 拉取（html_format=cid 保留内联图引用）
  let email: ReceivedEmail;
  try {
    email = await fetchReceivedEmail(env, emailId);
  } catch (err) {
    console.error('fetchReceivedEmail failed:', err);
    return json({ error: 'failed to fetch received email content', detail: String(err instanceof Error ? err.message : err) }, 502);
  }

  const rowId = uuid();
  const html = typeof email.html === 'string' ? email.html : null;
  const emailText = typeof email.text === 'string' ? email.text : null;
  const textBody = emailText ?? (html ? stripHtml(html) : null);

  const createdAtRaw =
    email.created_at ?? (typeof data['created_at'] === 'string' ? data['created_at'] : '') ?? '';
  const createdAt = createdAtRaw ? Math.floor(new Date(createdAtRaw).getTime() / 1000) : nowSec();

  const fromRaw = email.from ?? (typeof data['from'] === 'string' ? data['from'] : '');
  const from = parseAddress(fromRaw) ?? null;
  const fromDisplay = parseAddress(headerValueMap(email.headers, 'from'));
  const fromName = fromDisplay?.name ?? from?.name ?? null;
  const fromEmail = (from?.email ?? fromRaw) || null;

  const rawMessageId =
    email.message_id ?? (typeof data['message_id'] === 'string' ? data['message_id'] : null);

  // 会话归组：取 References/In-Reply-To 里的根 Message-ID
  const refsRaw = headerValueMap(email.headers, 'References');
  const inReplyRaw = headerValueMap(email.headers, 'In-Reply-To');
  const mailbox = pickMailbox(email, data);

  const input: InboundInput = {
    rowId,
    resendId: emailId,
    messageId: stripAngle(rawMessageId),
    inReplyTo: inReplyRaw ? stripAngle(inReplyRaw) : null,
    references: refsRaw ?? null,
    threadId: rootThreadId({
      references: refsRaw,
      inReplyTo: inReplyRaw,
      messageId: rawMessageId,
      fallback: rowId,
    }),
    mailbox,
    fromName,
    fromEmail,
    to: parseAddressList(email.to ?? data['to']).map((a) => a.email),
    cc: parseAddressList(email.cc ?? data['cc']).map((a) => a.email),
    bcc: parseAddressList(email.bcc ?? data['bcc']).map((a) => a.email),
    replyTo: parseAddressList(email.reply_to ?? []).map((a) => a.email),
    subject: email.subject ?? (typeof data['subject'] === 'string' ? data['subject'] : null),
    html,
    text: textBody,
    receivedAt: Number.isFinite(createdAt) ? createdAt : nowSec(),
    attachments: [],
  };

  // 下载附件到 R2：通过附件 API 拿 signed download_url
  const metas = Array.isArray(email.attachments) ? email.attachments : [];
  if (metas.length) {
    let downloads: Map<string, AttachmentDownloadItem>;
    try {
      downloads = await listReceivedAttachmentDownloads(env, emailId);
    } catch (err) {
      console.error('listReceivedAttachmentDownloads failed:', err);
      downloads = new Map();
    }
    for (const meta of metas) {
      const dl = downloads.get(meta.id);
      if (!dl) {
        console.error('no download url for attachment:', meta.id);
        continue;
      }
      try {
        const downloaded = await downloadSignedUrl(dl.download_url);
        let contentType =
          (downloaded.contentType && !downloaded.contentType.startsWith('application/octet-stream'))
            ? downloaded.contentType
            : (meta.content_type || 'application/octet-stream');
        if (contentType.includes(';')) contentType = contentType.split(';')[0].trim();

        const contentId = meta.content_id ? stripAngle(meta.content_id) : null;
        const inline =
          contentId != null || meta.content_disposition === 'inline' ? 1 : 0;
        const r2Key = await uploadToBucket(
          env,
          rowId,
          meta.filename || 'attachment',
          contentType,
          downloaded.bytes
        );
        input.attachments.push({
          filename: meta.filename || 'attachment',
          contentType,
          size: downloaded.bytes.length,
          inline,
          contentId,
          r2Key,
        });
      } catch (err) {
        console.error('attachment store failed:', meta.id, err);
      }
    }
  }

  try {
    await saveInbound(env, input, eventId);
  } catch (err) {
    // 冲突/瞬时错误：返回 500，让 Resend 稍后重试（幂等表保证不重复）
    console.error('saveInbound failed:', err);
    return json({ error: `storage failed: ${err}` }, 500);
  }

  return new Response('OK', { status: 200 });
}

// ============ 出站回执 (email.sent / delivered / ...) ============
const STATUS_MAP: Record<string, string> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complaint',
  'email.failed': 'failed',
};

export async function handleEvents(request: Request, env: Env): Promise<Response> {
  const secret = env.RESEND_EVENTS_SECRET || env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return json({ error: 'webhook secret not configured (RESEND_EVENTS_SECRET / RESEND_WEBHOOK_SECRET)' }, 503);
  }
  const { text, payload } = await readJson<SvixEnvelope>(request);
  const valid = verifySignature(secret, text, request.headers);
  if (!valid) return json({ error: 'invalid signature' }, 401);

  const eventId = eventIdFrom(request, payload);
  const type = payload?.type;
  const data = payload?.data;
  if (!eventId || !type || !data) return json({ error: 'unexpected payload' }, 400);
  if (!type.startsWith('email.')) return new Response('OK', { status: 200 });

  const resendEmailId = (data['email_id'] as string) ?? (data['id'] as string) ?? null;
  const status = STATUS_MAP[type];

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      'INSERT OR IGNORE INTO webhook_deliveries (id, processed_at) VALUES (?, ?)'
    ).bind(eventId, nowSec()),
  ];

  if (resendEmailId) {
    const row = await env.DB.prepare('SELECT id, direction FROM messages WHERE resend_id = ? LIMIT 1')
      .bind(resendEmailId)
      .first<{ id: string; direction: string }>();
    if (row) {
      stmts.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO delivery_events (id, message_id, event_type, created_at, data) VALUES (?, ?, ?, ?, ?)'
        ).bind(eventId, row.id, type, nowSec(), text)
      );
      if (status) {
        stmts.push(
          env.DB.prepare('UPDATE messages SET status = ?, updated_at = ? WHERE id = ?').bind(status, nowSec(), row.id)
        );
      }
    }
  }

  await env.DB.batch(stmts);
  return new Response('OK', { status: 200 });
}
