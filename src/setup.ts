import type { Env } from './types';
import { domainOf, isPlaceholderDomain, nowSec } from './util';
import { maskSecret } from './resend-errors';
import * as repo from './repo';
import * as cf from './cloudflare';
import * as rd from './resend-domains';

/**
 * Setup wizard "domain + send/receive authentication" orchestration.
 *
 * Completed within a single request: find the zone → enable inbound routing (catch-all → Worker) → create the Resend domain →
 * write the DKIM/SPF/DMARC records into the user's DNS → trigger Resend verification → store the result in app_config.
 *
 * ⚠️ The user's **CF API Token is used once and discarded**: used only within this function, never written to app_config.
 *    The Resend API Key is needed long-term for sending, so it is stored in the user's own D1 (app_config.resend_api_key).
 */

export interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Not a failure, but the user must read the detail (e.g. an env var overrides what the wizard just saved). */
  warn?: boolean;
}

export interface ConfigureInput {
  domain?: unknown;
  cfToken?: unknown;
  resendKey?: unknown;
  fromAddress?: unknown;
  fromName?: unknown;
  workerName?: unknown;
}

/** Normalize a domain: strip protocol/path/trailing dot, lowercase, basic format validation. Returns null if invalid. */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const d = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  if (!/\.[a-z]{2,}$/.test(d)) return null;
  return d;
}

/**
 * Runtime config = **D1 wins, env vars only fill the gaps**.
 *
 * Why not "env wins": multi-domain cannot be expressed by a single `SEND_FROM_ADDRESS`, and the moment a second domain is
 * added in-app the env values (one key, one default sender) become wrong for at least one domain. Worse, an env
 * `RESEND_API_KEY` silently shadowed the key the user had just saved in the wizard — which looked exactly like
 * "Resend 显示已验证，发信却说未验证". So the database is the source of truth and env vars are a bootstrap / fallback:
 * a deployment that only ever configured env vars keeps working (see seedSendConfigFromEnv, which copies the first run
 * into D1), and after that everything is editable in the app.
 */
export async function withRuntimeConfig(env: Env): Promise<Env> {
  const merged: Env = { ...env };
  let cfg: Record<string, string> = {};
  try {
    if (env.DB) cfg = await repo.getConfigMap(env);
  } catch {
    return merged; // older database without app_config: pure env config
  }

  // First run of a purely env-configured deployment: copy those values into D1 once, then treat D1 as authoritative.
  await seedSendConfigFromEnv(env, cfg);

  // NOTE: `app_config.resend_api_key` is **legacy** — the key is now bound to the domain (`domains.resend_api_key`) or
  // comes from env. A global DB key cannot be right for two domains in two Resend accounts, so it is only migrated into
  // the domains that have none (see seedLegacyGlobalKey) and then never consulted again.
  const dbFrom = (cfg.from_address || '').trim();
  if (dbFrom) merged.SEND_FROM_ADDRESS = dbFrom;
  if (Object.prototype.hasOwnProperty.call(cfg, 'from_name')) merged.SEND_FROM_NAME = cfg.from_name;
  const dbDomain = (cfg.domain || '').trim().toLowerCase();
  if (dbDomain) merged.SENDING_DOMAIN = dbDomain;

  // Multi-domain: the domains table is the source of truth for the sending-domain set. Domains that only exist in env
  // vars (the pre-multi-domain deployment style) are adopted into the table first, so they keep working *and* stop
  // depending on the env vars.
  let rows: repo.DomainRow[] = [];
  try {
    rows = await repo.listDomains(env);
  } catch {
    rows = []; // older database without the domains table: fall back to SENDING_DOMAIN / the default address
  }
  rows = await adoptEnvDomains(env, rows).catch(() => rows);
  await seedLegacyGlobalKey(env, rows, cfg).catch(() => undefined);
  const enabled = rows.filter((d) => d.enabled !== 0);
  if (enabled.length) merged.SENDING_DOMAINS = enabled.map((d) => d.domain).join(',');

  // Per-domain Resend keys: two domains may live in **different Resend accounts**, so each domain's own key wins over
  // the env one (see resendKeyFor in src/send.ts). Domains without a key fall back to env RESEND_API_KEY.
  const keys: Record<string, string> = {};
  for (const d of enabled) {
    const k = String(d.resend_api_key ?? '').trim();
    if (k) keys[String(d.domain).trim().toLowerCase()] = k;
  }
  if (Object.keys(keys).length) merged.RESEND_API_KEYS = JSON.stringify(keys);
  return merged;
}

