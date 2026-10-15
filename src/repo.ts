import type { AttachmentRow, Env, Folder, MessageRow } from './types';
import { nowSec, uuid, contentDisposition, jsonArr } from './util';

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
  resendId: string;                          // Resend 的 email_id（入站幂等/去重）
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  threadId: string;
  mailbox: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  /** 入站邮件的**投递地址（信封收件人）**；出站为 null。见 migrations/004_delivered_to.sql。 */
  deliveredTo?: string[] | null;
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
  threadId: string;
  mailbox: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  cc: string[];
  /** 密送。可选：老的调用方（及测试）不传时按空数组处理。 */
  bcc?: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  resendId: string;
  receivedAt: number;
}

const LIST_LIMIT = 50;
const LIST_MAX = 200;

/**
 * mailbox 为空串或 NULL 的行在「收件地址」维度归入这个显式分组。
 * 它与前端 public/app.js 的 UNKNOWN_MAILBOX 必须保持一致。
 * 这样 mailboxes() 覆盖全部行，保证「全部邮箱」计数 = 各分组计数之和。
 */
export const UNKNOWN_MAILBOX = '(未识别)';

export interface ListOpts {
  folder: Folder;
  q?: string | null;
  unread?: boolean;
  mailbox?: string;
  limit: number;
  offset: number;
}

export interface FolderRow {
  id: string;
  direction: string;
  /** 该行所属的收件信箱；乐观渲染信封卡时前端靠它显示「收至 …」，故必须随列表一起返回。 */
  mailbox: string | null;
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
  /** 同一会话（thread）内的邮件数量；为 1 时表示独立邮件。 */
  thread_count: number;
  /** 同一会话内未读邮件数量；> 0 时列表行应标为未读。 */
  thread_unread: number;
}

/** mailbox 过滤条件：空/NULL 分组用哨兵值匹配，其余按精确匹配（与 mailboxes() 口径一致）。 */
function mailboxCond(mailbox: string): { sql: string; params: unknown[] } {
  if (mailbox === UNKNOWN_MAILBOX) return { sql: "(mailbox IS NULL OR mailbox = '')", params: [] };
  return { sql: 'mailbox = ?', params: [mailbox] };
}

/** 已存附件上传到 R2 后组装出的 DB 行参数已含于 attachments[]。 */
function whereForFolder(
  folder: Folder,
  q: string | null | undefined,
  unread: boolean,
  mailbox?: string
): { sql: string; params: unknown[] } {
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
  if (mailbox) {
    const c = mailboxCond(mailbox);
    conds.push(c.sql);
    params.push(...c.params);
  }
  if (q) {
    const like = `%${q}%`;
    conds.push('(subject LIKE ? OR from_name LIKE ? OR from_email LIKE ? OR body_text LIKE ? OR to_emails LIKE ?)');
    params.push(like, like, like, like, like);
  }
  return { sql: conds.join(' AND '), params };
}

const LIST_SELECT = `SELECT
    m.id, m.direction, m.mailbox, m.from_name, m.from_email, m.subject, m.to_emails,
    substr(coalesce(NULLIF(m.body_text, ''), ''), 1, 200) AS preview,
    m.received_at, m.read, m.starred, m.status,
    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachments_count
  FROM messages m`;

