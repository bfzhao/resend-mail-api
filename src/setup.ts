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
  /** Optional "serve the app on this hostname" (e.g. mail.example.com). Empty = keep using the workers.dev URL. */
  appHost?: unknown;
}

/**
 * Normalise the optional access hostname: `mail` / `mail.example.com` / `https://mail.example.com/` all become
 * `mail.example.com`. A bare label gets the domain appended, because that is what people type.
 */
export function normalizeAppHost(raw: unknown, domain: string): string | null {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  if (!h) return null;
  h = h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!h.includes('.')) h = `${h}.${domain}`;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) return null;
  if (!h.endsWith(`.${domain}`) && h !== domain) return null; // must live in this zone, otherwise the token cannot do it
  return h;
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
/**
 * The keys the single-domain era kept in `app_config`. Every one of them has a home in the `domains` table now
 * (domain / zone_id / resend_domain_id / from_address / from_name / worker_name), so they are deleted on sight:
 * `resend_api_key` is handled separately by seedLegacyGlobalKey, because it is migrated into keyless domains first.
 */
const LEGACY_SINGLE_DOMAIN_KEYS = ['domain', 'zone_id', 'resend_domain_id', 'from_address', 'from_name', 'worker_name'];

export async function withRuntimeConfig(env: Env): Promise<Env> {
  const merged: Env = { ...env };
  let cfg: Record<string, string> = {};
  try {
    if (env.DB) cfg = await repo.getConfigMap(env);
  } catch {
    return merged; // older database without app_config: pure env config
  }

  // The **domains table is the only source of truth** for domain-scoped config (domain / zone / Resend domain id / key /
  // from address / from name / worker name). `app_config` used to mirror the "primary" one of each; that duplication
  // meant two places could disagree (a deleted domain lived on in app_config, a stale global key shadowed a per-domain
  // one). Only env stays as a bootstrap fallback for a deployment that has not been configured in the app yet.
  let rows: repo.DomainRow[] = [];
  try {
    rows = await repo.listDomains(env);
  } catch {
    rows = []; // older database without the domains table: fall back to the env config
  }
  // Adopts env-implied domains **only while the table is still empty** (see adoptEnvDomains).
  rows = await adoptEnvDomains(env, rows).catch(() => rows);
  // Legacy global key: migrate into keyless domains, then retire the row so it can never resurface.
  rows = await seedLegacyGlobalKey(env, rows, cfg).catch(() => rows);

  // Retire the remaining single-domain keys. They are already ignored above (the domains table is the source of truth),
  // but leaving them behind is how a stale global sender / zone id used to shadow the per-domain value — and it made
  // every "why does it still say old.com?" investigation take an hour. Deleting them is a no-op if they are absent.
  const staleKeys = LEGACY_SINGLE_DOMAIN_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(cfg, k));
  if (staleKeys.length) {
    await repo.deleteConfigKeys(env, staleKeys).catch(() => undefined);
    for (const k of staleKeys) delete cfg[k];
    console.log(`[config] retired single-domain app_config keys: ${staleKeys.join(', ')}`);
  }

  const enabled = rows.filter((d) => d.enabled !== 0);
  if (enabled.length) merged.SENDING_DOMAINS = enabled.map((d) => d.domain).join(',');

  // "Primary" = the oldest enabled domain. It is not a stored flag any more: it is derived, so deleting the oldest
  // domain simply promotes the next one instead of leaving a phantom behind in app_config.
  const primary = enabled[0]; // listDomains() is ordered by (created_at, rowid): the oldest row is the primary
  if (primary) {
    const primaryDomain = String(primary.domain || '').trim().toLowerCase();
    if (primaryDomain) merged.SENDING_DOMAIN = primaryDomain;
    const primaryFrom = String(primary.from_address || '').trim();
    if (primaryFrom) merged.SEND_FROM_ADDRESS = primaryFrom;
    if (primary.from_name !== undefined && primary.from_name !== null) merged.SEND_FROM_NAME = String(primary.from_name);
  }

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
async function seedLegacyGlobalKey(env: Env, rows: repo.DomainRow[], cfg: Record<string, string>): Promise<repo.DomainRow[]> {
  if (!env.DB) return rows;
  const legacy = (cfg.resend_api_key || '').trim();
  if (!legacy) return rows;
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
  // Retire the row once every domain that needed it has a copy — **also when nothing needed it**, otherwise a dead
  // global key sits in the database forever and is silently handed to the next domain created without a key (which is
  // exactly how "Resend says the domain is verified, sending says it is not" happened).
  const stillMissing = rows.some((r) => r.enabled !== 0 && !String(r.resend_api_key ?? '').trim());
  if (!stillMissing) {
    await repo.deleteConfig(env, 'resend_api_key').catch(() => undefined);
    delete cfg.resend_api_key;
    if (migrated) console.log(`[config] migrated the legacy global Resend key into ${migrated} domain(s)`);
    else console.log('[config] retired the unused legacy global Resend key');
  }
  return rows;
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
  // ⚠️ **Bootstrap only.** The env vars are what a deployment used before the in-app domain mechanism existed, so they
  // are adopted into D1 exactly once, while the table is still empty. Running this on every request (the old behaviour)
  // had two nasty consequences: deleting a domain in the app silently brought it back on the next page load, and an env
  // key was pushed into every domain that had no key of its own — even though an env key can only ever be right for the
  // account it came from.
  if (rows.length) return rows;
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

  return added.length ? rows.concat(added) : rows;
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

  // The primary domain is not stored anywhere: it is the oldest enabled row of the domains table (see withRuntimeConfig),
  // so configuring a new domain only appends a row and can never flip the default sender.

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
  } catch (e) {
    steps.push({ name: '发信认证', ok: false, detail: (e as Error).message });
  }

  // 4) Optional: serve the app on a hostname of this zone (mail.example.com) instead of the workers.dev URL. Cloudflare
  //    creates the DNS record + certificate for a custom domain, so there is no separate DNS step; it needs the
  //    "Workers Routes → Edit" token permission, which the template does not include by default (Cloudflare cannot
  //    pre-select it from a link), so a missing permission is reported as an actionable step instead of a failure.
  const appHost = normalizeAppHost(input.appHost, domain);
  if (typeof input.appHost === 'string' && input.appHost.trim() && !appHost) {
    steps.push({
      name: '访问域名',
      ok: false,
      detail: `"${String(input.appHost).trim()}" 不是本域下的有效主机名（应形如 mail.${domain}）；邮件收发不受影响。`,
    });
  } else if (appHost) {
    try {
      const accountId = await cf.getZoneAccountId(cfToken, zoneId);
      if (!accountId) throw new Error('无法确定该域所属的 Cloudflare 账号（Token 缺少 Zone → Read？）');
      const attached = await cf.attachWorkerCustomDomain(cfToken, accountId, zoneId, appHost, workerName);
      steps.push({
        name: '访问域名',
        ok: true,
        detail: attached.created
          ? `已绑定 https://${appHost}/（Cloudflare 会自动创建 DNS 记录与证书，通常几分钟内生效）`
          : `https://${appHost}/ 之前已绑定到这个 Worker`,
      });
    } catch (e) {
      steps.push({
        name: '访问域名',
        ok: false,
        detail: `${(e as Error).message} —— 邮件收发不受影响；也可以到 Cloudflare 控制台 → Workers → 该 Worker → Settings → Domains & Routes 手动添加 ${appHost}`,
      });
    }
  }

  // 5) Persist (**do not store the CF token**)
  const fromAddress = (typeof input.fromAddress === 'string' && input.fromAddress.trim()) || `noreply@${domain}`;
  const fromName = typeof input.fromName === 'string' ? input.fromName.trim() : '';
  // The key is **bound to this domain** (a second domain may belong to a different Resend account). There is no global
  // key level anymore — the legacy app_config one is migrated into the domains that lack a key and then deleted.
  // Only the installation flag lives in app_config now; everything domain-scoped is written to the domains row below.
  await repo.setConfig(env, 'setup_complete', '1');

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
      appHost: appHost || null,
      enabled: true,
    });
  } catch {
    /* older database without the domains table */
  }

  return { ok: steps.every((s) => s.ok), steps };
}

