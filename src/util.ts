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

/**
 * 从 References / In-Reply-To 头里抽出全部 Message-ID，返回**带尖括号的规范形式**。
 *
 * ⚠️ **生产实测（2026-10-15）**：Resend 收信接口返回的 `headers.references` 值**不是**
 * RFC 5322 的空格分隔列表，而是 **JSON 数组文本** —— 形如 `["<a@b>","<c@d>"]`。
 *
 * 旧实现用 `refs.split(/\s+/)[0]` 取第一条，拿到的是整个 JSON 文本（含 `["` 前缀），
 * `stripAngle` 又只认首尾尖括号、去不掉方括号，于是 `thread_id` 落成
 * `["<a@b>","<c@d>"]` 这种畸形值。更糟的是 `reply()` 把这个 JSON 文本原样拼进
 * 新 References 发回 Resend，对方再回信时转义层级又深一层
 * （实测已出现 `["<\",\"<\\\",\\\"<\\\\\\\"...` 四层嵌套），
 * 导致**同一物理线程每往返一轮就换一个 thread_id** —— 用户侧看到的就是
 * 「来回好几次了，会话面板里却只有两封」。
 *
 * 因此不再按分隔符切分，而是**抽取全部 `<...>`**：JSON 数组、空格分隔、单值、
 * 以及历史上已被嵌套转义污染的值都能抽出正确结果（嵌套串里第一个 `<...>`
 * 恰好就是真正的根 Message-ID）。
 *
 * 返回带尖括号，便于直接拼装头部（`join(' ')` 即合法的 References）。
 */
export function parseReferences(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const re = /<([^<>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const id = m[1].trim();
    if (id) out.push(`<${id}>`);
  }
  if (out.length) return out;
  // 兜底：整串里一个 `<...>` 都没有，但本身就是一个**干净的裸 Message-ID**
  // （非规范写法，旧实现用 stripAngle 是宽容接受的，不能因为这次改动把它弄丢）。
  // 判据刻意收紧到「单个 token 且不含任何分隔符 / 引号 / 方括号」——
  // 否则 `["", ""]` 这类畸形串会被切出一堆垃圾 id。
  const t = raw.trim();
  if (/^[^\s,<>[\]"']+$/.test(t)) return [`<${t}>`];
  return [];
}

/** 取第一个可解析的 Message-ID（无尖括号形式）；没有 `<...>` 时返回 null。 */
function firstMessageId(raw: string | null | undefined): string | null {
  const first = parseReferences(raw)[0];
  return first ? stripAngle(first) : null;
}

/**
 * 会话根：References 链里最靠前的那条 Message-ID（整条线程共享），
 * 取不到时回退到 in_reply_to / 自身 message_id。结果去掉尖括号便于归组。
 *
 * 解析一律走 `parseReferences()`（见其说明：Resend 的 References 是 JSON 数组文本，
 * 按空白切分会得到畸形根）。`messageId` 额外兼容**不带尖括号**的裸 id
 * —— 出站邮件的 `message_id` 存的是内部 uuid。
 */
export function rootThreadId(opts: { references?: string | null; inReplyTo?: string | null; messageId?: string | null; fallback?: string }): string {
  const root = firstMessageId(opts.references);
  if (root) return root;
  const inReply = firstMessageId(opts.inReplyTo);
  if (inReply) return inReply;
  const own = firstMessageId(opts.messageId) ?? stripAngle(opts.messageId);
  if (own) return own;
  return opts.fallback ?? '';
}

/**
 * `thread_id` 是否是我们自己算出来的**正常值**。
 *
 * 历史数据里存过畸形 JSON 文本（见 `parseReferences`），特征是中括号 / 引号 /
 * 反斜杠 / 尖括号 / 空白。回复时若原邮件的 `thread_id` 干净就直接继承它
 * （语义上「回复当然属于原邮件的会话」，且能兜住 References 头缺失的来信），
 * 畸形则退回按 References 重新推导。
 */
export function isSaneThreadId(v: string | null | undefined): boolean {
  const s = (v ?? '').trim();
  return !!s && !/[\s[\]"\\<>]/.test(s);
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

/** 从 headers 对象(键名不定大小写)里取值。 */
export function headerValueMap(headers: Record<string, unknown> | null | undefined, name: string): string | null {
  if (!headers) return null;
  const lname = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lname && v != null) return String(v);
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

/**
 * bytes -> base64（Worker 运行时无 Buffer）。
 * 分块 String.fromCharCode 避免 `apply` 在超大数组上爆栈（附件可达数十 MB）。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
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