export async function listFolder(env: Env, opts: ListOpts): Promise<{ items: FolderRow[]; total: number }> {
  // unread 不在 whereForFolder 里处理，而是靠外部窗口函数算出的 thread_unread 过滤，
  // 这样「只看未读」时能看到「包含未读邮件的整个 thread 的最新一封」，而不是仅那封未读本身。
  const w = whereForFolder(opts.folder, opts.q, false, opts.mailbox);
  const whereSql = w.sql ? `WHERE ${w.sql}` : '';
  const unreadCond = opts.unread === true ? 'AND thread_unread > 0' : '';

  const items = (
    await env.DB.prepare(
      `WITH folder_threads AS (
         SELECT DISTINCT COALESCE(NULLIF(thread_id, ''), id) AS pk
         FROM messages m
         ${whereSql}
       ),
       ranked AS (
         SELECT
           m.id, m.direction, m.mailbox, m.from_name, m.from_email, m.subject, m.to_emails,
           substr(coalesce(NULLIF(m.body_text, ''), ''), 1, 200) AS preview,
           m.received_at, m.read, m.starred, m.status,
           (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachments_count,
           ROW_NUMBER() OVER (
             PARTITION BY COALESCE(NULLIF(m.thread_id, ''), m.id)
             ORDER BY m.received_at DESC, m.id DESC
           ) AS rn,
           COUNT(*) OVER (PARTITION BY COALESCE(NULLIF(m.thread_id, ''), m.id)) AS thread_count,
           SUM(CASE WHEN m.read = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY COALESCE(NULLIF(m.thread_id, ''), m.id)) AS thread_unread
         FROM messages m
         WHERE COALESCE(NULLIF(m.thread_id, ''), m.id) IN (SELECT pk FROM folder_threads)
       )
       SELECT
         id, direction, mailbox, from_name, from_email, subject, to_emails,
         preview, received_at, read, starred, status, attachments_count,
         thread_count, thread_unread
       FROM ranked
       WHERE rn = 1 ${unreadCond}
       ORDER BY received_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
      .bind(...w.params, opts.limit, opts.offset)
      .all<FolderRow>()
  ).results;

  const totalSql =
    opts.unread === true
      ? `SELECT COUNT(*) AS n FROM (
           SELECT COALESCE(NULLIF(thread_id, ''), id) AS pk,
                  SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) AS thread_unread
           FROM messages m
           WHERE COALESCE(NULLIF(m.thread_id, ''), m.id) IN (
             SELECT DISTINCT COALESCE(NULLIF(thread_id, ''), id) FROM messages m2 ${whereSql}
           )
           GROUP BY pk
           HAVING thread_unread > 0
         )`
      : `SELECT COUNT(DISTINCT COALESCE(NULLIF(m.thread_id, ''), m.id)) AS n FROM messages m WHERE COALESCE(NULLIF(m.thread_id, ''), m.id) IN (SELECT DISTINCT COALESCE(NULLIF(thread_id, ''), id) FROM messages m2 ${whereSql})`;

  const totalRow = (
    await env.DB.prepare(totalSql).bind(...w.params).first<{ n: number }>()
  )?.n ?? 0;

  return { items, total: totalRow };
}

/* ---------------- 草稿箱 ----------------
 * 草稿存在独立的 drafts 表（理由见 schema.sql 的建表注释）：
 * 没有投递语义（无 message_id / thread_id / status / resend_id），
 * 混进 messages 会让每个文件夹查询都不得不多带一个「排除草稿」条件。
 */

/** drafts 表的一行。 */
export interface DraftRow {
  id: string;
  mailbox: string;
  mode: string;
  source_id: string | null;
  to_emails: string;
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  rich: number;
  updated_at: number;
  created_at: number;
}

export interface DraftInput {
  id: string;
  mailbox: string;
  mode: string;
  sourceId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  rich: boolean;
}

/**
 * 草稿列表。
 *
 * 返回形状**刻意与 listFolder 一致**（伪装成一封 `direction='draft'` 的邮件）：
 * 前端的列表渲染、缓存指纹、分页、搜索都能原样复用，只有「点开是写信弹窗而非详情」
 * 这一处分叉。`received_at` 用 `updated_at` 填充 —— 草稿的排序语义是「最后修改时间」。
 */
export async function listDrafts(
  env: Env,
  opts: { q?: string | null; mailbox?: string; limit: number; offset: number }
): Promise<{ items: FolderRow[]; total: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts.mailbox) {
    const c = mailboxCond(opts.mailbox);
    conds.push(c.sql);
    params.push(...c.params);
  }
  if (opts.q) {
    const like = `%${opts.q}%`;
    conds.push('(subject LIKE ? OR to_emails LIKE ? OR body_text LIKE ?)');
    params.push(like, like, like);
  }
  const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = (
    await env.DB.prepare(
      `SELECT id, mailbox, subject, to_emails,
              substr(coalesce(NULLIF(body_text, ''), ''), 1, 200) AS preview,
              updated_at
       FROM drafts ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
    )
      .bind(...params, opts.limit, opts.offset)
      .all<{ id: string; mailbox: string; subject: string | null; to_emails: string; preview: string | null; updated_at: number }>()
  ).results;

  const total =
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM drafts ${whereSql}`).bind(...params).first<{ n: number }>())?.n ?? 0;

  const items: FolderRow[] = rows.map((r) => ({
    id: r.id,
    direction: 'draft',
    mailbox: r.mailbox,
    from_name: null,
    from_email: null,
    subject: r.subject,
    to_emails: r.to_emails,
    preview: r.preview,
    received_at: r.updated_at,
    read: 1, // 草稿没有未读语义
    starred: 0,
    status: 'draft',
    attachments_count: 0,
    thread_count: 1,
    thread_unread: 0,
  }));
  return { items, total };
}

export async function getDraft(env: Env, id: string): Promise<DraftRow | null> {
  return (await env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(id).first<DraftRow>()) ?? null;
}

/** 新建或覆盖草稿。前端在打开写信弹窗时就生成了 id，自动保存直接 upsert，省一次往返。 */
export async function upsertDraft(env: Env, d: DraftInput): Promise<void> {
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO drafts (id, mailbox, mode, source_id, to_emails, cc, bcc, subject, body_html, body_text, rich, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       mailbox = excluded.mailbox,
       mode = excluded.mode,
       source_id = excluded.source_id,
       to_emails = excluded.to_emails,
       cc = excluded.cc,
       bcc = excluded.bcc,
       subject = excluded.subject,
       body_html = excluded.body_html,
       body_text = excluded.body_text,
       rich = excluded.rich,
       updated_at = excluded.updated_at`
  )
    .bind(
      d.id,
      d.mailbox,
      d.mode,
      d.sourceId,
      JSON.stringify(d.to),
      d.cc.length ? JSON.stringify(d.cc) : null,
      d.bcc.length ? JSON.stringify(d.bcc) : null,
      d.subject,
      d.html,
      d.text,
      d.rich ? 1 : 0,
      now,
      now
    )
    .run();
}