/* ---------------- Deleting a domain / resetting the configuration ---------------- */

export interface DeleteDomainInput {
  domain?: unknown;
  /** Left as `unknown` on purpose: `undefined` = use the default (delete), `false` = keep. */
  /** Optional: the user pastes the token when they want the Cloudflare side cleaned too (it is never stored). */
  cfToken?: unknown;
  /** Delete the sending domain in Resend as well (uses the key bound to that domain). */
  deleteResend?: unknown;
  /** Delete this domain's messages, attachments (including the R2 objects) and raw inbound rows. */
  purgeMessages?: unknown;
}

/**
 * Remove one domain.
 *
 * What can happen **without** the Cloudflare token: the domain row is deleted, and (if asked) the Resend sending domain
 * and/or the stored mail go too — the Resend key is stored per domain, so that half needs no extra input. The
 * Cloudflare half (the DKIM/SPF/DMARC records the wizard created, and the custom domain) needs the token, so it is
 * skipped with an explicit reason instead of pretending the cleanup is complete. The zone's Email Routing catch-all is
 * never touched: it is zone-wide and may still serve other domains.
 */
export async function deleteDomainAndCleanup(
  env: Env,
  input: DeleteDomainInput
): Promise<{ ok: boolean; steps: StepResult[]; error?: string }> {
  const steps: StepResult[] = [];
  const domain = normalizeDomain(input.domain);
  if (!domain) return { ok: false, steps, error: '域名格式不正确' };

  const rows = await repo.listDomains(env).catch(() => [] as repo.DomainRow[]);
  const row = rows.find((r) => String(r.domain).trim().toLowerCase() === domain);
  if (!row) return { ok: false, steps, error: `没有这个域名：${domain}` };

  const cfToken = typeof input.cfToken === 'string' ? input.cfToken.trim() : '';
  // Deleting a domain means deleting everything that belongs to it. The flags exist only so the API can opt out in
  // special cases; the UI always sends "everything", and an omitted flag now defaults to "yes" instead of "keep".
  const wantResend = (input.deleteResend as unknown) !== false;
  const wantPurge = (input.purgeMessages as unknown) !== false;
  const mailCount = await repo.countDomainMessages(env, domain).catch(() => 0);

  // 1) Resend sending domain
  const resendKey = String(row.resend_api_key ?? '').trim() || (env.RESEND_API_KEY || '').trim();
  if (!wantResend) {
    steps.push({ name: 'Resend 域名', ok: true, warn: true, detail: '按请求保留了 Resend 里的发送域（默认会一起删除）' });
  } else if (!resendKey) {
    steps.push({ name: 'Resend 域名', ok: false, detail: '这个域没有绑定 Resend Key（环境变量里也没有），无法删除——请到 Resend 控制台手动删除' });
  } else if (!row.resend_domain_id) {
    steps.push({ name: 'Resend 域名', ok: false, detail: '没有记录 Resend 域名 id（该域是手工在 Resend 里验证的），请到 Resend 控制台手动删除' });
  } else {
    try {
      await rd.deleteResendDomain(resendKey, row.resend_domain_id);
      steps.push({ name: 'Resend 域名', ok: true, detail: '已在 Resend 里删除该发送域' });
    } catch (e) {
      steps.push({ name: 'Resend 域名', ok: false, detail: `删除失败：${(e as Error).message}` });
    }
  }

  // 2) Cloudflare DNS records + custom domain (needs the token)
  if (!cfToken) {
    steps.push({
      name: 'Cloudflare DNS',
      ok: true,
      warn: true,
      detail:
        '未提供 Cloudflare Token，跳过。想清理就重新删除并粘贴 Token（需要 DNS → Edit、Workers Routes → Edit），' +
        `或到控制台手动删除 resend._domainkey.${domain} / send.${domain} 的 MX+TXT / _dmarc.${domain}`,
    });
  } else if (!row.zone_id) {
    steps.push({ name: 'Cloudflare DNS', ok: false, detail: '没有记录该域的 zone id，无法自动清理 DNS 记录；请在控制台手动删除发送认证记录' });
  } else {
    try {
      const removed = await cf.deleteSendingDnsRecords(cfToken, row.zone_id, domain);
      steps.push({
        name: 'Cloudflare DNS',
        ok: true,
        detail:
          `已删除 ${removed} 条发送认证记录（DKIM / SPF / DMARC）。` +
          '该域的收信路由（zone 级 catch-all）未改动——若其它域还要用它，保持原样即可。',
      });
      if (row.app_host) {
        try {
          const accountId = await cf.getZoneAccountId(cfToken, row.zone_id);
          if (!accountId) throw new Error('无法确定账号 id（Token 缺少 Zone → Read？）');
          const detached = await cf.detachWorkerCustomDomain(cfToken, accountId, String(row.app_host));
          steps.push({
            name: '访问域名',
            ok: true,
            detail: detached.removed ? `已解绑 ${row.app_host}` : `${row.app_host} 未绑定到本 Worker，无需解绑`,
          });
        } catch (e) {
          steps.push({ name: '访问域名', ok: false, detail: `解绑失败：${(e as Error).message}` });
        }
      }
    } catch (e) {
      steps.push({ name: 'Cloudflare DNS', ok: false, detail: `清理失败：${(e as Error).message}` });
    }
  }

  // 3) the row itself
  const removed = await repo.deleteDomain(env, domain).catch(() => false);
  steps.push({
    name: '域名配置',
    ok: removed,
    detail: removed ? '已从本站删除该域名（不再出现在域名列表 / 发件人里）' : '删除失败：数据库里没有删掉这一行',
  });

  // 4) stored mail
  if (!wantPurge) {
    steps.push({ name: '邮件数据', ok: true, warn: true, detail: `按请求保留了 ${mailCount} 封历史邮件（默认会一起删除）` });
  } else {
    try {
      const purged = await repo.purgeDomainData(env, domain);
      steps.push({
        name: '邮件数据',
        ok: true,
        detail: `已删除 ${purged.messages} 封邮件、${purged.attachments} 个附件记录（R2 对象 ${purged.objects} 个）、${purged.raws} 条原始件索引`,
      });
    } catch (e) {
      steps.push({ name: '邮件数据', ok: false, detail: `清理失败：${(e as Error).message}` });
    }
  }

  // A failed "keep" step is not a failure: the domain is gone either way. Only hard errors count.
  return { ok: steps.every((s) => s.ok || s.warn), steps };
}

