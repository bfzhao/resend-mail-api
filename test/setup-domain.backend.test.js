'use strict';

/* =============================================================================
 * Setup wizard "domain + automatic DNS" backend regression -- real SQLite + real compiled artifacts + real Worker routing
 *
 * Run (this sandbox needs the tsc shim, see notes at end of file):
 *   NODE_OPTIONS="--require <temp dir>/mm-tsc-shim.js" node test/setup-domain.backend.test.js
 * Normal environment:
 *   node test/setup-domain.backend.test.js
 *
 * Exit codes: 0 = all pass; 1 = failures; 2 = missing environment (node:sqlite / tsc unavailable).
 *
 * External interfaces (api.cloudflare.com / api.resend.com / dns.google) are all **stubbed**,
 * so what is asserted is "what requests the wizard sent them and how results were persisted",
 * not the real network.
 *
 * Invariants to watch:
 *   ⭐ Not logged in must not trigger DNS writes (401).
 *   ⭐ A successful configuration: find zone -> enable receiving routing -> catch-all->worker -> create Resend domain -> write DNS -> trigger verification.
 *   ⭐ CF Token is **discarded after use**: it never appears in app_config.
 *   ⭐ Resend Key / sender address persisted, and existing send logic (/api/account) works with no changes.
 *   ⭐ Self-check really verifies MX/DKIM/SPF/DMARC via public DNS.
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('node:sqlite 不可用（需要 Node >= 22.5）。', String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const WORK_DIR = path.join(os.tmpdir(), `setup-domain-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');

function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc: ${tsc}`);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SRC_COPY, { recursive: true });
  try {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK_DIR, 'node_modules'), 'junction');
  } catch (e) {
    throw new Error(`无法为临时编译目录链接 node_modules: ${e.message}`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.ts')) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(SRC_COPY, f));
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  delete cfg.include;
  delete cfg.exclude;
  cfg.files = fs.readdirSync(SRC_COPY).filter((f) => f.endsWith('.ts')).map((f) => path.join(SRC_COPY, f));
  cfg.compilerOptions = Object.assign({}, cfg.compilerOptions, {
    noEmit: false,
    module: 'commonjs',
    outDir: BUILD_DIR,
    rootDir: SRC_COPY,
  });
  const cfgPath = path.join(WORK_DIR, 'tsconfig.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) throw new Error(`tsc 编译失败(exit=${r.status}): ${out}`);
  if (!fs.existsSync(path.join(BUILD_DIR, 'index.js'))) throw new Error(`编译产物缺失: ${path.join(BUILD_DIR, 'index.js')}`);
  return BUILD_DIR;
}

function cleanup() {
  const link = path.join(WORK_DIR, 'node_modules');
  try {
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeD1() {
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const prepare = (sql) => {
    const st = {
      sql, args: [],
      bind(...a) { st.args = a; return st; },
      async run() { const r = db.prepare(sql).run(...norm(st.args)); return { success: true, results: [], meta: { changes: Number(r.changes) } }; },
      async first() { const row = db.prepare(sql).get(...norm(st.args)); return row === undefined ? null : row; },
      async all() { return { results: db.prepare(sql).all(...norm(st.args)), success: true, meta: {} }; },
    };
    return st;
  };
  return {
    prepare,
    batch: async (arr) => { for (const s of arr) await s.run(); return []; },
    exec: async () => ({ count: 0, duration: 0 }),
    query: (sql, ...a) => db.prepare(sql).all(...norm(a)),
    queryOne: (sql, ...a) => { const r = db.prepare(sql).get(...norm(a)); return r === undefined ? null : r; },
  };
}

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

function sessionCookieOf(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const c = all.find((x) => x && x.startsWith('mail_session='));
  return c ? c.split(';')[0] : null;
}

const CF_TOKEN = 'cf-secret-token-xyz';
const RESEND_KEY = 're_totally_secret_key';

(async function main() {
  console.log('安装向导（域名/自动 DNS）—— 真实 SQLite + 真实编译产物 + 真实 Worker 路由');
  let entry;
  try { entry = build(); }
  catch (e) {
    console.error(`\n编译失败，无法继续：${e.message}`);
    console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
    process.exit(2);
  }

  const worker = require(path.join(entry, 'index.js'));
  const db = makeD1();
  const env = { DB: db };

  /* ---- external API stubs ---- */
  const externalCalls = [];
  const dnsRecords = [];
  let zoneFound = true;
  let routingEnabled = false;
  const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = String((init && init.method) || 'GET').toUpperCase();
    const body = init && init.body ? JSON.parse(init.body) : null;
    externalCalls.push({ url: u, method, body });

    if (u.startsWith('https://api.cloudflare.com/client/v4/zones?')) {
      return jsonRes({ success: true, result: zoneFound ? [{ id: 'zone1', name: 'example.com' }] : [] });
    }
    if (/\/zones\/zone1\/email\/routing$/.test(u)) {
      return jsonRes({ success: true, result: { enabled: routingEnabled } });
    }
    if (/\/zones\/zone1\/email\/routing\/dns$/.test(u) && method === 'POST') {
      routingEnabled = true;
      return jsonRes({ success: true, result: { enabled: true } });
    }
    if (/\/zones\/zone1\/email\/routing\/rules\/catch_all$/.test(u)) {
      return jsonRes({ success: true, result: { enabled: true, actions: body.actions } });
    }
    if (/\/zones\/zone1\/dns_records\?/.test(u) && method === 'GET') {
      // the real listDnsRecords filters by both type + name (same name, different type = two records)
      const q = new URL(u);
      const name = q.searchParams.get('name') || '';
      const type = q.searchParams.get('type') || '';
      return jsonRes({ success: true, result: dnsRecords.filter((r) => r.name === name && (!type || r.type === type)) });
    }
    if (/\/zones\/zone1\/dns_records$/.test(u) && method === 'POST') {
      const rec = { id: `dns-${dnsRecords.length + 1}`, ...body };
      dnsRecords.push(rec);
      return jsonRes({ success: true, result: rec });
    }
    if (u === 'https://api.resend.com/domains' && method === 'POST') {
      return jsonRes({
        id: 'dom1', name: 'example.com', status: 'not_started',
        records: [
          { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGf...', ttl: 'Auto' },
          { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, ttl: 'Auto' },
          { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', ttl: 'Auto' },
          { record: 'DMARC', name: '_dmarc', type: 'TXT', value: 'v=DMARC1; p=none;', ttl: 'Auto' },
        ],
      });
    }
    if (u === 'https://api.resend.com/domains/dom1/verify' && method === 'POST') {
      return jsonRes({ id: 'dom1' });
    }
    if (u === 'https://api.resend.com/domains/dom1') {
      return jsonRes({ id: 'dom1', name: 'example.com', status: 'pending' });
    }
    if (u.startsWith('https://dns.google/resolve')) {
      const q = new URL(u);
      const name = q.searchParams.get('name') || '';
      const type = q.searchParams.get('type') || '';
      if (type === 'MX' && name === 'example.com') return jsonRes({ Answer: [{ name, type: 15, data: '10 route1.mx.cloudflare.net.' }] });
      if (type === 'TXT' && name === 'resend._domainkey.example.com') return jsonRes({ Answer: [{ name, type: 16, data: '"p=MIGf..."' }] });
      if (type === 'TXT' && name === 'send.example.com') return jsonRes({ Answer: [{ name, type: 16, data: '"v=spf1 include:amazonses.com ~all"' }] });
      if (type === 'TXT' && name === '_dmarc.example.com') return jsonRes({ Answer: [{ name, type: 16, data: '"v=DMARC1; p=none;"' }] });
      return jsonRes({ Answer: [] });
    }
    return jsonRes({});
  };

  const call = async (method, p, body, cookie) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers['cookie'] = cookie;
    const req = new Request(`https://example.com${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await worker.default.fetch(req, env);
    return { status: res.status, json: await res.json().catch(() => null), setCookie: sessionCookieOf(res) };
  };

  const cfg = (key) => { const r = db.queryOne('SELECT value FROM app_config WHERE key = ?', key); return r ? r.value : null; };

  section('T0 环境自检');
  ok(typeof worker.default.fetch === 'function', 'Worker 入口已加载');

  section('T1 未登录：向导域名端点 401（不得触发任何外部调用）');
  let r = await call('POST', '/api/setup/domain', { domain: 'example.com', cf_token: CF_TOKEN, resend_key: RESEND_KEY });
  ok(r.status === 401, '未登录 -> 401', r.status);
  ok(externalCalls.length === 0, '未发出任何 Cloudflare/Resend 请求', externalCalls.length);

  section('T2 建管理员（拿到会话 cookie）');
  r = await call('POST', '/api/setup/admin', { username: 'admin', password: 'secret123' });
  ok(r.status === 200, '建管理员成功', r.status);
  const cookie = r.setCookie;
  ok(!!cookie, '拿到会话 cookie');

  section('T3 参数校验');
  r = await call('POST', '/api/setup/domain', { domain: 'not a domain', cf_token: CF_TOKEN, resend_key: RESEND_KEY }, cookie);
  ok(r.status === 400 && r.json && /域名/.test(r.json.error || ''), '非法域名 -> 400', r.json && r.json.error);
  r = await call('POST', '/api/setup/domain', { domain: 'example.com', resend_key: RESEND_KEY }, cookie);
  ok(r.status === 400 && /Cloudflare/.test(r.json.error || ''), '缺 CF Token -> 400', r.json && r.json.error);

  section('T4 域名不在 CF：明确报错');
  zoneFound = false;
  r = await call('POST', '/api/setup/domain', { domain: 'example.com', cf_token: CF_TOKEN, resend_key: RESEND_KEY }, cookie);
  ok(r.status === 200 && r.json && r.json.ok === false && /Cloudflare/.test(r.json.error || ''),
    '找不到 zone -> ok=false 且错误说明 Cloudflare 账户/权限', r.json && r.json.error);
  ok((r.json.steps || []).some((s) => s.ok === false), '错误步骤随响应返回（供前端展示）');
  ok(cfg('domain') === null, '未落库 domain（失败不应写配置）');
  zoneFound = true;

  section('T5 成功配置：找 zone → 开路由 → catch-all → Resend 建域 → 写 DNS → 校验');
  externalCalls.length = 0;
  r = await call('POST', '/api/setup/domain', {
    domain: 'example.com', cf_token: CF_TOKEN, resend_key: RESEND_KEY, from_name: 'Support',
  }, cookie);
  ok(r.status === 200 && r.json && r.json.ok === true, '配置成功 -> ok', r.json && r.json.ok);
  ok(Array.isArray(r.json.steps) && r.json.steps.every((s) => s.ok), '全部步骤 ok', JSON.stringify((r.json.steps || []).map((s) => s.name)));

  const urls = externalCalls.map((c) => `${c.method} ${c.url.split('?')[0]}`);
  ok(urls.includes('GET https://api.cloudflare.com/client/v4/zones'), '查了 zone', 'GET zones');
  ok(urls.includes('POST https://api.cloudflare.com/client/v4/zones/zone1/email/routing/dns'), '开启了收信路由');
  ok(urls.includes('PUT https://api.cloudflare.com/client/v4/zones/zone1/email/routing/rules/catch_all'), '设置了 catch-all');
  ok(urls.includes('POST https://api.resend.com/domains'), 'Resend 建域');
  ok(urls.includes('POST https://api.resend.com/domains/dom1/verify'), '触发 Resend 校验');
  ok(dnsRecords.length === 4, '把 4 条 DNS 记录写进了 CF', dnsRecords.length);
  ok(dnsRecords.some((x) => x.name === 'resend._domainkey.example.com' && x.type === 'TXT'), 'DKIM 记录写入');
  ok(dnsRecords.some((x) => x.name === 'send.example.com' && x.type === 'MX' && x.priority === 10), 'SPF MX 记录写入（含优先级）');
  ok(dnsRecords.some((x) => x.name === '_dmarc.example.com'), 'DMARC 记录写入');

  const catchAll = externalCalls.find((c) => /rules\/catch_all$/.test(c.url));
  ok(catchAll && catchAll.body.actions[0].type === 'worker' && catchAll.body.actions[0].value[0] === 'resend-mail-api',
    'catch-all 指向本 Worker', JSON.stringify(catchAll && catchAll.body.actions));

  section('T6 落库 + ⭐ CF Token 用完即弃');
  ok(cfg('domain') === 'example.com', 'domain 落库', cfg('domain'));
  ok(cfg('zone_id') === 'zone1', 'zone_id 落库', cfg('zone_id'));
  ok(cfg('resend_api_key') === RESEND_KEY, 'Resend Key 落库', cfg('resend_api_key'));
  ok(cfg('from_address') === 'noreply@example.com', '发件地址默认 noreply@<domain>', cfg('from_address'));
  ok(cfg('from_name') === 'Support', '发件显示名落库', cfg('from_name'));
  ok(cfg('setup_complete') === '1', 'setup_complete 标记');
  const allValues = db.query('SELECT value FROM app_config').map((row) => String(row.value));
  ok(!allValues.some((v) => v.includes(CF_TOKEN)), '⭐ app_config 中不含 CF Token（用完即弃）');
  ok(cfg('cf_token') === null, '不存在 cf_token 配置键');

  section('T7 向导配置对既有发送逻辑生效（/api/account）');
  r = await call('GET', '/api/account', undefined, cookie);
  ok(r.status === 200 && r.json.can_send === true, '未配 env、仅向导配置也能发信', r.json && `${r.json.can_send}/${r.json.from_address}`);
  ok(r.json.from_address === 'noreply@example.com', '账户发件地址来自向导配置', r.json && r.json.from_address);

  section('T8 status 反映已配置');
  r = await call('GET', '/api/setup/status', undefined, cookie);
  ok(r.json && r.json.domain === 'example.com' && r.json.complete === true, 'status: domain + complete', r.json && `${r.json.domain}/${r.json.complete}`);

  section('T9 自检：公共 DNS 真实验证 MX/DKIM/SPF/DMARC');
  r = await call('GET', '/api/setup/check');
  ok(r.status === 401, '未登录自检 -> 401', r.status);
  r = await call('GET', '/api/setup/check', undefined, cookie);
  ok(r.status === 200 && r.json && r.json.ok === true, '自检全绿', r.json && r.json.ok);
  const names = (r.json.items || []).map((i) => i.name);
  ok(names.includes('收信 MX') && names.includes('DKIM') && names.includes('SPF'), '含 MX/DKIM/SPF 检查', names.join(','));
  ok((r.json.items || []).every((i) => i.ok), '每一项都通过', JSON.stringify((r.json.items || []).filter((i) => !i.ok)));

  cleanup();
  console.log(`\n===== 总结：${pass} 通过，${failures.length} 失败 =====`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试运行异常：', e);
  cleanup();
  process.exit(1);
});