/**
 * One-time migration: a domain that has no key of its own inherits the legacy global `app_config.resend_api_key` (that is
 * exactly the key it was using before per-domain keys existed), and the global row is then deleted so it can never
 * resurface and shadow a domain again.
 *
 * Runs after adoptEnvDomains, so a domain that came from env vars already took the env key (its own account) and is not
 * touched here.
 */
async function seedLegacyGlobalKey(env: Env, rows: repo.DomainRow[], cfg: Record<string, string>): Promise<void> {
  if (!env.DB) return;
  const legacy = (cfg.resend_api_key || '').trim();
  if (!legacy) return;
  let migrated = 0;
  for (const r of rows) {
    if (r.enabled === 0) continue;
    if (String(r.resend_api_key ?? '').trim()) continue;
    const ok = await repo.setDomainKey(env, r.domain, legacy).catch(() => false);
    if (ok) {
      r.resend_api_key = legacy;
      migrated++;
    }
  }
  if (!migrated) return;
  // Only drop the legacy row once every domain that needed it got a copy.
  const stillMissing = rows.some((r) => r.enabled !== 0 && !String(r.resend_api_key ?? '').trim());
  if (!stillMissing) {
    await repo.deleteConfig(env, 'resend_api_key').catch(() => undefined);
    delete cfg.resend_api_key;
  }
  console.log(`[config] migrated the legacy global Resend key into ${migrated} domain(s)`);
}

/**
 * Adopt the domains implied by env vars into the `domains` table (idempotent; only inserts what is missing).
 *
 * Why: `SEND_FROM_ADDRESS=support@old.com` / `SENDING_DOMAIN` / `SENDING_DOMAINS` used to be the whole config. Once the
 * database is authoritative for the key and the default sender, a deployment whose old domain only lives in env vars
 * would silently drop that domain from the switcher — and `senderIdentity()` would then fall back to the default sender,
 * i.e. mail from support@old.com would go out as noreply@<new domain>. Adopting the domain (with its default sender)
 * into the table keeps it a first-class domain and makes the env vars removable.
 *
 * The template placeholder (example.com) is never adopted: it can never be verified.
 */
async function adoptEnvDomains(env: Env, rows: repo.DomainRow[]): Promise<repo.DomainRow[]> {
  if (!env.DB) return rows;
  const known = new Set(rows.map((r) => String(r.domain).trim().toLowerCase()));
  const envFrom = (env.SEND_FROM_ADDRESS || '').trim().toLowerCase();
  const envFromDomain = domainOf(envFrom);
  const envFromName = (env.SEND_FROM_NAME || '').trim();
  const envWorker = (env.WORKER_NAME || '').trim();
  const candidates: string[] = [];
  const push = (d: string | null | undefined): void => {
    const v = String(d ?? '').trim().toLowerCase();
    if (v && !candidates.includes(v)) candidates.push(v);
  };
  push((env.SENDING_DOMAIN || '').trim().toLowerCase());
  push(envFromDomain);
  for (const raw of (env.SENDING_DOMAINS || '').split(',')) push(raw);

  const added: repo.DomainRow[] = [];
  const envKey = (env.RESEND_API_KEY || '').trim();
  for (const domain of candidates) {
    if (known.has(domain) || isPlaceholderDomain(domain)) continue;
    const fromAddress = domain === envFromDomain ? envFrom : `noreply@${domain}`;
    try {
      await repo.upsertDomain(env, {
        domain,
        fromAddress,
        fromName: envFromName || null,
        workerName: envWorker || null,
        // The env key is what served this domain all along, so it becomes the domain's own key (it may belong to a
        // different Resend account than the key the wizard later stored globally).
        resendApiKey: envKey || null,
        enabled: true,
      });
    } catch {
      continue; // domains table missing / older schema: keep running on env config
    }
    known.add(domain);
    const now = nowSec();
    added.push({
      domain,
      zone_id: null,
      resend_domain_id: null,
      resend_api_key: envKey || null,
      from_address: fromAddress,
      from_name: envFromName || null,
      worker_name: envWorker || null,
      enabled: 1,
      created_at: now,
      updated_at: now,
    });
    console.log(`[config] adopted env domain into D1: ${domain}`);
  }

  // Backfill: a domain that was adopted earlier (before per-domain keys existed) but still has no key of its own gets the
  // env key — without it, the global (possibly other-account) key would be used and sending from this domain would fail
  // with "domain is not verified".
  if (envKey) {
    for (const r of rows) {
      const d = String(r.domain).trim().toLowerCase();
      if (!candidates.includes(d) || String(r.resend_api_key ?? '').trim()) continue;
      const ok = await repo.setDomainKey(env, d, envKey).catch(() => false);
      if (ok) {
        r.resend_api_key = envKey;
        console.log(`[config] backfilled per-domain key from env: ${d}`);
      }
    }
  }
  return added.length ? rows.concat(added) : rows;
}

