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