export async function deleteDraft(env: Env, id: string): Promise<void> {
  await env.DB.prepare('DELETE FROM drafts WHERE id = ?').bind(id).run();
}

export async function sidebarCounts(env: Env, mailbox?: string): Promise<{
  inbox_unread: number;
  inbox_total: number;
  sent_total: number;
  starred_total: number;
  trash_total: number;
  drafts_total: number;
}> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (mailbox) {
    const c = mailboxCond(mailbox);
    conds.push(c.sql);
    params.push(...c.params);
  }
  const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  // 草稿在独立表里（见 schema.sql 的 drafts 说明），但**沿用同一套 mailbox 过滤条件**，
  // 否则「全部邮箱」计数 = 各分组计数之和这条不变量会在草稿上破功。
  const [row, draftRow] = await Promise.all([
    env.DB.prepare(
      `SELECT
        SUM(CASE WHEN direction='inbound' AND deleted=0 AND read=0 THEN 1 ELSE 0 END) AS inbox_unread,
        SUM(CASE WHEN direction='inbound' AND deleted=0 THEN 1 ELSE 0 END) AS inbox_total,
        SUM(CASE WHEN direction='outbound' AND deleted=0 THEN 1 ELSE 0 END) AS sent_total,
        SUM(CASE WHEN starred=1 AND deleted=0 THEN 1 ELSE 0 END) AS starred_total,
        SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END) AS trash_total
       FROM messages ${whereSql}`
    ).bind(...params).first<{ inbox_unread: number | null; inbox_total: number | null; sent_total: number | null; starred_total: number | null; trash_total: number | null }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM drafts ${whereSql}`)
      .bind(...params)
      .first<{ n: number | null }>(),
  ]);

  return {
    inbox_unread: row?.inbox_unread ?? 0,
    inbox_total: row?.inbox_total ?? 0,
    sent_total: row?.sent_total ?? 0,
    starred_total: row?.starred_total ?? 0,
    trash_total: row?.trash_total ?? 0,
    drafts_total: draftRow?.n ?? 0,
  };
}

/**
 * 收件地址列表（含各地址未读数/总数），用于侧边栏切换。
 * 覆盖**全部**行：mailbox 为空串/NULL 的归入 UNKNOWN_MAILBOX 分组，不再被静默丢弃，
 * 从而保证「全部邮箱」计数（sidebarCounts 无 mailbox 参数）=== 各分组计数之和（BUG-3b）。
 *
 * 性能：GROUP BY 用**原始列** `mailbox`（idx_messages_counts 的前导列），可被覆盖索引的有序扫描
 * 直接满足，不再产生 `TEMP B-TREE FOR GROUP BY`（实测 20000 行 100ms → 4.0ms）。
 * 空串/NULL 的归一化在 SELECT 里标成哨兵、并在 JS 里按哨兵 key 合并（NULL 与 '' 若同时出现会得到两行）。
 */
export async function mailboxes(env: Env): Promise<
  Array<{ mailbox: string; inbox_unread: number; inbox_total: number; sent_total: number }>
> {
  const groupExpr = "CASE WHEN mailbox IS NULL OR mailbox = '' THEN ? ELSE mailbox END";
  const rows = await env.DB.prepare(
    `SELECT
       ${groupExpr} AS mailbox,
       SUM(CASE WHEN direction='inbound' AND deleted=0 AND read=0 THEN 1 ELSE 0 END) AS inbox_unread,
       SUM(CASE WHEN direction='inbound' AND deleted=0 THEN 1 ELSE 0 END) AS inbox_total,
       SUM(CASE WHEN direction='outbound' AND deleted=0 THEN 1 ELSE 0 END) AS sent_total
     FROM messages
     GROUP BY mailbox
     ORDER BY inbox_unread DESC, mailbox ASC`
  ).bind(UNKNOWN_MAILBOX).all<{ mailbox: string | null; inbox_unread: number | null; inbox_total: number | null; sent_total: number | null }>();

  // 合并 '' / NULL 归入的哨兵分组（GROUP BY 原始列时二者是不同分组，可能各返回一行）。
  const merged = new Map<string, { mailbox: string; inbox_unread: number; inbox_total: number; sent_total: number }>();
  for (const r of rows.results) {
    const key = r.mailbox === null || r.mailbox === '' ? UNKNOWN_MAILBOX : r.mailbox;
    const prev = merged.get(key);
    if (prev) {
      prev.inbox_unread += r.inbox_unread ?? 0;
      prev.inbox_total += r.inbox_total ?? 0;
      prev.sent_total += r.sent_total ?? 0;
    } else {
      merged.set(key, {
        mailbox: key,
        inbox_unread: r.inbox_unread ?? 0,
        inbox_total: r.inbox_total ?? 0,
        sent_total: r.sent_total ?? 0,
      });
    }
  }
  const out = [...merged.values()];
  // 合并会打乱 SQL 的排序（未读降序），按同一口径在 JS 里重排；分组数为 0 时返回空数组（不凭空造组）。
  out.sort((a, b) => (b.inbox_unread - a.inbox_unread) || (a.mailbox < b.mailbox ? -1 : a.mailbox > b.mailbox ? 1 : 0));
  return out;
}

export interface ContactRow {
  name: string | null;
  email: string;
  /** 往来次数（收件箱 + 发件箱），用于把常用联系人排前面。 */
  count: number;
}

/**
 * 本地联系人（供收件人输入联想）：从已有邮件往来里聚合，不需要额外的地址簿表。
 *
 * - **邮箱**：入站 `from_email` + 出站/入站 `to_emails` / `cc`（JSON 数组，用 `json_each` 展开）。
 * - **姓名**：只可能来自入站 `from_name`（出站我们只存裸地址）。
 *   同一地址取**最新一封带姓名**的邮件里的写法 —— 靠 SQLite「裸列与 min()/max() 同取一行」的规则。
 *
 * ⚠️ 关于那条裸列规则（2026-10-03 在真实 SQLite 3.51.2 上实测）：
 *   文档写的是「**恰好一个** min()/max() 聚合时裸列才取该行」，但实测**更宽松**：
 *   同时存在 `COUNT(*)` / `SUM(...)` 时，裸列**仍然**取 max 那一行。
 *   也就是说「多加一个聚合」并**不会**让这段查询出错 —— 但这属于未文档化的宽松行为，
 *   不要依赖它，也不要据此去改这段 SQL。真正会把它改坏的是**方向**：
 *   换成 `MIN(received_at)`，或把姓名写成 `MAX(from_name)`（取字典序最大而非最新），
 *   两种写法都会静默返回错误的姓名（`test/contacts.backend.test.js` 的 C2 分别覆盖）。
 * - **不排除自己的收件信箱**（2026-10-03 用户决定）：`mailbox` 列里既有「我自己的身份」，
 *   也可能有**同事/团队的地址**（例如账号给 `zhanglili@` 配了收信）—— 这些地址用户**本来就想发信**。
 *   早期版本按 `DISTINCT mailbox` 全部排除，导致这类同事地址在联想里**静默消失**（用户报障）。
 *   现在自己的地址也会出现在联想里（用户明确表示「也可以给自己发」）。
 *
 * ⚠️ 关于 `json_each` 的两个实测事实（2026-10-03 在真实 SQLite 上验过）：
 *   1. `json_each(NULL)` / `json_each('[]')` 都是 **0 行**（不会造出空地址）；
 *   2. 但 `json_each('')` / 任何非法 JSON 会**直接抛 `malformed JSON`**，
 *      而且 `WHERE` 里的判断**拦不住它** —— 表值函数在 JOIN 阶段就求值了，早于 WHERE。
 *      实测 `FROM messages, json_each(cc) WHERE trim(cc) <> ''` 遇到 `cc = ''` 仍然抛错。
 *   所以「是不是合法 JSON 数组」必须写进 `json_each` 的**参数表达式**里（下面的 arrayArg），
 *   顺带排除 `'{}'` / `'123'` / `'null'` 这类合法但非数组的 JSON，否则会造出 `'123'` 这种幽灵联系人。
 *   （`json_type()` 不能用在这里：`json_type('')` 本身就会抛错。）
 */
export async function contacts(env: Env, limit = 500): Promise<ContactRow[]> {
  const arrayArg = (col: string) =>
    `CASE WHEN json_valid(${col}) AND substr(trim(${col}), 1, 1) = '[' THEN ${col} ELSE '[]' END`;

  const addrRows = (
    await env.DB.prepare(
      `SELECT lower(email) AS email, COUNT(*) AS cnt FROM (
         SELECT from_email AS email FROM messages
           WHERE from_email IS NOT NULL AND trim(from_email) <> ''
         UNION ALL
         SELECT je.value AS email FROM messages, json_each(${arrayArg('messages.to_emails')}) je
         UNION ALL
         SELECT je.value AS email FROM messages, json_each(${arrayArg('messages.cc')}) je
       )
       WHERE email IS NOT NULL AND trim(email) <> ''
       GROUP BY lower(email)`
    ).all<{ email: string; cnt: number }>()
  ).results;

  const nameRows = (
    await env.DB.prepare(
      `SELECT lower(from_email) AS email, from_name AS name, MAX(received_at) AS mx
       FROM messages
       WHERE from_name IS NOT NULL AND trim(from_name) <> ''
         AND from_email IS NOT NULL AND trim(from_email) <> ''
       GROUP BY lower(from_email)`
    ).all<{ email: string; name: string; mx: number }>()
  ).results;

  const names = new Map<string, string>();
  for (const r of nameRows) if (r.name && r.name.trim()) names.set(r.email, r.name.trim());

  const out: ContactRow[] = [];
  for (const r of addrRows) {
    out.push({ name: names.get(r.email) ?? null, email: r.email, count: r.cnt });
  }
  out.sort((a, b) => b.count - a.count || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  return out.slice(0, limit);
}

/**
 * 会话行的形状（阅读视图的上下文条目）。
 *
 * ⚠️ `copy_ids` **不是 DB 列** —— 它是 `foldLoopbackCopies()` 折叠时挂上来的
 * 「同一封物理邮件的其它记录 id」。前端靠它把「当前打开的正好是被折叠的那份副本」
 * 也算作当前行，否则会话面板里没有任何一行高亮，看起来像「我打开的那封不见了」。
 */
export interface ThreadRow {
  id: string;
  direction: string;
  mailbox: string;
  from_name: string | null;
  from_email: string | null;
  to_emails: string;
  /** 真实 Cc / Bcc 头（JSON 数组文本，可能为 NULL）。折叠回环副本要靠它。 */
  cc: string | null;
  bcc: string | null;
  subject: string | null;
  preview: string | null;
  received_at: number;
  read: number;
  deleted: number;
  copy_ids?: string[];
}

/** 回环副本的时间窗（秒）。线上实测出站/回环两条的入库时间差只有 1~2 秒。 */
const LOOPBACK_WINDOW_SEC = 300;

function normAddr(v: string | null | undefined): string {
  return String(v ?? '').trim().toLowerCase();
}

/** 某行的全部收件人（to + cc + bcc，小写归一）。 */
function rowRecipients(row: ThreadRow): string[] {
  return [...jsonArr(row.to_emails), ...jsonArr(row.cc), ...jsonArr(row.bcc)]
    .map(normAddr)
    .filter(Boolean);
}

/**
 * 折叠「同一封物理邮件在本账号内的回环副本」。
 *
 * 背景（2026-10-08 生产数据实测）：账号下配了多个收信信箱（bingfeng@ / support@ / zhanglili@）。
 * 用 bingfeng@ 发一封给外部收件人、**并抄送 zhanglili@** 时，Resend 会把同一封邮件投递回
 * zhanglili@，于是库里留下两条记录：
 *   - 出站：`to=[lara@…]` `cc=[zhanglili@…]`        —— 我发出的副本
 *   - 入站：`mailbox=zhanglili@` `from=bingfeng@` `to=[lara@…]` `cc=[zhanglili@…]`
 *                                                    —— 投递回本账号的副本
 * 二者 from / to / cc / 主题 / in_reply_to 完全相同、入库时间只差 1~2 秒；会话面板的时间
 * 精确到分钟 → 两行**逐字相同**，用户看到的就是「同一封信显示了两次」。
 *
 * 判定「某条入站行是某条出站行的回环副本」需**同时**满足：
 *   ① 同一会话（调用方已按 thread_id 过滤）；
 *   ② `from_email` 相同且非空 —— 副本的发件人就是我们自己的发信身份；
 *   ③ 入站行的**投递信箱**（`mailbox`）出现在该出站行的 to/cc/bcc 里 —— 我发给谁，就从谁那里回来；
 *   ④ 入库时间相差不超过 LOOPBACK_WINDOW_SEC。
 * 四条一起卡住才折叠：真实来信（发件人是对方）不满足 ②；对方稍后回信不满足 ④；
 * 投递给**非本账号**地址的邮件不满足 ③。任何一条不成立都原样保留。
 *
 * 折叠方向固定为「留出站、去入站」：会话面板回答的是「这封信的往来」，而不是
 * 「每个信箱各自收到了什么」—— 被折叠的那份在 zhanglili@ 自己的收件箱里照常显示。
 *
 * 副作用：被折叠行若有未读，把留存行的 `read` 置 0 —— 否则折叠会静默吞掉一个未读信号。
 */
export function foldLoopbackCopies(rows: ThreadRow[]): ThreadRow[] {
  const outbounds = rows.filter((r) => r.direction === 'outbound');
  if (!outbounds.length) return rows;

  const copyOf = new Map<string, string>(); // 入站副本 id -> 出站行 id
  const kept = rows.filter((r) => {
    if (r.direction !== 'inbound') return true;
    const from = normAddr(r.from_email);
    const box = normAddr(r.mailbox);
    if (!from || !box) return true;
    const origin = outbounds.find(
      (o) =>
        normAddr(o.from_email) === from &&
        Math.abs(o.received_at - r.received_at) <= LOOPBACK_WINDOW_SEC &&
        rowRecipients(o).includes(box)
    );
    if (!origin) return true;
    copyOf.set(r.id, origin.id);
    return false;
  });

  for (const [copyId, originId] of copyOf) {
    const origin = kept.find((r) => r.id === originId);
    if (!origin) continue;
    origin.copy_ids = origin.copy_ids ? [...origin.copy_ids, copyId] : [copyId];
    const copy = rows.find((r) => r.id === copyId);
    if (copy && !copy.read) origin.read = 0;
  }
  return kept;
}

/**
 * 同一会话内的消息，**降序（最近在前）**，用于阅读视图上下文。
 * 返回前已折叠「同一封物理邮件的回环副本」（见 `foldLoopbackCopies`）。
 *
 * `id DESC` 只作同一秒内的稳定次序，不承担业务含义。
 */
export async function listThread(env: Env, threadId: string): Promise<ThreadRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, direction, mailbox, from_name, from_email, to_emails, cc, bcc, subject,
            substr(coalesce(NULLIF(body_text,''), ''), 1, 160) AS preview,
            received_at, read, deleted
     FROM messages
     WHERE thread_id = ?
     ORDER BY received_at DESC, id DESC`
  ).bind(threadId).all<ThreadRow>();
  return foldLoopbackCopies(rows.results);
}

