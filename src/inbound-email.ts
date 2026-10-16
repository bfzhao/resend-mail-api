import PostalMime from 'postal-mime';
import type { Address as PostalAddress, Attachment as PostalAttachment, Email as PostalEmail } from 'postal-mime';
import type { Env, InboundQueueMessage, InboundRawRow } from './types';
import type { InboundInput, PreparedAttachment } from './repo';
import { findInboundByResendId, saveInbound } from './repo';
import { nowSec, parseReferences, rootThreadId, stripAngle, stripHtml, uuid } from './util';

/**
 * Cloudflare Email Routing 入向（替代 Resend 入向的新主路径）。
 *
 * ⚠️ 与 Resend 的根本差别：**CF 不存信**（Email Routing 是路由器，官方无任何接口能重拉已收邮件）。
 * 所以这里的首要目标是「**绝不丢**」，其次才是「解析好」。两段式流水线：
 *
 *   1. `handleInboundEmail()`（`email()` handler）
 *      —— 读头 + 把 `message.raw` **流式**落 R2 + 在 `inbound_raw` 登记一行 + 入队（只发 id 指针）。
 *      这一段的成本与邮件大小无关（不整读进内存），Free 档 10ms CPU 也扛得住。
 *   2. `handleInboundQueue()`（`queue()` consumer）
 *      —— 从 R2 取原始件 → postal-mime 解析 → **复用现有 `saveInbound()`** 写 messages/attachments
 *        → 回填 `inbound_raw.parsed_at` / `message_row`。
 *
 * 数据兼容：解析结果组装成与 Resend 入向**完全相同**的 `InboundInput`，落到**同一套** `messages` /
 * `attachments` 表（列不变）。历史行、以及仍启用的 `/webhook/inbound`（Resend 回退路径）互不影响。
 */

/** 原始 .eml 在 R2 的前缀。 */
const RAW_PREFIX = 'inbound-raw/';
/** 解析/入库瞬时失败最多重试几次；超过则保留为「待办」交给恢复 cron，避免毒消息拖垮整批，又不丢。 */
const MAX_RAW_ATTEMPTS = 5;
/** 单次 `email()`/`queue()` 内对 D1/R2/Queue 的小幅退避重试次数（CF 只给一次收信机会，能不放弃就不放弃）。 */
const RETRY_ATTEMPTS = 3;
/**
 * D1「单行/字符串/BLOB」硬上限是 2,000,000 字节。`messages` 一行含 body_html + body_text + References 等，
 * 超了就**永久性**写不进去（同一份数据重试多少次都一样）。这里用比上限更保守的预算提前判定，
 * 命中即标终态、移出队列、停止重试（原始 .eml 仍在 R2，可在「入站异常」处下载）。
 */
const MAX_MESSAGE_ROW_BYTES = 1_900_000;

const UTF8 = new TextEncoder();

/** UTF-8 字节数（D1 的「行大小」按字节算，CJK 一个字符最多 3 字节，不能拿 .length 当数）。 */
function utf8Bytes(s: string | null | undefined): number {
  if (!s) return 0;
  return UTF8.encode(s).length;
}

/**
 * 是否**永久性**写库失败：同一份数据重试多少次都一样，应标终态并停止重试。
 *  - 行/字段超 D1 上限（`too big` / `too large` / `SQLITE_TOOBIG`）；
 *  - 约束冲突（NOT NULL / UNIQUE 等）。
 * 其余（网络、D1 overloaded、超时）当作瞬时，走重试。
 */
function isPermanentSaveError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /too big|too large|sqlite_toobig/.test(m) || /constraint failed|constraint violation/.test(m);
}

/** 小步退避重试：`fn` 抛错则以 50ms、100ms… 递增延迟重试，直到成功或耗尽次数后抛出最后一个错误。 */
async function withRetry<T>(fn: () => Promise<T>, attempts = RETRY_ATTEMPTS): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  throw lastErr;
}

interface SimpleAddress {
  name: string | null;
  email: string;
}

/** 把 postal-mime 的地址（含 group 形态）拍平为扁平地址列表。 */
function flattenAddresses(addrs: PostalAddress[] | undefined): SimpleAddress[] {
  const out: SimpleAddress[] = [];
  for (const a of addrs ?? []) {
    if (!a) continue;
    if (a.group) {
      for (const g of a.group) {
        if (g.address) out.push({ name: g.name?.trim() || null, email: g.address.trim().toLowerCase() });
      }
    } else if (a.address) {
      out.push({ name: a.name?.trim() || null, email: a.address.trim().toLowerCase() });
    }
  }
  return out;
}

