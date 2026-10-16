export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  RESEND_WEBHOOK_SECRET: string;
  RESEND_EVENTS_SECRET?: string;
  RESEND_API_KEY?: string;
  SEND_FROM_ADDRESS?: string;
  SEND_FROM_NAME?: string;
  MERGE_SUBREQ_BUDGET?: string;
  API_USERNAME?: string;
  API_PASSWORD?: string;
  /** 存储用量「百分比」的分母（字节）。缺省按免费档：D1 500MB、R2 10GB。付费档可覆盖。 */
  D1_LIMIT_BYTES?: string;
  R2_LIMIT_BYTES?: string;
  /** Resend 发信额度（封/天、封/月）。缺省按免费档：100/天、3000/月。付费档可覆盖。 */
  RESEND_DAY_LIMIT?: string;
  RESEND_MONTH_LIMIT?: string;
  /**
   * CF 入向异步解析队列（never-lose 流水线的第二段）。
   * 缺省（undefined）时 `email()` 仍会把原始件落 R2 + 登记 inbound_raw，
   * 只是没有 consumer 把它解析进 messages —— 本地 `wrangler dev` 与未建队列的部署不必因此报错。
   */
  INBOUND_QUEUE?: Queue<InboundQueueMessage>;
}

/** 入向队列消息：**只传 id 指针**（正文在 R2）。Queues 单条 ≤128 KB，绝不能把 MIME 塞进来。 */
export interface InboundQueueMessage {
  rawId: string;
}

/** `inbound_raw` 表的一行。 */
export interface InboundRawRow {
  id: string;
  r2_key: string;
  from_email: string | null;
  to_email: string | null;
  size: number;
  message_id: string | null;
  /** Subject 头（收信时即记下，供「入站异常」提示显示）。 */
  subject: string | null;
  received_at: number;
  parsed_at: number | null;
  message_row: string | null;
  error: string | null;
  attempts: number;
}

export type Direction = 'inbound' | 'outbound';

export type Folder = 'inbox' | 'sent' | 'starred' | 'trash';

export interface MessageRow {
  id: string;
  direction: Direction;
  message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  thread_id: string | null;
  mailbox: string;
  from_name: string | null;
  from_email: string | null;
  to_emails: string;
  /** 入站邮件的投递地址（信封收件人）；历史行为 NULL。见 migrations/004_delivered_to.sql。 */
  delivered_to: string | null;
  cc: string | null;
  bcc: string | null;
  reply_to: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  received_at: number;
  status: string;
  resend_id: string | null;
  read: number;
  starred: number;
  deleted: number;
  created_at: number;
  updated_at: number;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  inline: number;
  content_id: string | null;
  created_at: number;
}

export interface Address {
  name: string | null;
  email: string;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}