/** Remove every domain + the domain-scoped config (the admin account and session secret are kept). */
export async function resetConfiguration(
  env: Env,
  input: { confirm?: unknown; purgeMessages?: unknown }
): Promise<{ ok: boolean; steps: StepResult[]; error?: string }> {
  if (input.confirm !== 'reset') return { ok: false, steps: [], error: '请确认（confirm: "reset"）' };
  const steps: StepResult[] = [];
  const rows = await repo.listDomains(env).catch(() => [] as repo.DomainRow[]);
  if (input.purgeMessages === true) {
    let messages = 0;
    let objects = 0;
    for (const r of rows) {
      const purged = await repo.purgeDomainData(env, r.domain).catch(() => null);
      if (purged) {
        messages += purged.messages;
        objects += purged.objects;
      }
    }
    steps.push({ name: '邮件数据', ok: true, detail: `已删除 ${messages} 封邮件、${objects} 个 R2 对象` });
  } else {
    steps.push({ name: '邮件数据', ok: true, detail: '保留所有历史邮件（它们不再出现在任何域名下，但仍占存储）' });
  }
  const reset = await repo.resetConfig(env, { keepSession: true });
  steps.push({ name: '配置', ok: true, detail: `已清空 ${reset.domains} 个域名与所有域名级配置（管理员账号保留）` });
  return { ok: true, steps };
}