/** From 头是单值，取第一个可解析地址。 */
function primaryAddress(a: PostalAddress | undefined): SimpleAddress | null {
  const first = flattenAddresses(a ? [a] : undefined)[0];
  return first ?? null;
}

/** 取 References / In-Reply-To 头里第一个 Message-ID（去尖括号）。口径同 `webhook.ts`。 */
function firstRef(raw: string | null | undefined): string | null {
  const first = parseReferences(raw)[0];
  return first ? stripAngle(first) : null;
}

function safeFilename(name: string): string {
  return name.replace(/[\\/]/g, '_').replace(/[^A-Za-z0-9._()+\- ]/g, '_').slice(0, 120) || 'attachment';
}

/** postal-mime 的附件内容 → 字节。内容可能是 ArrayBuffer / Uint8Array / string（视编码而变）。 */
function toBytes(content: PostalAttachment['content']): Uint8Array | null {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return null;
}

export interface EnvelopeInfo {
  /** 信封发件人（SMTP MAIL FROM）。 */
  from: string;
  /** 信封收件人（投递地址 = mailbox）。 */
  to: string;
  /** `inbound_raw.id`，用作合成 provider id 的兜底与幂等 event id。 */
  rawId: string;
}

/**
 * 解析原始 MIME → `InboundInput`（与 Resend 入向同形状）。
 * 附件一并上传到 R2（`attachments/{rowId}/…`，key 规则与现有代码一致）。
 */
