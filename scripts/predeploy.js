'use strict';

/* =============================================================================
 * Deploy preflight for the "Deploy to Cloudflare button".
 *
 * Why this exists
 * ---------------
 * Cloudflare's template URL only rewrites the **worker name**; the resource names in wrangler.toml are literals. So when
 * `database_name` / `bucket_name` already exist in the account, the button attaches those resources and backfills their
 * ids — silently pointing a second deployment at the first one's production D1 / R2 (observed: a "test" deployment ended
 * up bound to the live database).
 *
 * What it does (before `wrangler deploy` runs)
 * -------------------------------------------
 * For D1 and R2:
 *   · name does not exist            -> keep it (fresh install; the button's provisioning may have just created it)
 *   · exists and **is ours**         -> keep it (we already own it: the worker's current bindings, or it was created in
 *                                       the last 15 minutes by this very deploy)
 *   · exists and is somebody else's  -> append "-<worker name>" to the name (stable across redeploys, unlike a random
 *                                       suffix which would create a brand-new empty database on every deploy), create
 *                                       that resource, and write the new name + id back into wrangler.toml
 *   · the suffixed name is taken too -> **fail loudly** and tell the user what to change
 *
 * Without CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (a plain local `wrangler deploy`), or with PREDEPLOY_SKIP=1, it
 * exits immediately and the deploy behaves exactly as before.
 * =========================================================================== */

const fs = require('fs');
const path = require('path');

const API = 'https://api.cloudflare.com/client/v4';
const FRESH_MS = 15 * 60 * 1000; // a resource created this recently was almost certainly provisioned by this deploy

/** Read the (non-comment) value of `key` from a wrangler.toml section, e.g. database_name inside [[d1_databases]]. */
function readValue(toml, section, key) {
  const lines = toml.split('\n');
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && !trimmed.startsWith('#')) {
      inSection = trimmed === section;
      continue;
    }
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue;
    const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(trimmed);
    if (m) return m[1];
  }
  return null;
}

/** Replace the (non-comment) `key = "…"` line inside a section, keeping comments / formatting intact. */
function setValue(toml, section, key, value) {
  const lines = toml.split('\n');
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && !trimmed.startsWith('#')) {
      inSection = trimmed === section;
      continue;
    }
    if (!inSection || trimmed.startsWith('#') || !trimmed) continue;
    const m = new RegExp(`^(\\s*)${key}(\\s*=\\s*)"[^"]*"`).exec(lines[i]);
    if (m) {
      lines[i] = `${m[1]}${key}${m[2]}"${value}"`;
      return lines.join('\n');
    }
  }
  return toml;
}

function workerName(toml) {
  return readValue(toml, '', 'name') || (/^name\s*=\s*"([^"]+)"/m.exec(toml) || [])[1] || '';
}

function suffixed(name, worker) {
  const suffix = String(worker || '').trim();
  if (!suffix) return `${name}-${Math.random().toString(36).slice(2, 8)}`;
  return name.endsWith(`-${suffix}`) ? name : `${name}-${suffix}`;
}

function isFresh(createdAt) {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && Date.now() - t < FRESH_MS;
}