export async function getMessage(env: Env, id: string): Promise<MessageRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<MessageRow>()) ?? null
  );
}

/** 按 Resend email_id 查找已入库的入站邮件（去重用）。 */
export async function findInboundByResendId(env: Env, emailId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM messages WHERE direction = 'inbound' AND resend_id = ? LIMIT 1"
  ).bind(emailId).first<{ id: string }>();
  return row?.id ?? null;
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
  threadId: string;
  mailbox: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string[];
  deliveredTo?: string[] | null;
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  receivedAt: number;
  status: string;
  resendId: string | null;
  /** 已读态。缺省：**出站=1**（自己发出的邮件不存在「未读」语义），入站=0。 */
  read?: number;
}): D1PreparedStatement {
  // 出站邮件默认已读：sent 文件夹里不该出现未读。
  // 历史上 read 被硬编码成 0，导致全部已发送邮件在列表里显示未读、且点开也不会变
  // （syncOpenedReadState 只处理入站），用户侧表现为「发件箱全是未读」。
  const read = row.read ?? (row.direction === 'outbound' ? 1 : 0);
  return env.DB.prepare(
    `INSERT INTO messages
      (id, direction, message_id, in_reply_to, "references", thread_id, mailbox,
       from_name, from_email, to_emails, delivered_to, cc, bcc, reply_to, subject, body_html,
       body_text, received_at, status, resend_id, read, starred, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).bind(
    row.id,
    row.direction,
    row.messageId,
    row.inReplyTo,
    row.references,
    row.threadId,
    row.mailbox,
    row.fromName,
    row.fromEmail,
    JSON.stringify(row.to),
    row.deliveredTo && row.deliveredTo.length ? JSON.stringify(row.deliveredTo) : null,
    row.cc.length ? JSON.stringify(row.cc) : null,
    row.bcc.length ? JSON.stringify(row.bcc) : null,
    row.replyTo.length ? JSON.stringify(row.replyTo) : null,
    row.subject,
    row.html,
    row.text,
    row.receivedAt,
    row.status,
    row.resendId,
    read,
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
      inReplyTo: input.inReplyTo,
      references: input.references,
      threadId: input.threadId,
      mailbox: input.mailbox,
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      to: input.to,
      deliveredTo: input.deliveredTo,
      cc: input.cc,
      bcc: input.bcc,
      replyTo: input.replyTo,
      subject: input.subject,
      html: input.html,
      text: input.text,
      receivedAt: input.receivedAt,
      status: 'received',
      resendId: input.resendId,
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
    threadId: input.threadId,
    mailbox: input.mailbox,
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc ?? [],
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

/** 为某封邮件追加附件记录（出站附件已在 R2）。 */
export async function insertOutboundAttachments(env: Env, messageId: string, files: Array<{ filename: string; contentType: string; size: number; r2Key: string }>): Promise<void> {
  if (!files.length) return;
  const stmts = files.map((f) =>
    env.DB.prepare(
      `INSERT INTO attachments (id, message_id, r2_key, filename, content_type, size, inline, content_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`
    ).bind(uuid(), messageId, f.r2Key, f.filename, f.contentType, f.size, nowSec())
  );
  await env.DB.batch(stmts);
}

/** 附件元数据表存在性（供代理读取用）。 */
export async function getAttachment(env: Env, id: string): Promise<AttachmentRow | null> {
  return (
    (await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(id).first<AttachmentRow>()) ?? null
  );
}

/**
 * 该类型能不能**内联**给浏览器预览（而不是强制下载）。
 *
 * 只放行「浏览器原生能渲染、且不会在本域执行脚本」的类型：
 *  - 图片：`image/*`，**但排除 SVG** —— SVG 能带 `<script>`，内联等于把任意发件人的
 *    脚本放进本应用的同源上下文执行（XSS）；
 *  - `application/pdf` / `video/*` / `audio/*`：浏览器原生查看器，业界邮件客户端标准做法；
 *  - 纯文本类：只放行 `text/plain` / `text/csv` / `text/markdown` / `application/json`，
 *    其余 `text/*`（尤其 `text/html`、`text/xml`）一律下载。
 *
 * 注意与 `proxyAttachment` 里的 `text/html → octet-stream` 降级配套：那道防线仍然在。
 */
export function isInlinePreviewType(contentType: string): boolean {
  const t = (contentType || '').toLowerCase().split(';')[0].trim();
  if (!t) return false;
  if (t === 'image/svg+xml') return false;
  if (t.startsWith('image/') || t.startsWith('video/') || t.startsWith('audio/')) return true;
  if (t === 'application/pdf') return true;
  return t === 'text/plain' || t === 'text/csv' || t === 'text/markdown' || t === 'application/json';
}

/**
 * 附件代理。
 *
 * `opts.forceDownload` 对应 `?dl=1`：无论类型一律 `Content-Disposition: attachment`
 * —— 前端每个附件都配了独立「下载」按钮，走的就是这个参数；不带参数时按
 * `isInlinePreviewType()` 决定内联（可预览）还是下载。
 */
export async function proxyAttachment(
  env: Env,
  id: string,
  opts: { forceDownload?: boolean } = {}
): Promise<Response | null> {
  const row = await getAttachment(env, id);
  if (!row) return null;
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) return null;

  const type = row.content_type && !row.content_type.startsWith('text/html')
    ? row.content_type
    : 'application/octet-stream';
  // 可预览类型内联给浏览器渲染；其余（含 SVG / HTML）一律下载，防止把用户上传内容当页面打开。
  const inline = !opts.forceDownload && isInlinePreviewType(type);
  const headers = new Headers();
  headers.set('Content-Type', type);
  headers.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', row.filename));
  headers.set('Content-Length', String(obj.size));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, max-age=3600');

  if (!obj.body) return null;
  return new Response(obj.body, { headers });
}
