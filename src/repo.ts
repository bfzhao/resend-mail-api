import type { AttachmentRow, Env, Folder, MessageRow } from './types';
import { nowSec, uuid, contentDisposition } from './util';

export interface PreparedAttachment {
  filename: string;
  contentType: string;
  size: number;
  inline: number;
  contentId: string | null;
  r2Key: string;
}

export interface InboundInput {
  rowId: string;
  messageId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  receivedAt: number;
  attachments: PreparedAttachment[];
}

export interface OutboundInput {
  messageId?: string | null;
  inReplyTo: string | null;
  references: string | null;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  resendId: string;
  receivedAt: number;
}

const LIST_LIMIT = 50;
const LIST_MAX = 200;

export interface ListOpts {
  folder: Folder;
  q?: string | null;
  unread?: boolean;
  limit: number;
  offset: number;
}

interface FolderRow {
  id: string;
  direction: string;
  from_name: string | null;
  from_email: string | null;
  subject: string | null;
  to_emails: string;
  preview: string | null;
  received_at: number;
  read: number;
  starred: number;
  status: string;
  attachments_count: number;
}

/** 已存附件上传到 R2 后组装出的 DB 行参数已含于 attachments[]。 */
function whereForFolder(folder: Folder, q: string | null | undefined, unread: boolean): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  switch (folder) {
    case 'inbox':
      conds.push("direction = 'inbound'", 'deleted = 0');
      if (unread) conds.push('read = 0');
      break;
    case 'sent':
      conds.push("direction = 'outbound'", 'deleted = 0');
      break;
    case 'starred':
      conds.push('starred = 1', 'deleted = 0');
      break;
    case 'trash':
      conds.push('deleted = 1');
      break;
  }
  if (q) {
    const like = `%${q}%`;
    conds.push('(subject LIKE ? OR from_name LIKE ? OR from_email LIKE ? OR body_text LIKE ? OR to_emails LIKE ?)');
    params.push(like, like, like, like, like);
  }
  return { sql: conds.join(' AND '), params };
}

const LIST_SELECT = `SELECT
    m.id, m.direction, m.from_name, m.from_email, m.subject, m.to_emails,
    substr(coalesce(NULLIF(m.body_text, ''), ''), 1, 200) AS preview,
    m.received_at, m.read, m.starred, m.status,
    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachments_count
  FROM messages m`;

export async function listFolder(env: Env, opts: ListOpts): Promise<{ items: FolderRow[]; total: number }> {
  const w = whereForFolder(opts.folder, opts.q, opts.unread === true);
  const whereSql = w.sql ? `WHERE ${w.sql}` : '';

  const items = (
    await env.DB.prepare(
      `${LIST_SELECT} ${whereSql} ORDER BY m.received_at DESC LIMIT ? OFFSET ?`
    )
      .bind(...w.params, opts.limit, opts.offset)
      .all<FolderRow>()
  ).results;

  const totalRow = (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages m ${whereSql}`).bind(...w.params).first<{ n: number }>()
  )?.n ?? 0;

  return { items, total: totalRow };
}

export async function sidebarCounts(env: Env): Promise<{
  inbox_unread: number;
  inbox_total: number;
  sent_total: number;
  starred_total: number;
  trash_total: number;
}> {
  const row = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN direction='inbound' AND deleted=0 AND read=0 THEN 1 ELSE 0 END) AS inbox_unread,
      SUM(CASE WHEN direction='inbound' AND deleted=0 THEN 1 ELSE 0 END) AS inbox_total,
      SUM(CASE WHEN direction='outbound' AND deleted=0 THEN 1 ELSE 0 END) AS sent_total,
      SUM(CASE WHEN starred=1 AND deleted=0 THEN 1 ELSE 0 END) AS starred_total,
      SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) AS trash_total
     FROM messages`
  ).first<{ inbox_unread: number | null; inbox_total: number | null; sent_total: number | null; starred_total: number | null; trash_total: number | null }>();

  return {
    inbox_unread: row?.inbox_unread ?? 0,
    inbox_total: row?.inbox_total ?? 0,
    sent_total: row?.sent_total ?? 0,
    starred_total: row?.starred_total ?? 0,
    trash_total: row?.trash_total ?? 0,
  };
}

export async function getMessage(env: Env, id: string): Promise<MessageRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<MessageRow>()) ?? null
  );
}

export async function listAttachments(env: Env, messageId: string): Promise<AttachmentRow[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM attachments WHERE message_id = ? ORDER BY inline DESC, created_at ASC'
  ).bind(messageId).all<AttachmentRow>();
  return rows.results;
}

export async function markRead(env: Env, id: string): Promise<void> {
  await env.DB.prepare('UPDATE messages SET read = 1, updated_at = ? WHERE id = ?')
    .bind(nowSec(), id)
    .run();
}

export interface PatchBody {
  read?: boolean;
  starred?: boolean;
  deleted?: boolean;
}

export async function patchMessage(env: Env, id: string, patch: PatchBody): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.read !== undefined) {
    sets.push('read = ?');
    params.push(patch.read ? 1 : 0);
  }
  if (patch.starred !== undefined) {
    sets.push('starred = ?');
    params.push(patch.starred ? 1 : 0);
  }
  if (patch.deleted !== undefined) {
    sets.push('deleted = ?');
    params.push(patch.deleted ? 1 : 0);
  }
  if (!sets.length) return false;
  sets.push('updated_at = ?');
  params.push(nowSec(), id);
  const res = await env.DB.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  return res.meta.changes > 0;
}

