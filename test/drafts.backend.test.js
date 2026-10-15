'use strict';

/* =============================================================================
 * 草稿箱（drafts）后端回归验证 —— 真实 SQLite 当 D1 + 真实 src/ 编译产物 + 真实 Worker 路由
 *
 * 运行（本沙箱需 tsc 垫片，见文件末尾说明）：
 *   NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js" node test/drafts.backend.test.js
 * 正常环境：
 *   node test/drafts.backend.test.js
 *
 * 退出码：0 = 全部通过；1 = 存在失败；2 = 环境缺失（node:sqlite 不可用 / tsc 不可用）。
 *
 * 覆盖本轮新增的「写了一半的邮件自动存草稿」后端部分：
 *   · GET/PUT/DELETE /api/drafts/:id  —— upsert 语义、字段往返一致、参数校验
 *   · GET /api/folders/drafts         —— 返回形状与其它文件夹一致（伪装 direction='draft'）
 *   · /api/counts 的 drafts_total     —— 与草稿箱 total 同口径，且「全部邮箱」= 各分组之和
 *   · 发送成功后丢弃草稿               —— 写信 / 回复 / 合并发送三条路径
 *
 * 为什么用真实 SQLite：这些缺陷都是「存进库里的值不对」（收件人切分口径、upsert 变插入、
 * 计数与列表不一致）。只在参数层面断言会把测试锁死在列顺序上；这里让真实的
 * routeApi 跑完，再把数据 SELECT 回来比对，断言的是**最终数据**。
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('node:sqlite 不可用（需要 Node >= 22.5）。', String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
// QA_REPO_TS 仅用于「变异验证」：指向一份人工构造的 repo.ts 变体（放仓库外）。
const REPO_TS = process.env.QA_REPO_TS || path.join(ROOT, 'src', 'repo.ts');
const WORK_DIR = path.join(os.tmpdir(), `drafts-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');
const REPO_MD5 = crypto.createHash('md5').update(fs.readFileSync(REPO_TS)).digest('hex');
const MAILBOX = 'support@notionmanager.com';
const ALIAS = 'alias@notionmanager.com';

/* ---------------------------------------------------------------------------
 * 1) 把整份 src/ 复制到仓库外（变体覆盖 repo.ts）后编译
 *
 * ⚠️ 两个必须的配套（少了任何一个都会编译失败，且报错看起来与变体无关）：
 *   a) 临时目录在 os.tmpdir() 下，类型解析与产物的裸模块解析都要靠 node_modules ——
 *      必须在**编译之前**把 WORK_DIR/node_modules 链接到仓库 node_modules；
 *   b) module 改成 commonjs 后**不要**顺手改 moduleResolution：本机 tsc 是 TypeScript 7，
 *      `node10` 已被移除（TS5108）。
 * -------------------------------------------------------------------------*/
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
  fs.copyFileSync(REPO_TS, path.join(SRC_COPY, 'repo.ts'));

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

/* ---------------------------------------------------------------------------
 * 2) 真实 SQLite 冒充 D1
 * -------------------------------------------------------------------------*/
function makeD1() {
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);

  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const prepare = (sql) => {
    const st = {
      sql,
      args: [],
      bind(...a) { st.args = a; return st; },
      async run() {
        const r = db.prepare(sql).run(...norm(st.args));
        return { success: true, results: [], meta: { changes: Number(r.changes) } };
      },
      async first() {
        const row = db.prepare(sql).get(...norm(st.args));
        return row === undefined ? null : row;
      },
      async all() {
        return { results: db.prepare(sql).all(...norm(st.args)), success: true, meta: {} };
      },
    };
    return st;
  };

  return {
    prepare,
    batch: async (arr) => { for (const s of arr) await s.run(); return []; },
    exec: async () => ({ count: 0, duration: 0 }),
    query: (sql, ...args) => db.prepare(sql).all(...norm(args)),
    queryOne: (sql, ...args) => {
      const r = db.prepare(sql).get(...norm(args));
      return r === undefined ? null : r;
    },
  };
}

/* ---------------------------------------------------------------------------
 * 3) 迷你断言器
 * -------------------------------------------------------------------------*/
let pass = 0;
const results = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; results.push({ ok: true, msg }); console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { results.push({ ok: false, msg, detail }); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }
function info(t) { console.log(`  INFO  ${t}`); }

