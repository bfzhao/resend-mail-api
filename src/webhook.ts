import type { Env } from './types';
import { json, nowSec, parseAddress, parseAddressList, headerValue, stripAngle, stripHtml, base64ToBytes, uuid } from './util';
import { Resend } from 'resend';
import { saveInbound } from './repo';
import type { InboundInput } from './repo';

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

export async function handleInbound(request: Request, env: Env): Promise<Response> {
  if (!env.RESEND_WEBHOOK_SECRET) {
    return json({ error: 'webhook secret not configured (RESEND_WEBHOOK_SECRET)' }, 503);
  }
  const { text, payload } = await readJson<SvixEnvelope>(request);
  const valid = verifySignature(env.RESEND_WEBHOOK_SECRET, text, request.headers);
  if (!valid) return json({ error: 'invalid signature' }, 401);

  const eventId = payload?.id;
  if (!eventId || !payload || payload.type !== 'email.received' || !payload.data) {
    return json({ error: 'unexpected payload' }, 400);
  }
  const data = payload.data;

  // 幂等：同一事件已处理过直接 200
  const dup = await env.DB.prepare('SELECT id FROM webhook_deliveries WHERE id = ?')
    .bind(eventId)
    .first();
  if (dup) return new Response('OK', { status: 200 });

  const headersRaw = data['headers'];
  const msgId = headerValue(headersRaw, 'Message-ID') ?? (data['message_id'] as string) ?? null;
  const fromRaw = typeof data['from'] === 'string' ? data['from'] : String(data['from'] ?? '');
  const from = parseAddress(fromRaw) ?? { name: null, email: '' };

  const html = typeof data['html'] === 'string' ? data['html'] : null;
  const textRaw = typeof data['text'] === 'string' ? data['text'] : null;
  const textBody = textRaw ?? (html ? stripHtml(html) : null);

  const createdAtRaw = (data['created_at'] as string) || payload.created_at || '';
  const createdAt = createdAtRaw ? Math.floor(new Date(createdAtRaw).getTime() / 1000) : nowSec();

  const attachmentsRaw = Array.isArray(data['attachments']) ? (data['attachments'] as Array<Record<string, unknown>>) : [];
  const input: InboundInput = {
    rowId: uuid(),
    messageId: stripAngle(msgId),
    fromName: from.name,
    fromEmail: from.email || null,
    to: parseAddressList(data['to']).map((a) => a.email),
    cc: parseAddressList(data['cc']).map((a) => a.email),
    bcc: parseAddressList(data['bcc']).map((a) => a.email),
    replyTo: parseAddressList(data['reply_to'] ?? data['replyTo']).map((a) => a.email),
    subject: typeof data['subject'] === 'string' ? data['subject'] : null,
    html,
    text: textBody,
    receivedAt: Number.isFinite(createdAt) ? createdAt : nowSec(),
    attachments: [],
  };

  for (const item of attachmentsRaw) {
    const content = item['content'];
    if (typeof content !== 'string' || !content) continue;
    const filename = typeof item['filename'] === 'string' ? item['filename'] : 'attachment';
    let contentType = typeof item['content_type'] === 'string' ? item['content_type'] : 'application/octet-stream';
    if (!contentType || contentType === 'application/octet-stream' || contentType.includes(';')) {
      const base = contentType.split(';')[0].trim();
      contentType = base || 'application/octet-stream';
    }
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(content);
    } catch {
      continue;
    }
    const rawCid = (item['content_id'] as string) ?? (typeof item['id'] === 'string' ? item['id'] : null);
    const contentId = rawCid ? stripAngle(rawCid) : null;
    const inline = contentId ? 1 : 0;

    const r2Key = await uploadToBucket(env, input.rowId, filename, contentType, bytes);
    input.attachments.push({
      filename,
      contentType,
      size: bytes.length,
      inline,
      contentId,
      r2Key,
    });
  }

  try {
    await saveInbound(env, input, eventId);
  } catch (err) {
    // 冲突/瞬时错误：返回 500，让 Resend 稍后重试（幂等表保证不重复）
    console.error('saveInbound failed:', err);
    return json({ error: 'storage failed' }, 500);
  }

  return new Response('OK', { status: 200 });
}

// ============ 出站回执 (email.sent / delivered / ...) ============
const STATUS_MAP: Record<string, string> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complaint': 'complaint',
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

  const eventId = payload?.id;
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