/* ---------------- Self-check ---------------- */

interface DnsAnswer {
  Answer?: Array<{ name: string; type: number; data: string }>;
  Status?: number;
}

/**
 * Query one record via public DNS-over-HTTPS (dns.google), to truly verify whether DNS has taken effect (no token needed).
 *
 * ⚠️ `error` matters: an empty answer means "the record is not there", a failed lookup means "we could not ask". Folding
 * both into `[]` used to turn a rate-limited / timed-out request into "DKIM 未发现" — so the same domain flipped between
 * ✓ and ✕ on every refresh, and a working domain could look broken for no reason.
 */
export async function resolvePublicDns(
  name: string,
  type: 'MX' | 'TXT' | 'CNAME'
): Promise<{ answers: string[]; error: string | null }> {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 120 * attempt));
    try {
      const resp = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { Accept: 'application/dns-json' },
      });
      if (!resp.ok) {
        // 429 = rate limited, 5xx = their side: both are "try again later", not "the record is missing".
        lastError = `HTTP ${resp.status}`;
        if (resp.status === 429 || resp.status >= 500) continue;
        return { answers: [], error: lastError };
      }
      const body = (await resp.json()) as DnsAnswer;
      return { answers: (body.Answer || []).map((a) => a.data), error: null };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { answers: [], error: lastError || 'unknown error' };
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
  const items: StepResult[] = [];

  const rows = await repo.listDomains(env).catch(() => [] as repo.DomainRow[]);
  const primaryRow = rows.find((r) => r.enabled !== 0);
  // The primary domain is the oldest enabled domains row; env only matters for a deployment that has not been configured
  // in the app at all (pure bootstrap).
  const primary =
    String(primaryRow?.domain || '').trim().toLowerCase() ||
    (env.SENDING_DOMAIN || '').trim().toLowerCase() ||
    (domainOf(env.SEND_FROM_ADDRESS) || '');
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
  const fromAddress = String(primaryRow?.from_address || '').trim() || env.SEND_FROM_ADDRESS || '';
  const fromName = primaryRow ? String(primaryRow.from_name ?? '') : (env.SEND_FROM_NAME || '');

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
      // Rate limits / timeouts / 5xx say nothing about the domain: report "could not check" instead of "broken", or the
      // panel flaps between ✓ and ✕ on every refresh (and a healthy domain looks broken half the time).
      const transient =
        /429|rate limit|too many requests|timed? ?out|timeout|network|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|\b5\d\d\b|internal error|temporarily/i.test(
          list.message
        );
      if (transient) {
        items.push({
          name: `Resend · ${d}`,
          ok: true,
          warn: true,
          detail: `这次没能查询 Resend（${list.message.slice(0, 120)}），无法确认；稍后刷新再看`,
        });
        continue;
      }
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
  //
  // Every lookup has three possible outcomes and they must look different:
  //   record found      -> ✓
  //   looked up, absent -> ✕ (the record really is missing)
  //   lookup failed     -> ! (we could not ask: rate limit / timeout) — never ✕, and the detail says so, otherwise a
  //                        healthy domain flickers between ✓ and ✕ on every refresh (the reported bug).
  for (const domain of domains) {
    const mx = await resolvePublicDns(domain, 'MX');
    const mxOk = mx.answers.some((d) => /mx\.cloudflare\.net/i.test(d));
    items.push(
      mx.error
        ? { name: `收信 MX · ${domain}`, ok: true, warn: true, detail: `这次没能查询（${mx.error}），无法确认；稍后刷新再看` }
        : { name: `收信 MX · ${domain}`, ok: mxOk, detail: mxOk ? mx.answers.join(', ') : '未发现 Cloudflare 邮件路由 MX（收信可能尚未生效）' }
    );

    // Resend's sending SPF also needs an MX at `send` pointing at Amazon SES. If it is missing, Resend marks the whole
    // domain unverified and rejects every send ("domain is not verified") — so this must be checked, not just the TXT.
    const sendMx = await resolvePublicDns(`send.${domain}`, 'MX');
    const sendMxOk = sendMx.answers.some((d) => /amazonses\.com/i.test(d));
    items.push(
      sendMx.error
        ? { name: `发信 MX · ${domain}`, ok: true, warn: true, detail: `这次没能查询（${sendMx.error}），无法确认；稍后刷新再看` }
        : {
            name: `发信 MX · ${domain}`,
            ok: sendMxOk,
            detail: sendMxOk ? sendMx.answers.join(', ') : `未发现 send.${domain} 的 MX（Resend 会判定域名未验证，无法发信）`,
          }
    );

    const dkim = await resolvePublicDns(`resend._domainkey.${domain}`, 'TXT');
    items.push(
      dkim.error
        ? { name: `DKIM · ${domain}`, ok: true, warn: true, detail: `这次没能查询（${dkim.error}），无法确认；稍后刷新再看` }
        : { name: `DKIM · ${domain}`, ok: dkim.answers.length > 0, detail: dkim.answers.length ? '已生效' : `未发现 resend._domainkey.${domain}（可能仍在传播中）` }
    );

    const spf = await resolvePublicDns(`send.${domain}`, 'TXT');
    const spfOk = spf.answers.some((d) => /spf1/i.test(d));
    items.push(
      spf.error
        ? { name: `SPF · ${domain}`, ok: true, warn: true, detail: `这次没能查询（${spf.error}），无法确认；稍后刷新再看` }
        : { name: `SPF · ${domain}`, ok: spfOk, detail: spf.answers.length ? spf.answers.join(', ') : `未发现 send.${domain} 的 SPF` }
    );

    const dmarc = await resolvePublicDns(`_dmarc.${domain}`, 'TXT');
    // DMARC is advisory: a missing record does not stop mail from being sent or received, so it must not read as a
    // failure (a red row while everything else is fine makes a healthy domain look broken).
    items.push(
      dmarc.error
        ? { name: `DMARC · ${domain}`, ok: true, warn: true, detail: `这次没能查询（${dmarc.error}），无法确认；稍后刷新再看` }
        : {
            name: `DMARC · ${domain}`,
            ok: true,
            warn: dmarc.answers.length === 0,
            detail: dmarc.answers.length ? dmarc.answers.join(', ') : `未发现 _dmarc（可选，建议补一条 TXT：v=DMARC1; p=none;）`,
          }
    );
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
