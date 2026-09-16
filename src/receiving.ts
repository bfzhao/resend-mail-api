import type { Env } from './types';

/**
 * Resend Received Emails API。
 * 文档: email.received webhook 只含元数据，正文/头/附件必须通过
 * https://resend.com/docs/api-reference/emails/retrieve-received-email 等接口拉取。
 */

const RESEND_API = 'https://api.resend.com';

function authHeader(env: Env): { Authorization: string } | never {
  if (!env.RESEND_API_KEY) {
    throw new Error('未配置 RESEND_API_KEY，无法拉取收信内容');
  }
  return { Authorization: `Bearer ${env.RESEND_API_KEY}` };
}

async function resendGet<T>(env: Env, path: string): Promise<T> {
  const resp = await fetch(`${RESEND_API}${path}`, { headers: authHeader(env) });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Resend API ${resp.status}: ${body.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

export interface ReceivedAttachmentMeta {
  id: string;
  filename: string;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
  size: number | null;
}

export interface ReceivedEmail {
  id: string;
  from: string | null;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject: string | null;
  html: string | null;
  html_format?: string | null;
  text: string | null;
  headers?: Record<string, string> | null;
  message_id: string | null;
  created_at: string | null;
  received_for?: string[];
  attachments?: ReceivedAttachmentMeta[];
}

export interface AttachmentDownloadItem extends ReceivedAttachmentMeta {
  download_url: string;
  expires_at?: string | null;
}

/** 拉取一封收到的邮件正文与头；html_format=cid 保留内联图 cid 引用，便于和附件表对应。 */
export async function fetchReceivedEmail(env: Env, emailId: string): Promise<ReceivedEmail> {
  return resendGet<ReceivedEmail>(
    env,
    `/emails/receiving/${encodeURIComponent(emailId)}?html_format=cid`
  );
}

/** 拉取一封邮件的附件下载地址（单次调用返回全部）。 */
export async function listReceivedAttachmentDownloads(env: Env, emailId: string): Promise<Map<string, AttachmentDownloadItem>> {
  const data = await resendGet<{ data: AttachmentDownloadItem[] }>(
    env,
    `/emails/receiving/${encodeURIComponent(emailId)}/attachments`
  );
  const map = new Map<string, AttachmentDownloadItem>();
  for (const item of data?.data ?? []) {
    if (item.download_url) map.set(item.id, item);
  }
  return map;
}

/** 下载 signed URL（Resend CDN 直接返回字节）。 */
export async function downloadSignedUrl(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`attachment download failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return { bytes: new Uint8Array(buf), contentType: resp.headers.get('content-type') };
}
