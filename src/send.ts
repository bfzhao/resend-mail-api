import type { Env, SendResult } from './types';
import { escapeHtml, parseJsonObject } from './util';

/** 将纯文本转成可安全展示的 HTML（转义 + 换行）。 */
export function textToHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => escapeHtml(l))
    .join('<br>');
}

export function buildFrom(env: Env): string {
  const name = (env.SEND_FROM_NAME || '').trim();
  const addr = (env.SEND_FROM_ADDRESS || '').trim();
  if (!addr) return '';
  return name ? `${name} <${addr}>` : addr;
}

/** 按指定邮箱构建发件人；若该邮箱域名不属于默认发送域名则回退默认发件人。 */
export function senderFromMailbox(env: Env, mailbox: string): string {
  const addr = (mailbox || '').trim().toLowerCase();
  const def = (env.SEND_FROM_ADDRESS || '').trim().toLowerCase();
  const defDomain = def.split('@')[1];
  const mboxDomain = addr.split('@')[1];
  const name = (env.SEND_FROM_NAME || '').trim();
  if (addr && defDomain && mboxDomain === defDomain) {
    return name ? `${name} <${addr}>` : addr;
  }
  return buildFrom(env);
}

export interface ResendAttachment {
  filename: string;
  content: string; // base64
  content_type?: string;
}

interface ResendRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: ResendAttachment[];
  /** 发件人覆盖（如按所选 mailbox 发信）；缺省用 env 默认 */
  from?: string;
}

/** 通过 Resend HTTP API 发送邮件（避免在 Worker 引入 Node 依赖）。 */
export async function resendSend(env: Env, req: ResendRequest): Promise<SendResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: '未配置 RESEND_API_KEY' };
  const from = req.from ?? buildFrom(env);
  if (!from) return { ok: false, error: '未配置 SEND_FROM_ADDRESS' };
  // to / cc / bcc 任一非空即可发信（只有密送的邮件是合法的）
  const hasRecipient = req.to.length > 0 || (req.cc?.length ?? 0) > 0 || (req.bcc?.length ?? 0) > 0;
  if (!hasRecipient) return { ok: false, error: '缺少收件人' };

  let resp: Response;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: req.to,
        cc: req.cc && req.cc.length ? req.cc : undefined,
        bcc: req.bcc && req.bcc.length ? req.bcc : undefined,
        subject: req.subject || '(no subject)',
        html: req.html,
        text: req.text,
        headers: req.headers,
        attachments: req.attachments && req.attachments.length ? req.attachments : undefined,
      }),
    });
  } catch (err) {
    return { ok: false, error: `网络错误: ${String(err)}` };
  }

  const body = parseJsonObject<{ id?: string; message?: string }>(await resp.text());
  if (!resp.ok) {
    const msg = body?.message || body?.id || `HTTP ${resp.status}`;
    return { ok: false, error: `Resend 返回错误: ${msg}` };
  }
  if (!body?.id) return { ok: false, error: 'Resend 未返回邮件 id' };
  return { ok: true, id: body.id };
}

/** 生成回复主题：缺省补 Re: 前缀。 */
export function replySubject(subject: string | null | undefined): string {
  const s = (subject || '').trim();
  if (!s) return '(no subject)';
  return /^\s*re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** 生成转发主题：缺省补 Fwd: 前缀（已有 Fwd:/Fw: 前缀则不重复叠加）。 */
export function forwardSubject(subject: string | null | undefined): string {
  const s = (subject || '').trim();
  if (!s) return '(no subject)';
  return /^\s*fwd?\s*:/i.test(s) ? s : `Fwd: ${s}`;
}