/**
 * Copy an env-provided send config into `app_config` **once** (only the keys D1 does not have yet), so the database
 * becomes the single source of truth and the env vars can be deleted afterwards. Idempotent: with nothing to do it
 * performs no writes at all.
 */
async function seedSendConfigFromEnv(env: Env, cfg: Record<string, string>): Promise<void> {
  if (!env.DB) return;
  const writes: Array<[string, string]> = [];
  const key = (env.RESEND_API_KEY || '').trim();
  if (key && !(cfg.resend_api_key || '').trim()) writes.push(['resend_api_key', key]);
  const from = (env.SEND_FROM_ADDRESS || '').trim();
  if (from && !(cfg.from_address || '').trim()) writes.push(['from_address', from]);
  const name = (env.SEND_FROM_NAME || '').trim();
  if (name && !Object.prototype.hasOwnProperty.call(cfg, 'from_name')) writes.push(['from_name', name]);
  const domain = ((env.SENDING_DOMAIN || '').trim().toLowerCase() || domainOf(from) || '');
  if (domain && !isPlaceholderDomain(domain) && !(cfg.domain || '').trim()) writes.push(['domain', domain]);
  if (!writes.length) return;
  for (const [k, v] of writes) {
    await repo.setConfig(env, k, v).catch(() => undefined);
    cfg[k] = v;
  }
  console.log(`[config] imported from env into D1: ${writes.map((w) => w[0]).join(', ')}`);
}

