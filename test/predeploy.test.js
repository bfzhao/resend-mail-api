'use strict';

/* =========================================================
 * Deploy preflight rules (zero deps: node test/predeploy.test.js)
 *
 * The one thing the Deploy Button reliably gives us is the **project name** (it rewrites `name` in wrangler.toml and
 * package.json). The resource-name fields of its setup page do not reach the repository, so the names are derived from
 * that project name instead: `<project>-db` / `<project>-bucket`. Rules under test:
 *
 *   · new deployment                       -> create the derived names, write name + id back
 *   · worker already bound to a resource   -> keep it (it holds the mail; never repoint at an empty one)
 *   · an explicit name in wrangler.toml    -> honoured as a manual override
 *   · name already taken by someone else   -> stop the deploy (no silent sharing, no invented suffix)
 * ========================================================= */

const fs = require('fs');
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
workers_dev = true

[[d1_databases]]
binding = "DB"
database_name = "resend-webhooks-db"
database_id = "<DATABASE_ID>"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "resend-mail-attachments"

[vars]
MERGE_SUBREQ_BUDGET = "45"
`;

const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
const recent = new Date(Date.now() - 60 * 1000).toISOString();

/** Fake Cloudflare API + captured creations. */
function fakeApi(state) {
  const created = { d1: [], r2: [] };
  return {
    created,
    async ownBindings() { return state.own || { exists: false, d1Ids: [], bucketNames: [] }; },
    async listD1() { return { list: state.db.slice() }; },
    async createD1(name) {
      const row = { id: `id-${name}`, name, created: new Date().toISOString() };
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

const dbNameOf = (toml) => pre.readValue(toml, '[[d1_databases]]', 'database_name');
const dbIdOf = (toml) => pre.readValue(toml, '[[d1_databases]]', 'database_id');
const bucketOf = (toml) => pre.readValue(toml, '[[r2_buckets]]', 'bucket_name');

(async () => {
  console.log('部署前置守卫 —— 资源名跟随项目名（用户的输入必须真的生效）');

  section('P1 toml 读写 + 名字派生');
  ok(pre.workerName(TOML) === 'resend-mail-api2', '读到 worker 名', pre.workerName(TOML));
  ok(dbNameOf(TOML) === 'resend-webhooks-db' && bucketOf(TOML) === 'resend-mail-attachments', '读到模板默认名');
  const edited = pre.setValue(TOML, '[[d1_databases]]', 'database_name', 'x-db');
  ok(dbNameOf(edited) === 'x-db' && bucketOf(edited) === 'resend-mail-attachments', '只改目标段');
  ok(pre.derivedNames('resend-mail-api2').db === 'resend-mail-api2-db', '⭐ 派生名 = <项目名>-db', pre.derivedNames('resend-mail-api2').db);
  ok(pre.derivedNames('resend-mail-api2').bucket === 'resend-mail-api2-bucket', '派生名 = <项目名>-bucket');
  ok(pre.derivedNames('My.Project_1').db === 'my-project-1-db', '⭐ 非法字符归一化（点/下划线→连字符、转小写）', pre.derivedNames('My.Project_1').db);
  ok(pre.derivedNames('a'.repeat(80)).db.length <= 53, '长名字被截断（R2 上限 63）', pre.derivedNames('a'.repeat(80)).db.length);
  ok(pre.derivedNames('').bucket === 'resend-mail-bucket', '空名字有兜底', pre.derivedNames('').bucket);

  section('P2 全新部署：按项目名建库/建桶，并把名字+id 写回配置');
  {
    const api = fakeApi({ db: [], buckets: [] });
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '不报错', JSON.stringify(r.conflicts));
    ok(dbNameOf(r.toml) === 'resend-mail-api2-db', '⭐ 库名来自项目名', dbNameOf(r.toml));
    ok(dbIdOf(r.toml) === 'id-resend-mail-api2-db', '⭐ 回填了新建库的 id', dbIdOf(r.toml));
    ok(bucketOf(r.toml) === 'resend-mail-api2-bucket', '⭐ 桶名来自项目名', bucketOf(r.toml));
    ok(api.created.d1.join(',') === 'resend-mail-api2-db' && api.created.r2.join(',') === 'resend-mail-api2-bucket',
      '确实只创建了这两个', `${api.created.d1}/${api.created.r2}`);
  }

  section('P3 平台已经按模板名建了资源（刚创建）→ 名字仍跟随项目名');
  {
    const state = { db: [{ id: 'platform-db-id', name: 'resend-webhooks-db', created: recent }], buckets: [{ name: 'resend-mail-attachments', created: recent }] };
    const api = fakeApi(state);
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '不报错', JSON.stringify(r.conflicts));
    ok(dbNameOf(r.toml) === 'resend-mail-api2-db', '⭐ 名字仍是项目派生的，不跟随模板名', dbNameOf(r.toml));
  }

  section('P4 重新部署自己：worker 已绑定的资源原样保留（不会绑到空库）');
  {
    const state = { db: [{ id: 'cc445fd1', name: 'resend-webhooks-db', created: old }], buckets: [{ name: 'resend-mail-attachments', created: old }] };
    const api = fakeApi(state);
    api.ownBindings = async () => ({ exists: true, d1Ids: ['cc445fd1'], bucketNames: ['resend-mail-attachments'] });
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '不报错');
    ok(dbIdOf(r.toml) === 'cc445fd1' && dbNameOf(r.toml) === 'resend-webhooks-db', '⭐ 保留已绑定的库（名字与 id 对齐）', `${dbNameOf(r.toml)}/${dbIdOf(r.toml)}`);
    ok(bucketOf(r.toml) === 'resend-mail-attachments', '⭐ 保留已绑定的桶');
    ok(api.created.d1.length === 0 && api.created.r2.length === 0, '没有新建任何东西');
  }

  section('P5 手工在 wrangler.toml 里指定名字 → 作为覆盖值（用户显式输入优先）');
  {
    const tpl = TOML.replace('database_name = "resend-webhooks-db"', 'database_name = "my-own-db"')
      .replace('bucket_name = "resend-mail-attachments"', 'bucket_name = "my-own-bucket"');
    const api = fakeApi({ db: [], buckets: [] });
    const r = await pre.resolveResources(tpl, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '不报错', JSON.stringify(r.conflicts));
    ok(dbNameOf(r.toml) === 'my-own-db' && bucketOf(r.toml) === 'my-own-bucket', '⭐ 用你写的名字', `${dbNameOf(r.toml)}/${bucketOf(r.toml)}`);
    ok(dbIdOf(r.toml) === 'id-my-own-db', '并回填了 id', dbIdOf(r.toml));
  }

  section('P6 派生出来的名字已被别的部署占用 → 停止部署（不静默共享、不乱加后缀）');
  {
    const state = {
      db: [{ id: 'other-db', name: 'resend-mail-api2-db', created: old }],
      buckets: [{ name: 'resend-mail-api2-bucket', created: old }],
    };
    const api = fakeApi(state);
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length >= 1, '⭐ D1 冲突即停（R2 也会各自报）', JSON.stringify(r.conflicts.map((c) => c.slice(0, 40))));
    ok(/not this worker|belongs to another deployment/.test(r.conflicts[0]), '错误说明归属问题', r.conflicts[0].slice(0, 90));
    ok(/rename your project/i.test(r.conflicts[0]), '⭐ 告诉用户改项目名即可（资源名跟随它）', r.conflicts[0].slice(-80));
    ok(api.created.d1.length === 0, '没有创建任何库');
  }

  section('P7 手工指定的名字被别人占用 → 同样停止');
  {
    const tpl = TOML.replace('database_name = "resend-webhooks-db"', 'database_name = "taken-db"');
    const api = fakeApi({ db: [{ id: 'x', name: 'taken-db', created: old }], buckets: [] });
    const r = await pre.resolveResources(tpl, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 1, '报错', JSON.stringify(r.conflicts));
    ok(api.created.d1.length === 0, '没有创建任何库');
  }

  section('P8 配置里残留一个真实 id（指向按模板名建的库）→ 不会静默绑定它');
  {
    const tpl = TOML.replace('database_id = "<DATABASE_ID>"', 'database_id = "fresh-id"');
    const state = { db: [{ id: 'fresh-id', name: 'resend-webhooks-db', created: recent }], buckets: [] };
    const api = fakeApi(state);
    const r = await pre.resolveResources(tpl, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '不报错');
    ok(dbIdOf(r.toml) !== 'fresh-id', '⭐ 不会静默绑定按模板名建的那个库', dbIdOf(r.toml));
    ok(dbNameOf(r.toml) === 'resend-mail-api2-db', '名字仍按项目名派生');
  }

  section('P9 API 读不到时：不阻塞、不改写（只告警）');
  {
    const api = fakeApi({ db: [], buckets: [] });
    api.listD1 = async () => ({ error: 'boom' });
    api.listR2 = async () => ({ error: 'boom' });
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0, '不报错');
    ok(r.toml === TOML, '不改写配置');
    ok(r.notes.filter((n) => /could not list/.test(n)).length === 2, '两条告警', r.notes.join(' | '));
  }

  section('P10 R2 已绑定 → 保留（不新建）');
  {
    const state = { db: [], buckets: [{ name: 'resend-mail-attachments', created: old }, { name: 'resend-mail-api2-bucket', created: old }] };
    const api = fakeApi(state);
    api.ownBindings = async () => ({ exists: true, d1Ids: [], bucketNames: ['resend-mail-attachments'] });
    const r = await pre.resolveResources(TOML, api, { workerName: 'resend-mail-api2' });
    ok(r.conflicts.length === 0 && bucketOf(r.toml) === 'resend-mail-attachments', '⭐ 已绑定的桶优先', bucketOf(r.toml));
    ok(api.created.r2.length === 0, '没有新建桶');
  }

  section('P11 main() 在没有 token 时直接放行（本地部署不受影响）');
  {
    const saved = { t: process.env.CLOUDFLARE_API_TOKEN, a: process.env.CLOUDFLARE_ACCOUNT_ID };
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const code = await pre.main();
    ok(code === 0, '无 token -> 退出码 0（跳过守卫）', code);
    if (saved.t) process.env.CLOUDFLARE_API_TOKEN = saved.t;
    if (saved.a) process.env.CLOUDFLARE_ACCOUNT_ID = saved.a;
  }

  console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
  if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
  process.exit(failures.length ? 1 : 0);
})();
