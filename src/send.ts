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

/** 取地址的 local part 作显示名（`zhanglili@notionmanager.com` → `zhanglili`）。 */
function localPart(addr: string): string {
  const at = addr.indexOf('@');
  return at > 0 ? addr.slice(0, at) : addr;
}

export interface SenderIdentity {
  /** Resend `from` 字段的完整写法（`名字 <地址>` 或裸地址）。 */
  from: string;
  /** 实际使用的发件地址（小写，落库为 `mailbox`）。 */
  address: string;
  /** 实际使用的显示名（空串 = 不带显示名）。 */
  name: string;
}

/**
 * 按指定邮箱解析发件人身份（`from` / 地址 / 显示名）。
 *
 * ⚠️ 曾经同域的**所有**邮箱都套全局 `SEND_FROM_NAME` 作显示名 —— 于是从
 * `zhanglili@notionmanager.com` 发出的信在收件方显示成「support」，多个账户
 * 完全分不出来。生产数据实测：入站 `from_name` 恒为 `"support"`。
 *
 * 现在的口径（三档）：
 *  1. 请求地址就是默认地址（`SEND_FROM_ADDRESS`）→ 用 `SEND_FROM_NAME`（品牌名仍可配置）；
 *  2. 同域的其他邮箱 → 用**地址前缀**作显示名，各账户可分辨；
 *  3. 非默认域 / 未指定 → 整体回退默认发件人（既有保护，不变）。
 */
export function senderIdentity(env: Env, mailbox: string): SenderIdentity {
  const addr = (mailbox || '').trim().toLowerCase();
  const def = (env.SEND_FROM_ADDRESS || '').trim().toLowerCase();
  const defDomain = def.split('@')[1];
  const mboxDomain = addr.split('@')[1];
  const defaultName = (env.SEND_FROM_NAME || '').trim();

  if (!addr || !defDomain || mboxDomain !== defDomain) {
    return { from: buildFrom(env), address: def, name: defaultName };
  }
  const name = addr === def ? defaultName : localPart(addr);
  return { from: name ? `${name} <${addr}>` : addr, address: addr, name };
}

/** 按指定邮箱构建发件人；若该邮箱域名不属于默认发送域名则回退默认发件人。 */
export function senderFromMailbox(env: Env, mailbox: string): string {
  return senderIdentity(env, mailbox).from;
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