export async function configureDomain(
  env: Env,
  input: ConfigureInput
): Promise<{ ok: boolean; steps: StepResult[]; error?: string }> {
  const steps: StepResult[] = [];
  const domain = normalizeDomain(input.domain);
  const cfToken = typeof input.cfToken === 'string' ? input.cfToken.trim() : '';
  const resendKey = typeof input.resendKey === 'string' ? input.resendKey.trim() : '';
  // The inbound catch-all must point exactly at this Worker's script name. The Deploy Button lets users change the Worker name,
  // so the frontend infers it from the actual request domain and passes it up; otherwise fall back to env.WORKER_NAME.
  const workerName =
    (typeof input.workerName === 'string' && input.workerName.trim() ? input.workerName.trim() : '') ||
    (env.WORKER_NAME || 'resend-mail-api').trim();

  if (!domain) return { ok: false, steps, error: '域名格式不正确' };
  if (!cfToken) return { ok: false, steps, error: '缺少 Cloudflare API Token' };
  if (!resendKey) return { ok: false, steps, error: '缺少 Resend API Key' };

  // The first configured domain becomes the "primary" stored in app_config (drives sending / account defaults).
  // Adding a later domain must only append to the domains table, never flip the primary domain or default sender.
  // A deployment may also have been configured purely through env vars (SEND_FROM_ADDRESS / SENDING_DOMAIN) — that
  // counts as "already has a primary" too, otherwise the first in-app domain would silently take over the default sender.
  const existingDomain =
    (await repo.getConfig(env, 'domain').catch(() => null)) ||
    (env.SENDING_DOMAIN || '').trim().toLowerCase() ||
    domainOf((env.SEND_FROM_ADDRESS || '').trim().toLowerCase()) ||
    '';
  const isPrimary = !existingDomain || existingDomain === domain;

  // 1) find the zone
  let zoneId: string | null;
  try {
    zoneId = await cf.findZoneId(cfToken, domain);
  } catch (e) {
    return { ok: false, steps, error: (e as Error).message };
  }
  if (!zoneId) {
    return {
      ok: false,
      steps: [{ name: '查找域名', ok: false, detail: `${domain} 不在该 Cloudflare 账户（或 Token 缺少 Zone:Read）` }],
      error: '域名不在该 Cloudflare 账户，请确认域名已托管在此账户且 Token 有 Zone:Read 权限',
    };
  }
  steps.push({ name: '查找域名', ok: true, detail: `zone ${zoneId}` });

  // 2) Inbound: enable Email Routing + catch-all → Worker
  try {
    const routing = await cf.getEmailRouting(cfToken, zoneId).catch(() => ({ enabled: false }));
    if (!routing.enabled) await cf.enableEmailRouting(cfToken, zoneId);
    await cf.setCatchAllWorker(cfToken, zoneId, workerName);
    steps.push({ name: '收信路由', ok: true, detail: `catch-all → worker「${workerName}」` });
  } catch (e) {
    steps.push({ name: '收信路由', ok: false, detail: (e as Error).message });
  }

  // 3) Sending: create the Resend domain + write DNS + trigger verification
  let resendDomainId = '';
  try {
    let dom: rd.ResendDomain;
    try {
      dom = await rd.addDomain(resendKey, domain);
    } catch (e) {
      // The domain may already exist in Resend: fetch it and continue
      const list = await rd.listDomains(resendKey);
      const found = list.find((d) => d.name === domain);
      if (!found) throw e;
      dom = await rd.getDomain(resendKey, found.id);
    }
    resendDomainId = dom.id;

    let written = 0;
    const records = dom.records || [];
    for (const rec of records) {
      const name = rd.fqdn(rec.name, domain);
      try {
        await cf.upsertDnsRecord(cfToken, zoneId, { type: rec.type, name, content: rec.value, priority: rec.priority });
        written++;
      } catch (e) {
        steps.push({ name: `写入 DNS ${rec.type} ${name}`, ok: false, detail: (e as Error).message });
      }
    }
    await rd.verifyDomain(resendKey, dom.id).catch(() => undefined);
    const after = await rd.getDomain(resendKey, dom.id).catch(() => dom);
    steps.push({ name: '发信认证', ok: true, detail: `${records.length} 条记录写入 ${written} 条，Resend 状态：${after.status}` });
    if (isPrimary) await repo.setConfig(env, 'resend_domain_id', dom.id);
  } catch (e) {
    steps.push({ name: '发信认证', ok: false, detail: (e as Error).message });
  }

  // 4) Persist (**do not store the CF token**)
  const fromAddress = (typeof input.fromAddress === 'string' && input.fromAddress.trim()) || `noreply@${domain}`;
  const fromName = typeof input.fromName === 'string' ? input.fromName.trim() : '';
  // The key is **bound to this domain** (a second domain may belong to a different Resend account). There is no global
  // key level anymore — the legacy app_config one is migrated into the domains that lack a key and then deleted.
  if (isPrimary) {
    await repo.setConfig(env, 'domain', domain);
    await repo.setConfig(env, 'zone_id', zoneId);
    await repo.setConfig(env, 'from_address', fromAddress);
    await repo.setConfig(env, 'from_name', fromName);
    await repo.setConfig(env, 'worker_name', workerName);
    await repo.setConfig(env, 'setup_complete', '1');
  }

  steps.push({
    name: '发信 Key',
    ok: true,
    detail: `已保存为 ${domain} 的专属发信 Key（${maskSecret(resendKey)}）—— 该域名的收发只用这把，互不影响其它域。`,
  });

  // Multi-domain: also record the domain in its own table (the per-domain source of truth; app_config keeps the "primary" one).
  try {
    await repo.upsertDomain(env, {
      domain,
      zoneId,
      resendDomainId: resendDomainId || null,
      resendApiKey: resendKey,
      fromAddress,
      fromName,
      workerName,
      enabled: true,
    });
  } catch {
    /* older database without the domains table */
  }

  return { ok: steps.every((s) => s.ok), steps };
}

/* ---------------- Self-check ---------------- */

interface DnsAnswer {
  Answer?: Array<{ name: string; type: number; data: string }>;
  Status?: number;
}

/** Query one record via public DNS-over-HTTPS (dns.google), to truly verify whether DNS has taken effect (no token needed). */
export async function resolvePublicDns(name: string, type: 'MX' | 'TXT' | 'CNAME'): Promise<string[]> {
  try {
    const resp = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: 'application/dns-json' },
    });
    if (!resp.ok) return [];
    const body = (await resp.json()) as DnsAnswer;
    return (body.Answer || []).map((a) => a.data);
  } catch {
    return [];
  }
}

