/**
 * Cloudflare API client (used by the setup wizard to "write DNS / enable inbound routing on the user's behalf").
 *
 * The Bearer Token appears only here and is **discarded after use**: the wizard passes the token in to complete one configuration
 * pass, then it is neither persisted nor passed on. Minimum required permissions: Zone:Read + DNS:Edit + Email Routing Rules:Edit
 * (see the wizard section in README).
 */

const CF_API = 'https://api.cloudflare.com/client/v4';

interface CfEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
}

export class CfError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CfError';
    this.status = status;
  }
}

/** Which wizard permission a path needs — used only to make the error message actionable. */
function permissionForPath(path: string): string {
  if (/\/dns_records/.test(path)) return 'DNS → Edit';
  if (/\/email\/routing/.test(path)) return 'Email Routing Rules → Edit';
  // Workers Custom Domains (used for the "access it on mail.example.com" option).
  if (/\/workers\/domains/.test(path)) return 'Workers Routes → Edit';
  if (/\/settings/.test(path)) return 'Zone Settings → Edit';
  if (/^\/zones(\?|$)/.test(path)) return 'Zone → Read';
  return '';
}

async function cfFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(`${CF_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
  } catch (err) {
    throw new CfError(`无法访问 Cloudflare API：${String(err)}`, 0);
  }
  const text = await resp.text();
  let body: CfEnvelope<T> | null = null;
  try {
    body = text ? (JSON.parse(text) as CfEnvelope<T>) : null;
  } catch {
    /* non-JSON response */
  }
  if (!resp.ok || !body || body.success === false) {
    const msg = body?.errors?.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${resp.status}`;
    // 401/403 almost always means the token is missing one of the four wizard permissions: name it.
    const need = permissionForPath(path);
    const hint = (resp.status === 401 || resp.status === 403) && need
      ? `（该操作需要 Token 具备 ${need} 权限 —— 请回到 Cloudflare 的 Token 页面补上这一项后重新粘贴）`
      : '';
    throw new CfError(`Cloudflare API 错误：${msg}${hint}`, resp.status);
  }
  return body.result;
}

/** The account a zone belongs to (the zone read permission is already part of the wizard token). */
export async function getZoneAccountId(token: string, zoneId: string): Promise<string | null> {
  const zone = await cfFetch<{ account?: { id?: string } }>(token, `/zones/${encodeURIComponent(zoneId)}`);
  return zone?.account?.id || null;
}

export interface WorkerCustomDomain {
  id?: string;
  hostname: string;
  service?: string;
  zone_id?: string;
  zone_name?: string;
}

/** Every Worker custom domain in the account (each one is a hostname served by exactly one Worker). */
export async function listWorkerCustomDomains(token: string, accountId: string): Promise<WorkerCustomDomain[]> {
  const list = await cfFetch<WorkerCustomDomain[]>(
    token,
    `/accounts/${encodeURIComponent(accountId)}/workers/domains`
  );
  return Array.isArray(list) ? list : [];
}

/**
 * Serve this Worker on `hostname` (e.g. mail.example.com).
 *
 * Cloudflare creates the DNS record and the certificate for a custom domain, so no extra DNS step is needed — but the
 * token must carry the "Workers Routes → Edit" permission. Idempotent: attaching the same hostname twice is a no-op.
 */
export async function attachWorkerCustomDomain(
  token: string,
  accountId: string,
  zoneId: string,
  hostname: string,
  workerName: string
): Promise<{ created: boolean }> {
  const existing = await listWorkerCustomDomains(token, accountId).catch(() => [] as WorkerCustomDomain[]);
  const hit = existing.find((d) => String(d.hostname || '').toLowerCase() === hostname.toLowerCase());
  if (hit && String(hit.service || '') === workerName) return { created: false };
  if (hit && hit.service && String(hit.service) !== workerName) {
    throw new CfError(
      `${hostname} 已经绑定到另一个 Worker（${hit.service}）—— 请换一个二级域名，或先到 Cloudflare 控制台解绑。`,
      409
    );
  }
  await cfFetch<WorkerCustomDomain>(token, `/accounts/${encodeURIComponent(accountId)}/workers/domains`, {
    method: 'PUT',
    body: JSON.stringify({ zone_id: zoneId, hostname, service: workerName, environment: 'production' }),
  });
  return { created: true };
}

/** Find the zone in the account matching the domain (try the full domain first, then fall back to the apex). Returns null if not found. */
export async function findZoneId(token: string, domain: string): Promise<string | null> {
  const lookup = async (name: string): Promise<string | null> => {
    const zones = await cfFetch<Array<{ id: string; name: string }>>(
      token,
      `/zones?name=${encodeURIComponent(name)}`
    );
    return zones && zones.length ? zones[0].id : null;
  };
  const direct = await lookup(domain);
  if (direct) return direct;
  const parts = domain.split('.');
  if (parts.length > 2) return lookup(parts.slice(-2).join('.'));
  return null;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

export async function listDnsRecords(token: string, zoneId: string, type: string, name?: string): Promise<CfDnsRecord[]> {
  const q = `?type=${encodeURIComponent(type)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
  return cfFetch<CfDnsRecord[]>(token, `/zones/${zoneId}/dns_records${q}`);
}

/** Idempotently write a DNS record: update if a same-name, same-type record exists, otherwise create. */
export async function upsertDnsRecord(
  token: string,
  zoneId: string,
  rec: { type: string; name: string; content: string; priority?: number }
): Promise<'created' | 'updated'> {
  const body = { type: rec.type, name: rec.name, content: rec.content, priority: rec.priority, ttl: 1 };
  const existing = await listDnsRecords(token, zoneId, rec.type, rec.name);
  if (existing.length) {
    const e = existing[0];
    if (e.content === rec.content && (rec.priority == null || e.priority === rec.priority)) return 'updated';
    await cfFetch(token, `/zones/${zoneId}/dns_records/${e.id}`, { method: 'PUT', body: JSON.stringify(body) });
    return 'updated';
  }
  await cfFetch(token, `/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify(body) });
  return 'created';
}

export interface EmailRoutingSettings {
  enabled: boolean;
}

export async function getEmailRouting(token: string, zoneId: string): Promise<EmailRoutingSettings> {
  return cfFetch<EmailRoutingSettings>(token, `/zones/${zoneId}/email/routing`);
}

/**
 * Enable Email Routing: `/email/routing/dns` (POST) "adds and locks" the required MX/SPF records,
 * which is more explicit than the deprecated `/email/routing/enable`; fall back to /enable for old accounts.
 */
export async function enableEmailRouting(token: string, zoneId: string): Promise<void> {
  try {
    await cfFetch(token, `/zones/${zoneId}/email/routing/dns`, { method: 'POST' });
  } catch {
    await cfFetch(token, `/zones/${zoneId}/email/routing/enable`, { method: 'POST' });
  }
}

/** Point the catch-all rule to this Worker (all received mail is handed to the worker for processing). */
export async function setCatchAllWorker(token: string, zoneId: string, workerName: string): Promise<void> {
  await cfFetch(token, `/zones/${zoneId}/email/routing/rules/catch_all`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'catch-all to webmail worker',
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [workerName] }],
    }),
  });
}

export interface CatchAllRule {
  enabled: boolean;
  actions: Array<{ type: string; value?: string[] }>;
}

export async function getCatchAll(token: string, zoneId: string): Promise<CatchAllRule> {
  return cfFetch<CatchAllRule>(token, `/zones/${zoneId}/email/routing/rules/catch_all`);
}
