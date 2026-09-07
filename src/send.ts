import type { Env, SendResult } from './types';
import { escapeHtml, parseJsonObject } from './util';

/** 将纯文本转成可安全展示的 HTML（转义 + 换行）。 */
export function textToHtml(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => escapeHtml(l))
    .join('<br>');
}

function buildFrom(env: Env): string {
  const name = (env.SEND_FROM_NAME || '').trim();
  const addr = (env.SEND_FROM_ADDRESS || '').trim();
  if (!addr) return '';
  return name ? `${name} <${addr}>` : addr;
}

interface ResendRequest {
  to: string[];
  cc?: string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}

/** 通过 Resend HTTP API 发送邮件（避免在 Worker 引入 Node 依赖）。 */
export async function resendSend(env: Env, req: ResendRequest): Promise<SendResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: '未配置 RESEND_API_KEY' };
  const from = buildFrom(env);
  if (!from) return { ok: false, error: '未配置 SEND_FROM_ADDRESS' };
  if (!req.to.length) return { ok: false, error: '缺少收件人' };

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
        subject: req.subject || '(no subject)',
        html: req.html,
        text: req.text,
        headers: req.headers,
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