/* ===========================================================================
 * 用例
 * ===========================================================================*/
(async function main() {
  console.log('草稿箱后端 —— 真实 SQLite + 真实编译产物 + 真实 Worker 路由');
  let entry;
  try {
    entry = build();
  } catch (e) {
    console.error(`\n编译失败，无法继续：${e.message}`);
    console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
    process.exit(2);
  }

  const worker = require(path.join(entry, 'index.js'));
  const db = makeD1();
  console.log(`被测版本: src/repo.ts md5=${REPO_MD5}${process.env.QA_REPO_TS ? '  ← QA_REPO_TS 变异体' : ''}`);

  const env = { DB: db, RESEND_API_KEY: 're_test', SEND_FROM_ADDRESS: MAILBOX, SEND_FROM_NAME: 'Support' };

  // 桩掉 Resend 发送：默认成功；failTo 里的收件人返回 500（用来验「部分失败不丢草稿」）
  const sentPayloads = [];
  let failTo = new Set();
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/emails')) {
      const body = init && init.body ? JSON.parse(init.body) : {};
      sentPayloads.push(body);
      const to = Array.isArray(body.to) ? body.to : [body.to];
      if (to.some((t) => failTo.has(String(t)))) return jsonRes({ message: 'boom' }, 500);
      return jsonRes({ id: `resend_${sentPayloads.length}` });
    }
    return jsonRes({});
  };

  const call = async (method, p, body) => {
    const req = new Request(`https://example.com${p}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await worker.default.fetch(req, env);
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  /* ---- T0 环境自检 ---- */
  section('T0 环境自检');
  await db.prepare('INSERT INTO drafts (id, mailbox, mode, to_emails, updated_at, created_at) VALUES (?,?,?,?,?,?)')
    .bind('self-check', MAILBOX, 'new', '[]', 1, 1).run();
  const selfRow = await db.prepare('SELECT COUNT(*) AS n FROM drafts').first();
  ok(Number(selfRow.n) === 1, 'D1 桩确实把数据写进了真实 SQLite（否则后面全是空转）', selfRow.n);
  await db.prepare('DELETE FROM drafts WHERE id = ?').bind('self-check').run();
  ok(typeof worker.default.fetch === 'function', 'Worker 入口已加载（走真实路由 + 真实 repo）');

  /* ---- T1 PUT 新建 → GET 回读，字段往返一致 ---- */
  section('T1 草稿 PUT/GET 往返');
  let r = await call('PUT', '/api/drafts/d1', {
    mode: 'reply',
    source_id: 'msg-1',
    mailbox: MAILBOX,
    to: 'a@x.com, b@y.com',
    cc: 'c@z.com',
    bcc: 'd@w.com',
    subject: '写了一半',
    body: '正文内容',
    html: '<p>正文内容</p>',
    rich: true,
  });
  ok(r.status === 200 && r.json && r.json.ok === true, 'PUT 新建草稿返回 200', JSON.stringify(r.json));
  r = await call('GET', '/api/drafts/d1');
  const d = r.json && r.json.draft;
  ok(r.status === 200 && !!d, 'GET 能读回草稿', r.status);
  ok(d && d.mode === 'reply', 'mode 往返一致（决定恢复时的弹窗标题）', d && d.mode);
  ok(d && d.source_id === 'msg-1', 'source_id 往返一致（回复草稿要取回原邮件）', d && d.source_id);
  ok(d && Array.isArray(d.to) && d.to.join(',') === 'a@x.com,b@y.com', 'to 以数组返回', d && JSON.stringify(d.to));
  ok(d && Array.isArray(d.cc) && d.cc.join(',') === 'c@z.com', 'cc 以数组返回', d && JSON.stringify(d.cc));
  ok(d && Array.isArray(d.bcc) && d.bcc.join(',') === 'd@w.com', 'bcc 以数组返回', d && JSON.stringify(d.bcc));
  ok(d && d.subject === '写了一半', '主题往返一致', d && d.subject);
  ok(d && d.body_text === '正文内容' && d.body_html === '<p>正文内容</p>', '正文（text/html）都保留');
  ok(d && d.rich === true, 'rich 以布尔返回（不是 1/0）', d && JSON.stringify(d.rich));

  /* ---- T1b 收件人切分口径与发送同源 ---- */
  section('T1b 收件人切分口径（与发送同源）');
  r = await call('PUT', '/api/drafts/d-split', { mailbox: MAILBOX, to: 'a@x.com; b@y.com, c@z.com', body: 'x' });
  ok(r.status === 200, 'PUT 成功', r.status);
  let dd = (await call('GET', '/api/drafts/d-split')).json.draft;
  ok(dd.to.join(',') === 'a@x.com,b@y.com,c@z.com',
    '⭐ 逗号 / 分号混用都能切开（与发送侧同一个 splitRecipients）', JSON.stringify(dd.to));
  r = await call('PUT', '/api/drafts/d-split', { mailbox: MAILBOX, to: ['a@x.com', 'b@y.com'], body: 'x' });
  dd = (await call('GET', '/api/drafts/d-split')).json.draft;
  ok(dd.to.join(',') === 'a@x.com,b@y.com', '数组形态同样接受', JSON.stringify(dd.to));

  /* ---- T2 upsert 语义：同一 id 覆盖而不是新增 ---- */
  section('T2 PUT 同一 id 必须覆盖（upsert），不能变成插入');
  const before = db.queryOne('SELECT COUNT(*) AS n FROM drafts');
  await call('PUT', '/api/drafts/d1', { mailbox: MAILBOX, subject: '改过的主题', body: 'v2' });
  const after = db.queryOne('SELECT COUNT(*) AS n FROM drafts');
  ok(Number(before.n) === Number(after.n), '行数不变（没有多插一行）', `${before.n} -> ${after.n}`);
  dd = (await call('GET', '/api/drafts/d1')).json.draft;
  ok(dd.subject === '改过的主题' && dd.body_text === 'v2', '内容被覆盖为最新', JSON.stringify(dd.subject));
  ok(dd.cc.length === 0 && dd.bcc.length === 0, '⭐ 覆盖时旧 cc/bcc 一起清空（不能留下上一版收件人）', JSON.stringify(dd.cc));

  /* ---- T3 列表：形状与其它文件夹一致 ---- */
  section('T3 GET /api/folders/drafts');
  r = await call('GET', '/api/folders/drafts');
  ok(r.status === 200 && r.json && r.json.folder === 'drafts', 'folder 字段 = drafts', r.json && r.json.folder);
  ok(r.json.items.length === 2, '列表返回 2 条草稿', String(r.json.items.length));
  const it0 = r.json.items[0];
  ok(it0.direction === 'draft', "⭐ direction 伪装成 'draft'（前端复用同一套列表渲染）", it0.direction);
  ok(it0.status === 'draft', "status = 'draft'", it0.status);
  ok(it0.read === 1, '草稿没有未读语义（read 恒 1）', String(it0.read));
  ok(typeof it0.received_at === 'number' && it0.received_at > 0, 'received_at 是秒级时间戳（供列表排序/展示复用）', String(it0.received_at));
  ok(it0.received_at === db.queryOne('SELECT updated_at FROM drafts WHERE id = ?', it0.id).updated_at,
    '⭐ received_at 用 updated_at 填充（草稿的排序语义=最后修改时间）', String(it0.received_at));
  ok(r.json.total === 2, 'total 与 items 条数一致', String(r.json.total));
  const newest = db.queryOne('SELECT id FROM drafts ORDER BY updated_at DESC, id DESC LIMIT 1');
  ok(it0.id === newest.id, '⭐ 列表按 updated_at DESC 排序（最新改的排最前）', `${it0.id} vs ${newest.id}`);

  /* ---- T4 计数：drafts_total 与草稿箱 total 同口径 ---- */
  section('T4 /api/counts 的 drafts_total');
  r = await call('GET', '/api/counts');
  ok(r.json && r.json.drafts_total === 2, 'drafts_total = 2', String(r.json && r.json.drafts_total));
  const listAll = (await call('GET', '/api/folders/drafts')).json;
  ok(r.json.drafts_total === listAll.total, '⭐ 计数与列表 total 一致（同一套 WHERE）',
    `${r.json.drafts_total} vs ${listAll.total}`);

  // 再加一封归属另一个信箱的草稿 -> 「全部邮箱」必须等于各分组之和
  await call('PUT', '/api/drafts/d-alias', { mailbox: ALIAS, subject: '另一个信箱的草稿', body: 'y' });
  const countsAll = (await call('GET', '/api/counts')).json;
  const cM = (await call('GET', `/api/counts?mailbox=${encodeURIComponent(MAILBOX)}`)).json;
  const cA = (await call('GET', `/api/counts?mailbox=${encodeURIComponent(ALIAS)}`)).json;
  ok(countsAll.drafts_total === cM.drafts_total + cA.drafts_total,
    '⭐「全部邮箱」drafts_total === 各信箱之和（不变量不破）',
    `${countsAll.drafts_total} = ${cM.drafts_total} + ${cA.drafts_total}`);
  ok(cM.drafts_total === 2 && cA.drafts_total === 1, '各信箱草稿数正确', `${cM.drafts_total} / ${cA.drafts_total}`);
  const listM = (await call('GET', `/api/folders/drafts?mailbox=${encodeURIComponent(MAILBOX)}`)).json;
  ok(listM.total === 2 && listM.items.every((x) => x.mailbox === MAILBOX), '按 mailbox 过滤列表正确', String(listM.total));

  /* ---- T5 搜索 ---- */
  section('T5 草稿箱搜索');
  const listQ = (await call('GET', '/api/folders/drafts?q=' + encodeURIComponent('另一个'))).json;
  ok(listQ.total === 1 && listQ.items[0].id === 'd-alias', 'q 命中主题', JSON.stringify(listQ.items.map((x) => x.id)));

  /* ---- T6 DELETE ---- */
  section('T6 DELETE 丢弃草稿');
  r = await call('DELETE', '/api/drafts/d-alias');
  ok(r.status === 200 && r.json.ok === true, 'DELETE 返回 200', JSON.stringify(r.json));
  ok(db.queryOne('SELECT COUNT(*) AS n FROM drafts WHERE id = ?', 'd-alias').n === 0, '库里确实删掉了');
  r = await call('DELETE', '/api/drafts/d-alias');
  ok(r.status === 200, '重复删除幂等（不报错）', r.status);

  /* ---- T7 参数校验 ---- */
  section('T7 参数校验与 404');
  r = await call('PUT', '/api/drafts/d-bad', null);
  ok(r.status === 400, 'PUT 无 body -> 400', r.status);
  r = await call('GET', '/api/drafts/不存在');
  ok(r.status === 404, 'GET 不存在的草稿 -> 404', r.status);
  r = await call('POST', '/api/drafts/d1');
  ok(r.status === 405, '不支持的 method -> 405', r.status);
  // PUT 一个全新 id 就是新建（前端打开弹窗时先生成 id）
  r = await call('PUT', '/api/drafts/d-new-id', { mailbox: MAILBOX, subject: 's', body: 'b' });
  ok(r.status === 200 && db.queryOne('SELECT COUNT(*) AS n FROM drafts WHERE id = ?', 'd-new-id').n === 1,
    'PUT 全新 id = 新建（前端先生成 id 的协议）');
  await call('DELETE', '/api/drafts/d-new-id');

  /* ---- T8 写信成功后丢弃草稿 ---- */
  section('T8 发送成功后自动丢弃草稿');
  await call('PUT', '/api/drafts/d-send', { mailbox: MAILBOX, to: 'a@x.com', subject: 's', body: 'b' });
  r = await call('POST', '/api/messages', {
    to: 'a@x.com', subject: 's', body: 'b', mailbox: MAILBOX, draft_id: 'd-send',
  });
  ok(r.status === 200 && r.json.ok === true, '写信成功', JSON.stringify(r.json));
  ok(db.queryOne('SELECT COUNT(*) AS n FROM drafts WHERE id = ?', 'd-send').n === 0,
    '⭐ 发信成功后草稿被删除（不会在草稿箱里留一份已发出去的信）');

  /* ---- T9 发送失败时保留草稿 ---- */
  section('T9 发送失败必须保留草稿');
  await call('PUT', '/api/drafts/d-fail', { mailbox: MAILBOX, to: 'a@x.com', subject: 's', body: 'b' });
  failTo = new Set(['a@x.com']);
  r = await call('POST', '/api/messages', { to: 'a@x.com', subject: 's', body: 'b', mailbox: MAILBOX, draft_id: 'd-fail' });
  failTo = new Set();
  ok(r.status >= 400, '发送失败返回错误', r.status);
  ok(db.queryOne('SELECT COUNT(*) AS n FROM drafts WHERE id = ?', 'd-fail').n === 1,
    '⭐ 发送失败 -> 草稿必须保留（删了就等于把内容丢了）');
  await call('DELETE', '/api/drafts/d-fail');

  /* ---- T10 合并发送：全部成功才删，部分失败要留 ---- */
  section('T10 合并发送的草稿丢弃策略');
  await call('PUT', '/api/drafts/d-merge-ok', { mailbox: MAILBOX, to: 'a@x.com, b@y.com', subject: 's', body: 'b' });
  r = await call('POST', '/api/messages', {
    to: 'a@x.com, b@y.com', subject: 's', body: 'b', mailbox: MAILBOX, merge: true, draft_id: 'd-merge-ok',
  });
  ok(r.status === 200 && r.json.ok === true && r.json.merge === true, '合并发送全部成功', JSON.stringify(r.json && r.json.sent && r.json.sent.length));
  ok(db.queryOne('SELECT COUNT(*) AS n FROM drafts WHERE id = ?', 'd-merge-ok').n === 0, '全部成功 -> 草稿删除');

  await call('PUT', '/api/drafts/d-merge-part', { mailbox: MAILBOX, to: 'a@x.com, b@y.com', subject: 's', body: 'b' });
  failTo = new Set(['b@y.com']);
  r = await call('POST', '/api/messages', {
    to: 'a@x.com, b@y.com', subject: 's', body: 'b', mailbox: MAILBOX, merge: true, draft_id: 'd-merge-part',
  });
  failTo = new Set();
  ok(r.json && r.json.ok === false && r.json.failed.length === 1, '部分失败（1 成功 1 失败）', JSON.stringify(r.json && r.json.failed));
  ok(db.queryOne('SELECT COUNT(*) AS n FROM drafts WHERE id = ?', 'd-merge-part').n === 1,
    '⭐ 部分失败 -> 草稿保留（用户可以从草稿箱重发失败的那几个）');
  await call('DELETE', '/api/drafts/d-merge-part');

  /* ---- T11 回复成功后丢弃草稿 ---- */
  section('T11 回复成功后丢弃草稿');
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    `INSERT INTO messages (id, direction, message_id, thread_id, mailbox, from_email, to_emails, subject, body_text, received_at, status, read, starred, deleted, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind('orig-1', 'inbound', 'm-orig@peer', 'm-orig@peer', MAILBOX, 'peer@x.com', `["${MAILBOX}"]`, 'Re: 话题', '原文', now, 'received', 0, 0, 0, now, now).run();
  await call('PUT', '/api/drafts/d-reply', { mode: 'reply', source_id: 'orig-1', mailbox: MAILBOX, to: 'peer@x.com', subject: 'Re: 话题', body: '回复正文' });
  r = await call('POST', '/api/messages/orig-1/reply', { body: '回复正文', mailbox: MAILBOX, draft_id: 'd-reply' });
  ok(r.status === 200 && r.json.ok === true, '回复成功', JSON.stringify(r.json));
  ok(db.queryOne('SELECT COUNT(*) AS n FROM drafts WHERE id = ?', 'd-reply').n === 0, '⭐ 回复成功后草稿被删除');

  /* ---- T12 不带 draft_id 的发送不受影响 ---- */
  section('T12 不带 draft_id 时一切照旧（负控制）');
  await call('PUT', '/api/drafts/d-keep', { mailbox: MAILBOX, to: 'k@x.com', subject: 's', body: 'b' });
  r = await call('POST', '/api/messages', { to: 'a@x.com', subject: 's', body: 'b', mailbox: MAILBOX });
  ok(r.status === 200 && r.json.ok === true, '不带 draft_id 也能正常发信', r.status);
  ok(db.queryOne('SELECT COUNT(*) AS n FROM drafts WHERE id = ?', 'd-keep').n === 1,
    '⭐ 别人的草稿不会被顺手删掉（只删请求里指定的那个 id）');

  /* ---- 汇总 ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((x) => !x.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);
  console.log(`\n===== 结果: ${pass} passed, ${failed.length} failed =====`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
})();
