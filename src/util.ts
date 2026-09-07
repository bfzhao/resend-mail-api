import type { Address } from './types';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** 解析形如 `Name <email>` / `<email>` / `email` 的地址，返回地址实体。 */
export function parseAddress(raw: string | null | undefined): Address | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const m = /^\s*(?:"([^"]*)"|([^<]*?))\s*<([^>]+)>\s*$/.exec(s);
  if (m) {
    const name = (m[1] || m[2] || '').trim();
    const email = m[3].trim().toLowerCase();
    if (email) return { name: name || null, email };
    return null;
  }
  // 无尖括号包裹的普通邮箱，或只剩邮箱部分
  const t = s.replace(/^.*<([^>]+)>.*$/, '$1').trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return { name: null, email: t };
  return null;
}

/** 将一列原始地址(字符串)解析为 Address 列表，非法项丢弃。 */
export function parseAddressList(list: unknown): Address[] {
  if (Array.isArray(list)) {
    return list
      .map((x) => (typeof x === 'string' ? parseAddress(x) : null))
      .filter((x): x is Address => x !== null);
  }
  if (typeof list === 'string') {
    const one = parseAddress(list);
    return one ? [one] : [];
  }
  return [];
}

export function toEmailList(addrs: Address[]): string[] {
  return addrs.map((a) => a.email);
}

export function jsonArr(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/** 把 message_id / content-id 两边的尖括号去掉。 */
export function stripAngle(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (t.startsWith('<') && t.endsWith('>')) return t.slice(1, -1);
  return t || null;
}

/** 从 header 数组里按名称(大小写不敏感)取值，可能有多个重复名。 */
export function headerValue(headers: unknown, name: string): string | null {
  if (!Array.isArray(headers)) return null;
  const lname = name.toLowerCase();
  for (const h of headers) {
    if (h && typeof h === 'object' && 'name' in h) {
      const hn = String((h as { name: unknown }).name);
      if (hn.toLowerCase() === lname && 'value' in h) {
        const v = String((h as { value: unknown }).value);
        if (v) return v;
      }
    }
  }
  return null;
}

/** 从 HTML 粗提取纯文本，用于缺省 body_text。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** base64 -> bytes（Worker 运行时无 Buffer）。 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 生成安全的 Content-Disposition 值（保留非 ASCII 文件名）。 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').replace(/\s+/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function parseJsonObject<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