export type BatchAction =
  | 'read'
  | 'unread'
  | 'star'
  | 'unstar'
  | 'trash'
  | 'restore'
  | 'delete';

async function permanentDelete(env: Env, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const attachRows = (
    await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id IN (${placeholders})`)
      .bind(...ids)
      .all<{ r2_key: string }>()
  ).results;

  await env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).bind(...ids).run();
  await env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${placeholders})`).bind(...ids).run();
  await env.DB.prepare(`DELETE FROM delivery_events WHERE message_id IN (${placeholders})`).bind(...ids).run();

  await Promise.all(
    attachRows.map((r) => env.BUCKET.delete(r.r2_key).catch(() => undefined))
  );
  return attachRows.length;
}

export async function batchAction(env: Env, ids: string[], action: BatchAction): Promise<{ changed: number }> {
  if (!ids.length) return { changed: 0 };
  const clean = [...new Set(ids)];
  if (action === 'delete') {
    await permanentDelete(env, clean);
    return { changed: clean.length };
  }

  let col: string;
  let value: number;
  switch (action) {
    case 'read':
      col = 'read';
      value = 1;
      break;
    case 'unread':
      col = 'read';
      value = 0;
      break;
    case 'star':
      col = 'starred';
      value = 1;
      break;
    case 'unstar':
      col = 'starred';
      value = 0;
      break;
    case 'trash':
      col = 'deleted';
      value = 1;
      break;
    case 'restore':
      col = 'deleted';
      value = 0;
      break;
    default:
      return { changed: 0 };
  }
  const placeholders = clean.map(() => '?').join(',');
  const res = await env.DB.prepare(`UPDATE messages SET ${col} = ?, updated_at = ? WHERE id IN (${placeholders})`)
    .bind(value, nowSec(), ...clean)
    .run();
  return { changed: res.meta.changes };
}

function insertMessageStmt(env: Env, row: {
  id: string;
  direction: 'inbound' | 'outbound';
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  receivedAt: number;
  status: string;
  resendId: string | null;
}): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO messages
      (id, direction, message_id, in_reply_to, "references", from_name, from_email,
       to_emails, cc, bcc, reply_to, subject, body_html, body_text, received_at,
       status, resend_id, read, starred, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`
  ).bind(
    row.id,
    row.direction,
    row.messageId,
    row.inReplyTo,
    row.references,
    row.fromName,
    row.fromEmail,
    JSON.stringify(row.to),
    row.cc.length ? JSON.stringify(row.cc) : null,
    row.bcc.length ? JSON.stringify(row.bcc) : null,
    row.replyTo.length ? JSON.stringify(row.replyTo) : null,
    row.subject,
    row.html,
    row.text,
    row.receivedAt,
    row.status,
    row.resendId,
    nowSec(),
    nowSec()
  );
}

/** 入站消息 + 附件 + webhook 幂等记录，在同一个 D1 批事务里原子写入。 */
export async function saveInbound(env: Env, input: InboundInput, deliveryEventId: string): Promise<void> {
  const stmts: D1PreparedStatement[] = [
    insertMessageStmt(env, {
      id: input.rowId,
      direction: 'inbound',
      messageId: input.messageId,
      inReplyTo: null,
      references: null,
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      replyTo: input.replyTo,
      subject: input.subject,
      html: input.html,
      text: input.text,
      receivedAt: input.receivedAt,
      status: 'received',
      resendId: null,
    }),
  ];

  for (const a of input.attachments) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO attachments (id, message_id, r2_key, filename, content_type, size, inline, content_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(uuid(), input.rowId, a.r2Key, a.filename, a.contentType, a.size, a.inline, a.contentId, nowSec())
    );
  }

  stmts.push(
    env.DB.prepare('INSERT OR IGNORE INTO webhook_deliveries (id, processed_at) VALUES (?, ?)').bind(
      deliveryEventId,
      nowSec()
    )
  );

  await env.DB.batch(stmts);
}

export async function saveOutbound(env: Env, input: OutboundInput): Promise<string> {
  const rowId = uuid();
  const messageId = input.messageId ?? rowId;
  await insertMessageStmt(env, {
    id: rowId,
    direction: 'outbound',
    messageId,
    inReplyTo: input.inReplyTo,
    references: input.references,
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    to: input.to,
    cc: input.cc,
    bcc: [],
    replyTo: [],
    subject: input.subject,
    html: input.html,
    text: input.text,
    receivedAt: input.receivedAt,
    status: 'sent',
    resendId: input.resendId,
  }).run();
  return rowId;
}

/** 附件元数据表存在性（供代理读取用）。 */
export async function getAttachment(env: Env, id: string): Promise<AttachmentRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first<AttachmentRow>()) ?? null
  );
}

export async function proxyAttachment(env: Env, id: string): Promise<Response | null> {
  const row = await getAttachment(env, id);
  if (!row) return null;
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) return null;

  const type = row.content_type && !row.content_type.startsWith('text/html')
    ? row.content_type
    : 'application/octet-stream';
  // 内联图片允许预览；其余一律下载，防止把用户上传内容当页面打开。
  const inline = type.startsWith('image/');
  const headers = new Headers();
  headers.set('Content-Type', type);
  headers.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', row.filename));
  headers.set('Content-Length', String(obj.size));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, max-age=3600');

  if (!obj.body) return null;
  return new Response(obj.body, { headers });
}