/**
 * Config self-check: is the local config complete, what does **the key that actually sends** see on the Resend side, and have
 * the DNS records really taken effect (verified via public DNS, so no CF token is needed and it can be rerun any time).
 *
 * ⚠️ The Resend half was added because DNS-only checks are blind to the most confusing production failure: Resend's dashboard
 * shows the domain as verified, yet sending reports "The <domain> domain is not verified" — which happens when the key used
 * for sending belongs to another Team / account, or is a domain-restricted sending key. Listing what *this* key sees makes
 * that diagnosis a glance instead of a support ticket.
 */
export async function selfCheck(env: Env): Promise<{
  ok: boolean;
  items: StepResult[];
  /** Current config, for prefilling the in-app settings form. */
  config: {
    domain: string;
    from_address: string;
    from_name: string;
    /** Per-domain view: which key that domain actually sends with (its own binding, else the env fallback). */
    domains: Record<string, { key_source: 'domain' | 'env' | 'none'; key_masked: string; from_address: string }>;
  };
}> {
  const cfg = env.DB ? await repo.getConfigMap(env).catch(() => ({} as Record<string, string>)) : {};
  const items: StepResult[] = [];

  // The primary domain: app_config.domain, else whatever the env vars define (a self-hosted deployment may never have
  // written app_config at all — see configureDomain's isPrimary).
  const primary =
    (cfg.domain || '').trim().toLowerCase() ||
    (env.SENDING_DOMAIN || '').trim().toLowerCase() ||
    (domainOf(env.SEND_FROM_ADDRESS) || '');
  const rows = await repo.listDomains(env).catch(() => [] as repo.DomainRow[]);
  const domains: string[] = [];
  const addDomain = (d: string | null | undefined): void => {
    const v = String(d ?? '').trim().toLowerCase();
    if (v && !domains.includes(v)) domains.push(v);
  };
  addDomain(primary);
  for (const r of rows) if (r.enabled !== 0) addDomain(r.domain);
  const rowByDomain = new Map<string, repo.DomainRow>();
  for (const r of rows) rowByDomain.set(String(r.domain).trim().toLowerCase(), r);

  // Key resolution mirrors resendKeyFor(): the domain's own binding first, then env. No global DB level.
  const envKey = (env.RESEND_API_KEY || '').trim();
  const keyOf = (d: string): { key: string; source: 'domain' | 'env' | 'none' } => {
    const own = String(rowByDomain.get(d)?.resend_api_key ?? '').trim();
    if (own) return { key: own, source: 'domain' };
    if (envKey) return { key: envKey, source: 'env' };
    return { key: '', source: 'none' };
  };
  const fromAddress = (cfg.from_address || '').trim() || env.SEND_FROM_ADDRESS || '';
  const fromName = Object.prototype.hasOwnProperty.call(cfg, 'from_name') ? cfg.from_name : (env.SEND_FROM_NAME || '');

  // Every row is per domain (`<label> · <domain>`) so the panel can show exactly one domain; there is no global row.
  // The default from address is intentionally **not** a check item: the sender is chosen per message in the composer,
  // and having no default simply means "you must pick one to send".

  // Resend side, per domain **with that domain's own key**; the /domains answer is cached per key (2 domains in the same
  // account = 1 request).
  const listCache = new Map<string, rd.ResendDomain[] | Error>();
  const listFor = async (key: string): Promise<rd.ResendDomain[] | Error> => {
    const hit = listCache.get(key);
    if (hit) return hit;
    let out: rd.ResendDomain[] | Error;
    try {
      out = await rd.listDomains(key);
    } catch (e) {
      out = e instanceof Error ? e : new Error(String(e));
    }
    listCache.set(key, out);
    return out;
  };

  for (const d of domains) {
    const { key, source } = keyOf(d);
    items.push({
      name: `发信 Key · ${d}`,
      ok: !!key,
      detail: !key
        ? '这个域没有绑定 Key，环境变量里也没有 → 无法发信（点下方给它绑一把）'
        : source === 'domain'
          ? `域名绑定：${maskSecret(key)}`
          : `环境变量兜底：${maskSecret(key)}（想让它独立，可在下方给该域绑定一把）`,
    });
    if (!key) {
      items.push({ name: `Resend · ${d}`, ok: false, detail: '没有可用的发信 Key，无法查询' });
      continue;
    }
    const list = await listFor(key);
    if (list instanceof Error) {
      // A "sending access" key can send but cannot list domains — that is not a delivery problem, so it must not turn
      // the domain red (it would be a false alarm for every sending-only key).
      if (/restricted to only send emails/i.test(list.message)) {
        items.push({
          name: `Resend · ${d}`,
          ok: true,
          warn: true,
          detail: '该域的 Key 是「仅发送」权限：可以发信，但查不到 Resend 侧域名状态（不影响收发）。',
        });
      } else {
        items.push({ name: `Resend · ${d}`, ok: false, detail: `查询失败：${list.message}（无法确认这把 Key 能否使用该域）` });
      }
      continue;
    }
    const found = list.find((x) => String(x.name || '').trim().toLowerCase() === d);
    if (!found) {
      items.push({
        name: `Resend · ${d}`,
        ok: false,
        detail: `这把 Key（${source === 'domain' ? `${d} 绑定` : '环境变量兜底'}）在 Resend 里看不到 ${d}：它属于另一个 Resend 账号 / 团队。两个域分属不同账号时，请给这个域绑定一把它所在账号的 Key。`,
      });
    } else if (String(found.status || '').toLowerCase() !== 'verified') {
      items.push({
        name: `Resend · ${d}`,
        ok: false,
        detail: `Resend 侧状态：${found.status || '未知'}（DNS 刚写入时可等几分钟再刷新；长期不是 verified 请到 Resend Domains 页查看缺哪条记录）`,
      });
    } else {
      items.push({ name: `Resend · ${d}`, ok: true, detail: '已验证，这把 Key 可以使用该域发信' });
    }
  }

  // DNS side, per configured domain (public DoH, no token needed).
  for (const domain of domains) {
    const mx = await resolvePublicDns(domain, 'MX');
    const mxOk = mx.some((d) => /mx\.cloudflare\.net/i.test(d));
    items.push({ name: `收信 MX · ${domain}`, ok: mxOk, detail: mxOk ? mx.join(', ') : '未发现 Cloudflare 邮件路由 MX（收信可能尚未生效）' });

    // Resend's sending SPF also needs an MX at `send` pointing at Amazon SES. If it is missing, Resend marks the whole
    // domain unverified and rejects every send ("domain is not verified") — so this must be checked, not just the TXT.
    const sendMx = await resolvePublicDns(`send.${domain}`, 'MX');
    const sendMxOk = sendMx.some((d) => /amazonses\.com/i.test(d));
    items.push({
      name: `发信 MX · ${domain}`,
      ok: sendMxOk,
      detail: sendMxOk ? sendMx.join(', ') : `未发现 send.${domain} 的 MX（Resend 会判定域名未验证，无法发信）`,
    });

    const dkim = await resolvePublicDns(`resend._domainkey.${domain}`, 'TXT');
    items.push({ name: `DKIM · ${domain}`, ok: dkim.length > 0, detail: dkim.length ? '已生效' : `未发现 resend._domainkey.${domain}（可能仍在传播中）` });

    const spf = await resolvePublicDns(`send.${domain}`, 'TXT');
    items.push({ name: `SPF · ${domain}`, ok: spf.some((d) => /spf1/i.test(d)), detail: spf.length ? spf.join(', ') : `未发现 send.${domain} 的 SPF` });

    const dmarc = await resolvePublicDns(`_dmarc.${domain}`, 'TXT');
    // DMARC is advisory: a missing record does not stop mail from being sent or received, so it must not read as a
    // failure (a red row while everything else is fine makes a healthy domain look broken).
    items.push({
      name: `DMARC · ${domain}`,
      ok: true,
      warn: dmarc.length === 0,
      detail: dmarc.length ? dmarc.join(', ') : `未发现 _dmarc（可选，建议补一条 TXT：v=DMARC1; p=none;）`,
    });
  }

  const perDomainConfig: Record<string, { key_source: 'domain' | 'env' | 'none'; key_masked: string; from_address: string }> = {};
  for (const d of domains) {
    const k = keyOf(d);
    perDomainConfig[d] = {
      key_source: k.source,
      key_masked: maskSecret(k.key),
      from_address: (String(rowByDomain.get(d)?.from_address ?? '').trim() || `noreply@${d}`),
    };
  }
  return {
    ok: items.every((i) => i.ok),
    items,
    config: {
      domain: primary,
      from_address: fromAddress,
      from_name: fromName || '',
      domains: perDomainConfig,
    },
  };
}
