import type { Env, SendResult } from './types';
import { escapeHtml, parseJsonObject } from './util';

/** Convert plain text into safely displayable HTML (escape + line breaks). */
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

/** Take the local part of an address as the display name (`zhanglili@notionmanager.com` → `zhanglili`). */
function localPart(addr: string): string {
  const at = addr.indexOf('@');
  return at > 0 ? addr.slice(0, at) : addr;
}

export interface SenderIdentity {
  /** The full form of the Resend `from` field (`Name <address>` or a bare address). */
  from: string;
  /** The sender address actually used (lowercase, stored as `mailbox`). */
  address: string;
  /** The display name actually used (empty string = no display name). */
  name: string;
}

/**
 * Resolve the sender identity (`from` / address / display name) for the given mailbox.
 *
 * ⚠️ It once applied the global `SEND_FROM_NAME` as the display name to **all** mailboxes in the same domain — so mail sent from
 * `zhanglili@notionmanager.com` appeared to the recipient as "support", making multiple accounts
 * completely indistinguishable. Production data measured: inbound `from_name` was always `"support"`.
 *
 * Current convention (three tiers):
 *  1. the requested address is the default address (`SEND_FROM_ADDRESS`) → use `SEND_FROM_NAME` (the brand name is still configurable);
 *  2. another mailbox in the same domain → use the **address prefix** as the display name, so accounts are distinguishable;
 *  3. non-default domain / unspecified → fall back to the default sender as a whole (existing protection, unchanged).
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

/** Build the sender for the given mailbox; fall back to the default sender if the mailbox's domain is not the default sending domain. */
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
  /** Sender override (e.g. send from the selected mailbox); defaults to the env default */
  from?: string;
}

/** Send mail via the Resend HTTP API (avoiding a Node dependency in the Worker). */
export async function resendSend(env: Env, req: ResendRequest): Promise<SendResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: '未配置 RESEND_API_KEY' };
  const from = req.from ?? buildFrom(env);
  if (!from) return { ok: false, error: '未配置 SEND_FROM_ADDRESS' };
  // Any one of to / cc / bcc non-empty is enough to send (a BCC-only email is legal)
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

/** Generate the reply subject: add a Re: prefix by default. */
export function replySubject(subject: string | null | undefined): string {
  const s = (subject || '').trim();
  if (!s) return '(no subject)';
  return /^\s*re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/** Generate the forward subject: add a Fwd: prefix by default (not stacked again if a Fwd:/Fw: prefix is already present). */
export function forwardSubject(subject: string | null | undefined): string {
  const s = (subject || '').trim();
  if (!s) return '(no subject)';
  return /^\s*fwd?\s*:/i.test(s) ? s : `Fwd: ${s}`;
}
