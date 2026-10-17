import type { Env } from './types';
import { SCHEMA_SQL } from './schema-sql';

// A brand-new empty D1 (auto-created on Deploy Button / wrangler deploy) has no tables:
// the Worker idempotently initializes them on first access, so "usable right after deploy". See schema.sql / src/schema-sql.ts.
//
// Each isolate probes only once: first check whether app_config exists; if so, skip (the common hot path costs just one extra SELECT),
// and only run the full DDL if it does not. All DDL is IF NOT EXISTS, so repeated execution is safe.
let ready: Promise<void> | null = null;

export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = initialise(env).catch((err) => {
      ready = null; // allow the next request to retry on failure
      throw err;
    });
  }
  return ready;
}

async function initialise(env: Env): Promise<void> {
  if (!env.DB) return;
  try {
    await env.DB.prepare('SELECT 1 FROM app_config LIMIT 1').first();
    return; // already initialized
  } catch {
    // brand-new DB: continue to create tables
  }
  await env.DB.exec(SCHEMA_SQL);
}
