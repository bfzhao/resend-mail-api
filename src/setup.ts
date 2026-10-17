import type { Env } from './types';
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

/** Layer the wizard config in D1 on top of env (env takes priority), so existing send/account logic can use the wizard config without changes. */
export async function withRuntimeConfig(env: Env): Promise<Env> {
  if (env.RESEND_API_KEY && env.SEND_FROM_ADDRESS) return env;
  let cfg: Record<string, string> = {};
  try {
    if (env.DB) cfg = await repo.getConfigMap(env);
  } catch {
    return env;
  }
  const merged: Env = { ...env };
  if (!merged.RESEND_API_KEY && cfg.resend_api_key) merged.RESEND_API_KEY = cfg.resend_api_key;
  if (!merged.SEND_FROM_ADDRESS && cfg.from_address) merged.SEND_FROM_ADDRESS = cfg.from_address;
  if (!merged.SEND_FROM_NAME && cfg.from_name) merged.SEND_FROM_NAME = cfg.from_name;
  if (!merged.SENDING_DOMAIN && cfg.domain) merged.SENDING_DOMAIN = cfg.domain;
  // Multi-domain: expose every configured domain so any address on any of them may send (see sendingDomains in src/send.ts).
  if (!merged.SENDING_DOMAINS) {
    try {
      const doms = await repo.listDomains(env);
      if (doms.length) merged.SENDING_DOMAINS = doms.map((d) => d.domain).join(',');
    } catch {
      /* older database without the domains table: fall back to the single SENDING_DOMAIN */
    }
  }
  return merged;
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
    await repo.setConfig(env, 'resend_domain_id', dom.id);
  } catch (e) {
    steps.push({ name: '发信认证', ok: false, detail: (e as Error).message });
  }

  // 4) Persist (**do not store the CF token**)
  const fromAddress = (typeof input.fromAddress === 'string' && input.fromAddress.trim()) || `noreply@${domain}`;
  const fromName = typeof input.fromName === 'string' ? input.fromName.trim() : '';
  await repo.setConfig(env, 'domain', domain);
  await repo.setConfig(env, 'zone_id', zoneId);
  await repo.setConfig(env, 'resend_api_key', resendKey);
  await repo.setConfig(env, 'from_address', fromAddress);
  await repo.setConfig(env, 'from_name', fromName);
  await repo.setConfig(env, 'worker_name', workerName);
  await repo.setConfig(env, 'setup_complete', '1');

  // Multi-domain: also record the domain in its own table (the per-domain source of truth; app_config keeps the "primary" one).
  try {
    await repo.upsertDomain(env, {
      domain,
      zoneId,
      resendDomainId: resendDomainId || null,
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
 * Config self-check: both checks whether the local config is complete and uses public DNS to truly verify whether MX / DKIM / SPF / DMARC have taken effect.
 * It does not depend on the CF token (already discarded), so it can be rerun on page refresh.
 */
export async function selfCheck(env: Env): Promise<{ ok: boolean; items: StepResult[] }> {
  const cfg = env.DB ? await repo.getConfigMap(env).catch(() => ({} as Record<string, string>)) : {};
  const domain = cfg.domain || '';
  const fromAddress = cfg.from_address || env.SEND_FROM_ADDRESS || '';
  const resendKey = cfg.resend_api_key || env.RESEND_API_KEY || '';
  const items: StepResult[] = [];

  items.push({ name: '域名', ok: !!domain, detail: domain || '未配置' });
  items.push({ name: '发件地址', ok: !!fromAddress, detail: fromAddress || '未配置' });
  items.push({ name: 'Resend API Key', ok: !!resendKey, detail: resendKey ? '已配置' : '未配置' });

  if (domain) {
    const mx = await resolvePublicDns(domain, 'MX');
    const mxOk = mx.some((d) => /mx\.cloudflare\.net/i.test(d));
    items.push({ name: '收信 MX', ok: mxOk, detail: mxOk ? mx.join(', ') : '未发现 Cloudflare 邮件路由 MX（收信可能尚未生效）' });

    const dkim = await resolvePublicDns(`resend._domainkey.${domain}`, 'TXT');
    items.push({ name: 'DKIM', ok: dkim.length > 0, detail: dkim.length ? '已生效' : `未发现 resend._domainkey.${domain}（可能仍在传播中）` });

    const spf = await resolvePublicDns(`send.${domain}`, 'TXT');
    items.push({ name: 'SPF', ok: spf.some((d) => /spf1/i.test(d)), detail: spf.length ? spf.join(', ') : `未发现 send.${domain} 的 SPF` });

    const dmarc = await resolvePublicDns(`_dmarc.${domain}`, 'TXT');
    items.push({ name: 'DMARC', ok: dmarc.length > 0, detail: dmarc.length ? dmarc.join(', ') : '未发现 _dmarc（可选，但建议配置）' });
  }

  return { ok: items.every((i) => i.ok), items };
}
