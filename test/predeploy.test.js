'use strict';

/* =========================================================
 * Deploy preflight regression (zero deps: node test/predeploy.test.js)
 *
 * The guard runs before `wrangler deploy` and is what keeps a second deployment in the same Cloudflare account from
 * silently binding the first one's D1 / R2. Pure helpers are exercised directly; the API is a fake.
 * ========================================================= */

const assert = require('assert');
const pre = require('../scripts/predeploy.js');

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const TOML = `name = "resend-mail-api2"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "resend-webhooks-db"
database_id = "cc445fd1-20b6-44c5-872f-5acf78834313"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "resend-mail-attachments"

[vars]
MERGE_SUBREQ_BUDGET = "45"
`;

/** A fake API: `db` = [{id,name,created}], `buckets` = [{name,created}], `own` = {exists,d1Ids,bucketNames}. */
function fakeApi(state) {
  const created = { d1: [], r2: [] };
  return {
    created,
    async ownBindings() { return state.own || { exists: false, d1Ids: [], bucketNames: [] }; },
    async listD1() { return { list: state.db.slice() }; },
    async createD1(name) {
      const row = { id: `new-${name}`, name, created: new Date().toISOString() };
      state.db.push(row);
      created.d1.push(name);
      return { id: row.id, name };
    },
    async listR2() { return { list: state.buckets.slice() }; },
    async createR2(name) {
      state.buckets.push({ name, created: new Date().toISOString() });
      created.r2.push(name);
      return { name };
    },
  };
}

const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();   // 30 days ago
const recent = new Date(Date.now() - 60 * 1000).toISOString();           // a minute ago (provisioned by this deploy)