export async function buildInboundInput(
  env: Env,
  raw: ArrayBuffer | Uint8Array,
  envelope: EnvelopeInfo
): Promise<InboundInput> {
  const email: PostalEmail = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
  const rowId = uuid();

  const from = primaryAddress(email.from);
  const envelopeFrom = (envelope.from || '').trim().toLowerCase();
  const fromEmail = from?.email || envelopeFrom || null;
  const fromName = from?.name ?? null;

  // 信封收件人 = 投递地址（mailbox / delivered_to）。CF 的 `message.to` 就是它。
  const deliveredTo = envelope.to ? [envelope.to.trim().toLowerCase()] : [];
  const headerTo = flattenAddresses(email.to).map((a) => a.email);
  const cc = flattenAddresses(email.cc).map((a) => a.email);
  const bcc = flattenAddresses(email.bcc).map((a) => a.email);
  const replyTo = flattenAddresses(email.replyTo).map((a) => a.email);

  const messageId = stripAngle(email.messageId);
  const references = email.references ?? null;
  const inReplyTo = stripAngle(email.inReplyTo) ?? firstRef(email.references);

  const html = typeof email.html === 'string' ? email.html : null;
  const text = (typeof email.text === 'string' ? email.text : null) ?? (html ? stripHtml(html) : null);

  const dateSec = email.date ? Math.floor(new Date(email.date).getTime() / 1000) : NaN;

  // 合成 provider id：优先用 Message-ID（真实邮件都有，天然去重），否则退回 rawId（保证唯一）。
  const resendId = `cf:${messageId || envelope.rawId}`;

  const attachments: PreparedAttachment[] = [];
  for (const a of email.attachments) {
    const bytes = toBytes(a.content);
    if (!bytes || !bytes.length) continue;
    const contentId = a.contentId ? stripAngle(a.contentId) : null;
    const filename = a.filename || (contentId ? contentId : 'attachment');
    const contentType = (a.mimeType || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
    const inline = contentId != null || a.disposition === 'inline' || a.related === true ? 1 : 0;
    const r2Key = `attachments/${rowId}/${uuid()}-${safeFilename(filename)}`;
    await env.BUCKET.put(r2Key, bytes, { httpMetadata: { contentType } });
    attachments.push({ filename, contentType, size: bytes.length, inline, contentId, r2Key });
  }

  return {
    rowId,
    resendId,
    messageId,
    inReplyTo,
    references,
    threadId: rootThreadId({
      references,
      inReplyTo: email.inReplyTo,
      messageId: email.messageId,
      fallback: rowId,
    }),
    mailbox: deliveredTo[0] ?? '',
    fromName,
    fromEmail,
    to: headerTo.length ? headerTo : deliveredTo,
    deliveredTo,
    cc,
    bcc,
    replyTo,
    subject: email.subject ?? null,
    html,
    text,
    receivedAt: Number.isFinite(dateSec) ? dateSec : nowSec(),
    attachments,
  };
}

/**
 * `email()` handler 主体：**只做「保住这封信」**，不做解析。
 *
 * - `message.raw` 是 **一次性** ReadableStream，直接 `put` 给 R2（流式，不整读进内存）；
 * - `message.headers` 是独立对象、不消耗流，用来顺手取 Message-ID；
 * - 落库 / 入队失败时**不静默**：拒收（`setReject`）让发件方收到退信，而不是当作已投递。
 */
export async function handleInboundEmail(env: Env, message: ForwardableEmailMessage): Promise<void> {
  const rawId = uuid();
  const r2Key = `${RAW_PREFIX}${rawId}.eml`;
  const messageId = stripAngle(message.headers.get('message-id'));
  const subject = message.headers.get('subject');

  // ⚠️ 必须先登记「意图」再落 R2：r2_key 是**计划中**的 key。
  // 这样一旦随后的 R2 落盘失败，也能在 inbound_raw 里读到 error 原文（而不是像以前一样什么都查不到）。
  let rowCreated = false;
  try {
    await withRetry(() =>
      env.DB.prepare(
        `INSERT INTO inbound_raw
           (id, r2_key, from_email, to_email, size, message_id, subject, received_at, parsed_at, message_row, error, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`
      )
        .bind(rawId, r2Key, message.from || null, message.to || null, message.rawSize || 0, messageId, subject, nowSec())
        .run()
    );
    rowCreated = true;
  } catch (err) {
    console.error('inbound: create raw row failed:', err);
  }

  try {
    // ⚠️ 不要直接把 `message.raw`（ReadableStream）交给 R2.put：本仓库其余落盘一律存「字节」，
    // 且 CF 官方 Email Workers 示例也是先 `new Response(message.raw).arrayBuffer()`。
    // 直接传流偶发 put 失败 → setReject → 邮件被拒且 inbound_raw 为空（正是线上现象）。
    const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
    await withRetry(() =>
      env.BUCKET.put(r2Key, rawBytes, {
        httpMetadata: { contentType: 'message/rfc822' },
        customMetadata: { from: message.from || '', to: message.to || '' },
      })
    );
  } catch (err) {
    const detail = `r2 put failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error('inbound:', detail);
    if (rowCreated) await markRawErrorQuiet(env, rawId, detail);
    message.setReject('temporary storage failure');
    return;
  }

  // 登记失败 + 落盘成功 → 原始件在 R2 但无索引行：仍要拒收（否则邮件“看似成功”却无人能解析）。
  if (!rowCreated) {
    message.setReject('temporary storage failure');
    return;
  }

  if (!env.INBOUND_QUEUE) return; // 未配队列：原始件与索引仍在，可由恢复 cron 重放，不算丢
  try {
    await withRetry(() => env.INBOUND_QUEUE!.send({ rawId }));
  } catch (err) {
    // 入队失败不破坏「不丢」：raw + inbound_raw 都在，重放入口是 inbound_raw(parsed_at IS NULL)。
    console.error('inbound: enqueue failed:', rawId, err);
  }
}

async function markRawParsed(env: Env, rawId: string, messageRow: string): Promise<void> {
  await env.DB.prepare('UPDATE inbound_raw SET parsed_at = ?, message_row = ?, error = NULL WHERE id = ?')
    .bind(nowSec(), messageRow, rawId)
    .run();
}

async function markRawError(env: Env, rawId: string, error: string): Promise<void> {
  await env.DB.prepare('UPDATE inbound_raw SET parsed_at = ?, error = ? WHERE id = ?')
    .bind(nowSec(), error.slice(0, 500), rawId)
    .run();
}

async function markRawErrorQuiet(env: Env, rawId: string, error: string): Promise<void> {
  try {
    await markRawError(env, rawId, error);
  } catch (err) {
    console.error('inbound: record raw error failed:', rawId, err);
  }
}

/**
 * `queue()` consumer 主体：逐条解析入库。
 *
 * ⚠️ 逐条 `ack()` / `retry()` —— Queue 默认批次 all-or-nothing 重试，一条毒消息会拖垮整批。
 * ⚠️ Queue 是 **at-least-once**：靠 `inbound_raw.message_row`（非空=已入库）与
 * `findInboundByResendId` 双重幂等，同一封被消费两次不会重复入库。
 */
export async function handleInboundQueue(batch: MessageBatch<InboundQueueMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const rawId = msg.body?.rawId;
    if (!rawId) {
      msg.ack();
      continue;
    }

    const row = await env.DB.prepare('SELECT * FROM inbound_raw WHERE id = ?')
      .bind(rawId)
      .first<InboundRawRow>();
    if (!row) {
      msg.ack();
      continue;
    }
    if (row.message_row) {
      msg.ack(); // 已入库（至少一次投递的重复消费）
      continue;
    }

    const obj = await env.BUCKET.get(row.r2_key);
    if (!obj) {
      await markRawError(env, rawId, 'raw object missing in R2');
      msg.ack();
      continue;
    }

    let input: InboundInput;
    try {
      const bytes = new Uint8Array(await obj.arrayBuffer());
      input = await buildInboundInput(env, bytes, {
        from: row.from_email || '',
        to: row.to_email || '',
        rawId,
      });
    } catch (err) {
      // 解析失败是**永久性**的（重试同一份字节结果不变）：记录原因并放行，原始件仍在 R2。
      await markRawError(env, rawId, `parse failed: ${err instanceof Error ? err.message : String(err)}`);
      msg.ack();
      continue;
    }

    // 入库前先判「行大小是否超 D1 硬上限（2MB）」。命中即**永久性**写不进去：
    // 标终态（error + parsed_at）、移出队列、不重试 —— 否则这封会被 cron 每 15 分钟无谓重放一次。
    const rowBytes =
      utf8Bytes(input.html) + utf8Bytes(input.text) + utf8Bytes(input.references) + utf8Bytes(input.subject);
    if (rowBytes > MAX_MESSAGE_ROW_BYTES) {
      await markRawError(env, rawId, `message too large for D1 row (~${Math.round(rowBytes / 1024)}KB > 2MB limit); raw kept in R2`);
      msg.ack();
      continue;
    }

    try {
      const existing = await findInboundByResendId(env, input.resendId);
      if (existing) {
        await markRawParsed(env, rawId, existing);
        msg.ack();
        continue;
      }
      await saveInbound(env, input, rawId);
      await markRawParsed(env, rawId, input.rowId);
      msg.ack();
    } catch (err) {
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, 400);
      // 永久性失败（超限/约束冲突）：同一份数据重试也没用 → 标终态、移出队列、停止重试。
      if (isPermanentSaveError(err)) {
        await markRawError(env, rawId, `permanent save failure: ${detail}`);
        msg.ack();
        continue;
      }
      // 瞬时（D1/R2 瞬时故障）：重试；重试过后仍不过，**保留为待办**（不清 parsed_at），交给恢复 cron 稍后再来。
      // ⚠️ 绝不能标成 error+parsed_at 了事——那样一封恰好撞上短暂故障的邮件会永久卡死、且不再被任何机制重放。
      const attempts = (row.attempts || 0) + 1;
      console.error(`inbound: save failed (attempt ${attempts}):`, rawId, err);
      if (attempts >= MAX_RAW_ATTEMPTS) {
        await env.DB.prepare('UPDATE inbound_raw SET attempts = 0, error = ? WHERE id = ?')
          .bind(`save kept failing (×${attempts}): ${detail}`, rawId)
          .run();
        msg.ack(); // 放行本条，由 cron 兜底重放，避免毒消息阻塞整批
      } else {
        await env.DB.prepare('UPDATE inbound_raw SET attempts = ? WHERE id = ?').bind(attempts, rawId).run();
        msg.retry();
      }
    }
  }
}

/**
 * 恢复 cron 主体（never-lose 的兜底）：把「已落 R2 但没解析完」的邮件重新入队。
 *
 * 覆盖三类静默卡死：
 *   ① `email()` 里 `INBOUND_QUEUE.send` 失败（原始件与索引都在，只是没进队）；
 *   ② 消费者崩溃 / 调用超时，消息没处理完；
 *   ③ 入库瞬时失败超过阈值，被上面标成「待办」。
 *
 * 幂等：重复入队由 `inbound_raw.message_row`（已入库即跳过）+ `findInboundByResendId` 双重兜底。
 * 返回本次成功入队条数。CF 不存信，这个 cron 是「收了但没进箱」的自愈闭环。
 */
export async function replayPendingInbound(env: Env, limit = 100): Promise<number> {
  if (!env.INBOUND_QUEUE) return 0;
  const rows = await env.DB.prepare(
    'SELECT id FROM inbound_raw WHERE parsed_at IS NULL ORDER BY received_at ASC LIMIT ?'
  )
    .bind(limit)
    .all<{ id: string }>();
  let n = 0;
  for (const r of rows.results ?? []) {
    try {
      await withRetry(() => env.INBOUND_QUEUE!.send({ rawId: r.id }));
      n++;
    } catch (err) {
      console.error('inbound: replay enqueue failed:', r.id, err);
    }
  }
  return n;
}