function makeApi(token, accountId, fetchImpl) {
  const call = async (method, p, body) => {
    const res = await fetchImpl(`${API}/accounts/${accountId}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok && json && json.success !== false, json };
  };

  return {
    /** The worker's current bindings, so a redeploy recognises its own resources. null when the script does not exist. */
    async ownBindings(name) {
      const r = await call('GET', `/workers/scripts/${encodeURIComponent(name)}/settings`);
      if (r.status === 404) return { exists: false, d1Ids: [], bucketNames: [] };
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      const bindings = (r.json && r.json.result && r.json.result.bindings) || [];
      return {
        exists: true,
        d1Ids: bindings.filter((b) => b.type === 'd1').map((b) => b.id).filter(Boolean),
        bucketNames: bindings.filter((b) => b.type === 'r2_bucket').map((b) => b.bucket_name).filter(Boolean),
      };
    },
    async listD1() {
      const r = await call('GET', '/d1/database?per_page=100');
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      return { list: (r.json.result || []).map((d) => ({ id: d.uuid, name: d.name, created: d.created_at })) };
    },
    async createD1(name) {
      const r = await call('POST', '/d1/database', { name });
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      return { id: r.json.result && r.json.result.uuid, name: r.json.result && r.json.result.name };
    },
    async listR2() {
      const r = await call('GET', '/r2/buckets?per_page=100');
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      const buckets = (r.json.result && r.json.result.buckets) || [];
      return { list: buckets.map((b) => ({ name: b.name, created: b.creation_date })) };
    },
    async createR2(name) {
      const r = await call('POST', '/r2/buckets', { name });
      if (!r.ok) return { error: (r.json && r.json.errors && r.json.errors[0] && r.json.errors[0].message) || `HTTP ${r.status}` };
      return { name };
    },
  };
}

/**
 * Decide (and if needed provision) the final D1 / R2 names + ids.
 * Returns { toml, notes: string[], conflicts: string[] } — `conflicts` non-empty means: stop the deploy.
 */
async function resolveResources(toml, api, opts = {}) {
  const name = opts.workerName || workerName(toml);
  const notes = [];
  const conflicts = [];

  const d1Name = readValue(toml, '[[d1_databases]]', 'database_name');
  const d1Id = readValue(toml, '[[d1_databases]]', 'database_id');
  const bucketName = readValue(toml, '[[r2_buckets]]', 'bucket_name');

  const own = api ? await api.ownBindings(name) : { exists: false, d1Ids: [], bucketNames: [] };
  if (own.error) notes.push(`could not read the existing worker bindings (${own.error}); treating every match as foreign`);

  /* ---------------- D1 ---------------- */
  if (api && d1Name) {
    const listed = await api.listD1();
    if (listed.error) {
      notes.push(`could not list D1 databases (${listed.error}); leaving "${d1Name}" untouched`);
    } else {
      const mine = listed.list.find((d) => d.id && own.d1Ids.includes(d.id));
      const same = listed.list.find((d) => d.name === d1Name);
      if (same && mine && mine.id === same.id) {
        notes.push(`D1 ${same.name} is already bound to this worker — reusing it`);
      } else if (!same) {
        if (!d1Id || d1Id === '<DATABASE_ID>') {
          const created = await api.createD1(d1Name);
          if (created.error) conflicts.push(`could not create D1 "${d1Name}": ${created.error}`);
          else {
            toml = setValue(toml, '[[d1_databases]]', 'database_id', created.id);
            notes.push(`created D1 ${d1Name} (${created.id})`);
          }
        } else {
          notes.push(`D1 ${d1Name} does not exist yet — the id in wrangler.toml (${d1Id}) will be used`);
        }
      } else if (isFresh(same.created)) {
        notes.push(`D1 ${same.name} was created moments ago by this deploy — reusing it`);
      } else {
        const next = suffixed(d1Name, name);
        const taken = listed.list.find((d) => d.name === next);
        if (taken && !(mine && mine.id === taken.id)) {
          conflicts.push(
            `D1 "${d1Name}" already exists in this account (it belongs to another deployment) and the fallback name "${next}" is taken too. ` +
              `Rename database_name in wrangler.toml to something unique and deploy again.`
          );
        } else if (taken) {
          toml = setValue(toml, '[[d1_databases]]', 'database_id', taken.id);
          notes.push(`D1 ${next} already belongs to this worker — reusing it`);
        } else {
          const created = await api.createD1(next);
          if (created.error) conflicts.push(`could not create D1 "${next}": ${created.error}`);
          else {
            toml = setValue(toml, '[[d1_databases]]', 'database_name', next);
            toml = setValue(toml, '[[d1_databases]]', 'database_id', created.id);
            notes.push(`⚠️ D1 "${d1Name}" belongs to another deployment — using "${next}" (${created.id}) instead`);
          }
        }
      }
    }
  }

  /* ---------------- R2 ---------------- */
  if (api && bucketName) {
    const listed = await api.listR2();
    if (listed.error) {
      notes.push(`could not list R2 buckets (${listed.error}); leaving "${bucketName}" untouched`);
    } else {
      const mine = listed.list.find((b) => own.bucketNames.includes(b.name));
      const same = listed.list.find((b) => b.name === bucketName);
      if (same && mine && mine.name === same.name) {
        notes.push(`R2 ${same.name} is already bound to this worker — reusing it`);
      } else if (!same) {
        notes.push(`R2 ${bucketName} does not exist yet — leaving it to the deploy`);
      } else if (isFresh(same.created)) {
        notes.push(`R2 ${same.name} was created moments ago by this deploy — reusing it`);
      } else {
        const next = suffixed(bucketName, name);
        const taken = listed.list.find((b) => b.name === next);
        if (taken && !(mine && mine.name === taken.name)) {
          conflicts.push(
            `R2 bucket "${bucketName}" already exists in this account (another deployment owns it) and the fallback name "${next}" is taken too. ` +
              `Rename bucket_name in wrangler.toml to something unique and deploy again.`
          );
        } else if (taken) {
          notes.push(`R2 ${next} already belongs to this worker — reusing it`);
        } else {
          const created = await api.createR2(next);
          if (created.error) conflicts.push(`could not create R2 bucket "${next}": ${created.error}`);
          else {
            toml = setValue(toml, '[[r2_buckets]]', 'bucket_name', next);
            notes.push(`⚠️ R2 "${bucketName}" belongs to another deployment — using "${next}" instead`);
          }
        }
      }
    }
  }

  return { toml, notes, conflicts };
}

async function main() {
  const file = process.env.PREDEPLOY_TOML || path.join(__dirname, '..', 'wrangler.toml');
  if (process.env.PREDEPLOY_SKIP === '1') {
    console.log('[predeploy] skipped (PREDEPLOY_SKIP=1)');
    return 0;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';
  if (!token || !accountId) {
    console.log('[predeploy] no CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — skipping the resource-name guard');
    return 0;
  }

  const original = fs.readFileSync(file, 'utf8');
  const api = makeApi(token, accountId, typeof fetch === 'function' ? fetch : globalThis.fetch);
  const { toml, notes, conflicts } = await resolveResources(original, api);

  for (const n of notes) console.log(`[predeploy] ${n}`);
  if (conflicts.length) {
    console.error('\n[predeploy] ✘ deploy stopped — the template cannot pick a free resource name:\n');
    for (const c of conflicts) console.error(`  · ${c}`);
    console.error('');
    return 1;
  }
  if (toml !== original) {
    fs.writeFileSync(file, toml, 'utf8');
    console.log('[predeploy] wrangler.toml updated with the resource names actually used');
  }
  console.log('[predeploy] resource names are safe for this deployment');
  return 0;
}

module.exports = { readValue, setValue, workerName, suffixed, isFresh, resolveResources, makeApi, main };

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('[predeploy] unexpected failure:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
}