(async () => {
  console.log('部署前置守卫 —— 资源重名时改名或报错');

  section('P1 解析 wrangler.toml');
  ok(pre.workerName(TOML) === 'resend-mail-api2', '读到 worker 名', pre.workerName(TOML));
  ok(pre.readValue(TOML, '[[d1_databases]]', 'database_name') === 'resend-webhooks-db', '读到 database_name');
  ok(pre.readValue(TOML, '[[d1_databases]]', 'database_id') === 'cc445fd1-20b6-44c5-872f-5acf78834313', '读到 database_id');
  ok(pre.readValue(TOML, '[[r2_buckets]]', 'bucket_name') === 'resend-mail-attachments', '读到 bucket_name');
  const edited = pre.setValue(TOML, '[[d1_databases]]', 'database_name', 'x-db');
  ok(pre.readValue(edited, '[[d1_databases]]', 'database_name') === 'x-db', '能改 database_name');
  ok(pre.readValue(edited, '[[r2_buckets]]', 'bucket_name') === 'resend-mail-attachments', '不影响其它段');

  section('P2 无冲突（全新账号）→ 名字保持不动');
  {
    const api = fakeApi({ db: [], buckets: [] });
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '没有冲突', JSON.stringify(r.conflicts));
    ok(r.toml === TOML, '⭐ wrangler.toml 原样保留（不因新建而改写）');
  }

  section('P3 同名 D1 属于别人 + 同名 R2 属于别人 → 自动加后缀并创建');
  {
    const state = { db: [{ id: 'old-db-id', name: 'resend-webhooks-db', created: old }], buckets: [{ name: 'resend-mail-attachments', created: old }] };
    const api = fakeApi(state);
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '不报错', JSON.stringify(r.conflicts));
    ok(pre.readValue(r.toml, '[[d1_databases]]', 'database_name') === 'resend-webhooks-db-resend-mail-api2',
      '⭐ D1 名字加了 -resend-mail-api2 后缀', pre.readValue(r.toml, '[[d1_databases]]', 'database_name'));
    ok(pre.readValue(r.toml, '[[d1_databases]]', 'database_id') === 'new-resend-webhooks-db-resend-mail-api2',
      '⭐ 同时写入了新库的 id（不会复用生产库）', pre.readValue(r.toml, '[[d1_databases]]', 'database_id'));
    ok(pre.readValue(r.toml, '[[r2_buckets]]', 'bucket_name') === 'resend-mail-attachments-resend-mail-api2',
      '⭐ R2 桶名也加了后缀', pre.readValue(r.toml, '[[r2_buckets]]', 'bucket_name'));
    ok(api.created.d1.length === 1 && api.created.r2.length === 1, '各创建了一个新资源', JSON.stringify(api.created));
    ok(r.notes.join(' ').includes('belongs to another deployment'), '日志里说明了原因', r.notes.join(' | '));
  }

  section('P4 重名资源其实是自己刚刚被本次部署创建的 → 直接复用');
  {
    const state = { db: [{ id: 'cc445fd1-20b6-44c5-872f-5acf78834313', name: 'resend-webhooks-db', created: recent }], buckets: [{ name: 'resend-mail-attachments', created: recent }] };
    const api = fakeApi(state);
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '没有冲突');
    ok(r.toml === TOML, '⭐ 不改名、不新建（首次部署就是这种情况）');
    ok(api.created.d1.length === 0 && api.created.r2.length === 0, '没有多创建资源');
  }

  section('P5 重新部署自己（worker 已绑定这些资源）→ 直接用，不改名');
  {
    const state = {
      db: [{ id: 'cc445fd1-20b6-44c5-872f-5acf78834313', name: 'resend-webhooks-db', created: old }],
      buckets: [{ name: 'resend-mail-attachments', created: old }],
    };
    const api = fakeApi(state);
    api.ownBindings = async () => ({ exists: true, d1Ids: ['cc445fd1-20b6-44c5-872f-5acf78834313'], bucketNames: ['resend-mail-attachments'] });
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '没有冲突');
    ok(r.toml === TOML, '⭐ 自己的资源不会被改名（重复部署稳定）');
    ok(r.notes.join(' ').includes('already bound to this worker'), '日志说明是复用', r.notes.join(' | '));
  }

  section('P6 后缀名也被别人占用 → 直接报错（不静默共享）');
  {
    const state = {
      db: [
        { id: 'old-db-id', name: 'resend-webhooks-db', created: old },
        { id: 'other-db-id', name: 'resend-webhooks-db-resend-mail-api2', created: old },
      ],
      buckets: [{ name: 'resend-mail-attachments', created: old }],
    };
    const r = await pre.resolveResources(TOML, fakeApi(state), { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 1, '⭐ 报错而不是共享', JSON.stringify(r.conflicts));
    ok(/Rename database_name/.test(r.conflicts[0]), '错误信息告诉用户改哪里', r.conflicts[0].slice(0, 80));
  }

  section('P7 占位符 database_id + 库不存在 → 主动建库并回填 id');
  {
    const tpl = TOML.replace('database_id = "cc445fd1-20b6-44c5-872f-5acf78834313"', 'database_id = "<DATABASE_ID>"');
    const api = fakeApi({ db: [], buckets: [] });
    const r = await pre.resolveResources(tpl, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '没有冲突');
    ok(pre.readValue(r.toml, '[[d1_databases]]', 'database_id') === 'new-resend-webhooks-db', '⭐ 回填了新库 id',
      pre.readValue(r.toml, '[[d1_databases]]', 'database_id'));
  }

  section('P8 API 挂了也不阻塞部署（只告警）');
  {
    const api = fakeApi({ db: [], buckets: [] });
    api.listD1 = async () => ({ error: 'boom' });
    api.listR2 = async () => ({ error: 'boom' });
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '不报错');
    ok(r.toml === TOML, '不改写配置');
    ok(r.notes.filter((n) => /could not list/.test(n)).length === 2, '两条告警', r.notes.join(' | '));
  }

  section('P9 后缀函数');
  ok(pre.suffixed('db', 'worker') === 'db-worker', '普通情况加后缀');
  ok(pre.suffixed('db-worker', 'worker') === 'db-worker', '⭐ 已经有该后缀就不再重复（重部署稳定）');

  console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
  if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
  process.exit(failures.length ? 1 : 0);
})();
