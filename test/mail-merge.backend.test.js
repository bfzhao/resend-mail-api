'use strict';

/* =============================================================================
 * 独立验证（QA）：「合并发送」后端逻辑 —— 编译真实 src/ 后驱动真实 compose()
 *
 * 运行：
 *   <node.exe> test/mail-merge.backend.test.js
 *
 * 做法（项目无构建步骤、零测试框架）：
 *   1. 用仓库自带的 tsc 把 src/ 编译成 CommonJS 到**仓库外**的临时目录
 *      （os.tmpdir()/mm-qa-build-<pid>，退出时删除），不污染项目；
 *   2. require 编译产物，拿到 worker 的 default.fetch；
 *   3. 桩全局 fetch 拦截 https://api.resend.com/emails（可**按收件人**返回不同结果
 *      —— 这是本地唯一能造出「部分成功」的方式）；
 *   4. 桩 env.DB（D1）/ env.BUCKET（R2），驱动真实路由 + 真实 compose/composeMerge。
 *
 * 退出码：0 = 全部通过；1 = 存在失败。本文件不修改 public/ 与 src/。
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC_INDEX = path.join(ROOT, 'src', 'index.ts');
const BUILD_DIR = path.join(os.tmpdir(), `mm-qa-build-${process.pid}`);

const FINGERPRINT = {
  'src/index.ts': crypto.createHash('md5').update(fs.readFileSync(SRC_INDEX)).digest('hex'),
};

/* ---------------------------------------------------------------------------
 * 1) 编译 src/ -> 仓库外临时目录（CommonJS）
 * -------------------------------------------------------------------------*/
function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc: ${tsc}`);
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const r = spawnSync(
    process.execPath,
    [tsc, '-p', path.join(ROOT, 'tsconfig.json'), '--rootDir', 'src', '--module', 'commonjs', '--noEmit', 'false', '--outDir', BUILD_DIR],
    { cwd: ROOT, encoding: 'utf8' }
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) throw new Error(`tsc 编译失败(exit=${r.status}): ${out}`);
  const entry = path.join(BUILD_DIR, 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`编译产物缺失: ${entry}`);
  // 编译产物在仓库外，Node 找不到 'resend' 等依赖；用 junction 指回仓库 node_modules
  // （不复制、不安装，只在临时目录里建一个链接）
  const link = path.join(BUILD_DIR, 'node_modules');
  try {
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(ROOT, 'node_modules'), link, 'junction');
  } catch (e) {
    throw new Error(`无法为临时编译目录链接 node_modules（需仓库外可建 junction）: ${e.message}`);
  }
  return { out, entry };
}

/* ---------------------------------------------------------------------------
 * 2) D1 / R2 / fetch 桩
 * -------------------------------------------------------------------------*/
function makeDB(opts = {}) {
  const executed = [];
  // firstHandler(sql, args) -> row | null：默认恒 null（合并发送路径不需要读回数据）。
  // 回信路径需要 getMessage() 拿到原邮件，故允许用例注入。
  const firstHandler = typeof opts.first === 'function' ? opts.first : () => null;
  const mk = (sql) => {
    const st = {
      sql,
      args: [],
      bind(...a) { st.args = a; return st; },
      async run() { executed.push({ sql, args: st.args }); return { success: true, results: [], meta: {} }; },
      async first() { executed.push({ sql, args: st.args }); return firstHandler(sql, st.args) ?? null; },
      async all() { executed.push({ sql, args: st.args }); return { results: [], success: true, meta: {} }; },
    };
    return st;
  };
  return {
    prepare: (sql) => mk(sql),
    batch: async (arr) => { for (const s of arr) executed.push({ sql: s.sql, args: s.args }); return []; },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    _executed: executed,
    /** 所有 INSERT INTO messages 语句（= saveOutbound 调用记录） */
    messageInserts() {
      return executed.filter((e) => /INSERT INTO messages/i.test(e.sql));
    },
    attachmentInserts() {
      return executed.filter((e) => /INSERT INTO attachments/i.test(e.sql));
    },
  };
}

function makeBucket() {
  const puts = [];
  return {
    puts,
    async put(key, value, opts) { puts.push({ key, size: value && value.length, opts }); return {}; },
    async get() { return null; },
    async delete() { return {}; },
    async list() { return { objects: [] }; },
  };
}

/** Resend 桩：handler(body, callIndex) -> { status, payload } 或抛异常 */
function makeResendStub(handler) {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    if (url.startsWith('https://api.resend.com/emails')) {
      const body = JSON.parse(init.body);
      const idx = calls.length;
      calls.push({ url, method: init.method, headers: init.headers, body });
      const r = handler ? handler(body, idx) : { status: 200, payload: { id: `re-${idx}` } };
      if (r && r.throw) throw new Error(r.throw);
      const status = (r && r.status) || 200;
      return new Response(JSON.stringify((r && r.payload) || { id: `re-${idx}` }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  return { calls, bodyOf: (i) => calls[i].body, reset() { calls.length = 0; } };
}

/* ---------------------------------------------------------------------------
 * 3) 调用真实的 /api/messages
 * -------------------------------------------------------------------------*/
function makeEnv(db, bucket, extra = {}) {
  return Object.assign({
    DB: db,
    BUCKET: bucket,
    RESEND_API_KEY: 're_test_key',
    SEND_FROM_ADDRESS: 'support@notionmanager.com',
    SEND_FROM_NAME: 'support',
  }, extra);
}

async function postMessages(worker, env, body) {
  const req = new Request('https://example.com/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { res, status: res.status, data };
}

async function postReply(worker, env, id, body) {
  const req = new Request(`https://example.com/api/messages/${encodeURIComponent(id)}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { res, status: res.status, data };
}

/* ---------------------------------------------------------------------------
 * 用例运行器
 * -------------------------------------------------------------------------*/
const results = [];
let currentTest = '(init)';
let pass = 0;
let fail = 0;

function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  const tail = detail === undefined ? '' : `  [${detail}]`;
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${tail}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }

function section(name) { currentTest = name; console.log(`\n=== ${name} ===`); }

/* =============================================================================
 * 主流程
 * ===========================================================================*/
(async () => {
  const built = build();
  console.log(`编译: ${BUILD_DIR}（仓库外临时目录）`);
  if (built.out) info(`tsc 输出: ${built.out.split('\n')[0]}`);
  const worker = require(built.entry).default;
  if (!worker || typeof worker.fetch !== 'function') throw new Error('编译产物未导出 default.fetch');
  console.log(`被测版本: src/index.ts md5=${FINGERPRINT['src/index.ts']}`);

  const mkCtx = (handler, extra, dbOpts) => {
    const db = makeDB(dbOpts);
    const bucket = makeBucket();
    const resend = makeResendStub(handler);
    const env = makeEnv(db, bucket, extra);
    return {
      db, bucket, resend, env,
      post: (b) => postMessages(worker, env, b),
      reply: (id, b) => postReply(worker, env, id, b),
    };
  };

  /* ---- B1 merge 全成功：N 次调用、每次 to 长度 1、一一对应 ---- */
  section('B1 merge 全成功：N 次 resend 调用 / 每次 to 长度 1 / 一一对应');
  {
    const c = mkCtx();
    const r = await c.post({ to: 'a@x.com, b@y.com, c@z.com', subject: 'Hi', body: 'body', merge: true });
    ok(c.resend.calls.length === 3, '恰好 3 次 fetch 调用', `calls=${c.resend.calls.length}`);
    const tos = c.resend.calls.map((x) => x.body.to);
    ok(tos.every((t) => Array.isArray(t) && t.length === 1), '每次 body.to 长度为 1', JSON.stringify(tos));
    ok(tos.map((t) => t[0]).join(',') === 'a@x.com,b@y.com,c@z.com', '每次 body.to[0] 与收件人一一对应且保序', JSON.stringify(tos));
    ok(c.resend.calls.every((x) => x.body.subject === 'Hi'), '每封主题相同');
    ok(r.status === 200, 'HTTP 200', `status=${r.status}`);
    ok(r.data.ok === true, 'ok === true（全成功）');
    ok(r.data.merge === true, 'merge === true');
    ok(r.data.total === 3, 'total === 3', `total=${r.data.total}`);
    ok(r.data.sent_count === 3 && r.data.failed_count === 0, 'sent_count=3 / failed_count=0', `${r.data.sent_count}/${r.data.failed_count}`);
    ok(Array.isArray(r.data.sent) && r.data.sent.length === 3, 'sent 数组 3 项');
    ok(Array.isArray(r.data.failed) && r.data.failed.length === 0, 'failed 为空数组');
    ok(r.data.sent.every((s) => typeof s.to === 'string' && typeof s.id === 'string' && typeof s.resend_id === 'string'), 'sent 每项含 to/id/resend_id');
    ok(c.db.messageInserts().length === 3, '成功者各存一条 outbound 记录', `inserts=${c.db.messageInserts().length}`);
    const rows = c.db.messageInserts().map((e) => ({ thread: e.args[5], to: JSON.parse(e.args[9]), from: e.args[8], dir: e.args[1] }));
    ok(rows.every((x) => x.dir === 'outbound'), '记录 direction 均为 outbound');
    ok(new Set(rows.map((x) => x.thread)).size === 3, '每人独立 threadId（3 个互不相同）');
    ok(rows.every((x) => x.to.length === 1), '每条记录的 to_emails 只含 1 个地址', JSON.stringify(rows.map((x) => x.to)));
    ok(new Set(rows.map((x) => x.from)).size === 1, '同一个 from（发件人一致）');
  }

  /* ---- B2 merge 部分成功（本地唯一可造出的方式：按收件人返回不同结果） ---- */
  section('B2 merge 部分成功：不中断、分类正确、HTTP 200、ok=false');
  {
    const c = mkCtx((body) => {
      if (body.to[0] === 'b@y.com') return { status: 422, payload: { message: 'invalid recipient' } };
      return { status: 200, payload: { id: `re-${body.to[0]}` } };
    });
    const r = await c.post({ to: 'a@x.com, b@y.com, c@z.com', subject: 'S', body: 'B', merge: true });
    ok(c.resend.calls.length === 3, '失败的收件人**不中断**后续（仍 3 次调用）', `calls=${c.resend.calls.length}`);
    ok(c.resend.calls.map((x) => x.body.to[0]).join(',') === 'a@x.com,b@y.com,c@z.com', '调用顺序与输入顺序一致');
    ok(r.status === 200, 'HTTP 200（部分成功不是错误码）', `status=${r.status}`);
    ok(r.data.ok === false, 'ok === false（部分成功）');
    ok(r.data.total === 3 && r.data.sent_count === 2 && r.data.failed_count === 1, 'total=3 / sent=2 / failed=1', JSON.stringify({ t: r.data.total, s: r.data.sent_count, f: r.data.failed_count }));
    ok(r.data.sent.map((s) => s.to).join(',') === 'a@x.com,c@z.com', 'sent 只含成功者', JSON.stringify(r.data.sent.map((s) => s.to)));
    ok(r.data.failed.length === 1 && r.data.failed[0].to === 'b@y.com', 'failed 只含失败者', JSON.stringify(r.data.failed));
    ok(/Resend 返回错误/.test(r.data.failed[0].error) && /invalid recipient/.test(r.data.failed[0].error), 'failed[].error 含 Resend 原始原因', r.data.failed[0].error);
    ok(c.db.messageInserts().length === 2, '只有成功者落库（2 条）', `inserts=${c.db.messageInserts().length}`);
    const storedTo = c.db.messageInserts().map((e) => JSON.parse(e.args[9])[0]);
    ok(!storedTo.includes('b@y.com'), '失败者没有落库', JSON.stringify(storedTo));
    ok(c.resend.calls.every((x) => x.body.to.length === 1), '每次调用 to 长度仍为 1');
  }

  /* ---- B3 merge 全失败 ---- */
  section('B3 merge 全失败：HTTP 200 / ok=false / sent_count=0 / 无落库');
  {
    const c = mkCtx(() => ({ status: 401, payload: { message: 'API key is invalid' } }));
    const r = await c.post({ to: 'a@x.com, b@y.com', subject: 'S', body: 'B', merge: true });
    ok(c.resend.calls.length === 2, '两个收件人都尝试了', `calls=${c.resend.calls.length}`);
    ok(r.status === 200, 'HTTP 200', `status=${r.status}`);
    ok(r.data.ok === false, 'ok === false');
    ok(r.data.total === 2 && r.data.sent_count === 0 && r.data.failed_count === 2, 'total=2 / sent=0 / failed=2', JSON.stringify(r.data));
    ok(r.data.sent.length === 0, 'sent 为空');
    ok(r.data.failed.every((f) => /API key is invalid/.test(f.error)), 'failed[].error 带 Resend 原因');
    ok(c.db.messageInserts().length === 0, '全部失败：无 outbound 落库');
  }

  /* ---- B4 merge 中 resendSend 抛异常（网络错误） ---- */
  section('B4 merge 中 fetch 抛异常：捕获为 failed、不中断');
  {
    const c = mkCtx((body) => (body.to[0] === 'a@x.com' ? { throw: 'ECONNRESET' } : { status: 200, payload: { id: 'ok' } }));
    const r = await c.post({ to: 'a@x.com, b@y.com', subject: 'S', body: 'B', merge: true });
    ok(c.resend.calls.length === 2, '异常后仍继续下一位', `calls=${c.resend.calls.length}`);
    ok(r.status === 200 && r.data.ok === false, 'HTTP 200 / ok=false', `${r.status}/${r.data.ok}`);
    ok(r.data.failed.length === 1 && r.data.failed[0].to === 'a@x.com', '抛异常者进入 failed', JSON.stringify(r.data.failed));
    ok(/网络错误|发送失败/.test(r.data.failed[0].error), 'error 说明为网络错误', r.data.failed[0].error);
    ok(r.data.sent.length === 1 && r.data.sent[0].to === 'b@y.com', '另一位仍成功', JSON.stringify(r.data.sent));
  }

  /* ---- B5 非 merge：行为完全不变 ---- */
  section('B5 非 merge：1 次调用 / to 含全部 / 响应无 merge 字段');
  {
    const c = mkCtx();
    const r = await c.post({ to: 'a@x.com, b@y.com', subject: 'S', body: 'B' });
    ok(c.resend.calls.length === 1, '只调用 1 次 Resend', `calls=${c.resend.calls.length}`);
    ok(c.resend.calls[0].body.to.length === 2, '一封邮件的 to 含全部收件人', JSON.stringify(c.resend.calls[0].body.to));
    ok(r.status === 200, 'HTTP 200', `status=${r.status}`);
    ok(r.data.ok === true, 'ok === true');
    ok(typeof r.data.id === 'string' && r.data.id.length > 0, '响应含 id');
    ok(typeof r.data.resend_id === 'string' && r.data.resend_id.length > 0, '响应含 resend_id');
    ok(!Object.prototype.hasOwnProperty.call(r.data, 'merge'), '响应**不含** merge 字段');
    ok(!Object.prototype.hasOwnProperty.call(r.data, 'sent') && !Object.prototype.hasOwnProperty.call(r.data, 'failed'), '响应不含 sent/failed 字段');
    ok(c.db.messageInserts().length === 1, '落库 1 条', `inserts=${c.db.messageInserts().length}`);
  }

  /* ---- B6 merge 严格 === true ---- */
  section('B6 merge 严格 === true：false/"true"/1/null 都走非 merge');
  {
    for (const val of [false, 'true', 1, 'yes', null, undefined]) {
      const c = mkCtx();
      const body = { to: 'a@x.com, b@y.com', subject: 'S', body: 'B' };
      if (val !== undefined) body.merge = val;
      const r = await c.post(body);
      ok(
        c.resend.calls.length === 1 && !Object.prototype.hasOwnProperty.call(r.data, 'merge'),
        `merge=${JSON.stringify(val)} -> 非 merge（1 次调用、响应无 merge）`,
        `calls=${c.resend.calls.length}, keys=${Object.keys(r.data).join(',')}`
      );
    }
  }

  /* ---- B7 收件人切分 / trim / 去空 / 大小写去重 ---- */
  section('B7 收件人切分与去重（含全角分隔符 / 大小写 / 空白）');
  {
    const c = mkCtx();
    const r = await c.post({ to: '  A@X.com ; a@x.com ，  b@y.com\tb@Y.com \n c@z.com  ', subject: 'S', body: 'B', merge: true });
    const tos = c.resend.calls.map((x) => x.body.to[0]);
    ok(tos.length === 3, '去重后 3 人', JSON.stringify(tos));
    ok(tos.join(',') === 'A@X.com,b@y.com,c@z.com', '保留首次出现的原始写法、按小写去重', JSON.stringify(tos));
    ok(r.data.total === 3, 'total=3', `total=${r.data.total}`);
    ok(tos.every((t) => t === t.trim() && t !== ''), '每段已 trim 且无空串');
  }

  /* ---- B8 去重后判上限：100 个相同地址不触发 20 人上限 ---- */
  section('B8 去重后判上限：a@x.com ×100 -> 1 人 -> 不触发上限');
  {
    const c = mkCtx();
    const r = await c.post({ to: Array(100).fill('a@x.com').join(', '), subject: 'S', body: 'B', merge: true });
    ok(c.resend.calls.length === 1, '去重后只发 1 封', `calls=${c.resend.calls.length}`);
    ok(r.status === 200, 'HTTP 200（不触发上限）', `status=${r.status}`);
    ok(r.data.total === 1 && r.data.sent_count === 1, 'total=1 / sent=1', JSON.stringify({ t: r.data.total, s: r.data.sent_count }));
  }

  /* ---- B9 无附件上限边界：cap=22（默认 budget 45 / cost 2） ---- */
  section('B9 无附件上限边界：去重后 23 人 -> 400；正好 22 人 -> 200（22 次 fetch）');
  {
    const over = Array.from({ length: 23 }, (_, i) => `u${i}@x.com`).join(', ');
    const c1 = mkCtx();
    const r1 = await c1.post({ to: over, subject: 'S', body: 'B', merge: true });
    ok(r1.status === 400, '23 人 -> HTTP 400', `status=${r1.status}`);
    ok(r1.data.error === '单次合并发送最多 22 位收件人', '错误文案逐字正确', r1.data.error);
    ok(c1.resend.calls.length === 0, '超限时**一次都没有**调用 Resend', `calls=${c1.resend.calls.length}`);
    ok(c1.db.messageInserts().length === 0, '超限时无落库');

    const exactly = Array.from({ length: 22 }, (_, i) => `u${i}@x.com`).join(', ');
    const c2 = mkCtx();
    const r2 = await c2.post({ to: exactly, subject: 'S', body: 'B', merge: true });
    ok(r2.status === 200, '正好 22 人 -> HTTP 200', `status=${r2.status}`);
    ok(c2.resend.calls.length === 22, '恰好 22 次 fetch', `calls=${c2.resend.calls.length}`);
    ok(r2.data.total === 22 && r2.data.sent_count === 22 && r2.data.ok === true, 'total/sent=22、ok=true', JSON.stringify({ t: r2.data.total, s: r2.data.sent_count, ok: r2.data.ok }));
  }

  /* ---- B10 0 人 ---- */
  section('B10 0 个收件人 -> 400 缺少收件人');
  {
    const cases = [
      { to: '', merge: true, label: '空串' },
      { to: '   ,  ; ，  ', merge: true, label: '只有分隔符/空白' },
      { to: [], merge: true, label: '空数组' },
    ];
    for (const cs of cases) {
      const c = mkCtx();
      const r = await c.post({ to: cs.to, subject: 'S', body: 'B', merge: cs.merge });
      ok(r.status === 400, `${cs.label} -> HTTP 400`, `status=${r.status}`);
      ok(r.data.error === '缺少收件人', `${cs.label} -> error=缺少收件人`, r.data.error);
      ok(c.resend.calls.length === 0, `${cs.label} -> 不调用 Resend`);
    }
    // 非 merge 的 0 人也应 400（既有行为）
    const c = mkCtx();
    const r = await c.post({ to: '', subject: 'S', body: 'B' });
    ok(r.status === 400 && r.data.error === '缺少收件人', '非 merge 0 人同样 400', `${r.status}/${r.data.error}`);
  }

  /* ---- B11 附件：每封都带同一份完整附件 ---- */
  section('B11 附件：merge 时每封都带同一份完整附件');
  {
    const att = [{ filename: 'note.txt', content: 'aGVsbG8=', content_type: 'text/plain' }];
    const c = mkCtx();
    const r = await c.post({ to: 'a@x.com, b@y.com', subject: 'S', body: 'B', merge: true, attachments: att });
    ok(c.resend.calls.length === 2, '2 次调用', `calls=${c.resend.calls.length}`);
    ok(c.resend.calls.every((x) => JSON.stringify(x.body.attachments) === JSON.stringify(att)), '每封都带同一份完整附件', JSON.stringify(c.resend.calls.map((x) => x.body.attachments)));
    ok(r.status === 200 && r.data.ok === true, '成功');
    ok(c.bucket.puts.length === 2, '每个成功者各存一份附件到 R2（各 1 次）', `puts=${c.bucket.puts.length}`);
    ok(c.db.attachmentInserts().length === 2, '附件表各记 1 行', `rows=${c.db.attachmentInserts().length}`);
  }

  /* ---- B12 cc 透传 ---- */
  section('B12 cc：切分后透传到每一封');
  {
    const c = mkCtx();
    const r = await c.post({ to: 'a@x.com, b@y.com', cc: 'CC1@x.com, cc2@y.com', subject: 'S', body: 'B', merge: true });
    ok(c.resend.calls.every((x) => Array.isArray(x.body.cc) && x.body.cc.length === 2), '每封都带 2 个 cc', JSON.stringify(c.resend.calls.map((x) => x.body.cc)));
    ok(c.resend.calls[0].body.cc.join(',') === 'CC1@x.com,cc2@y.com', 'cc 保留原始写法且去重', JSON.stringify(c.resend.calls[0].body.cc));
    ok(r.status === 200, 'HTTP 200', `status=${r.status}`);
  }

  /* ---- B13 数组入参的 to：merge 仍去重；非 merge 记录既有行为 ---- */
  section('B13 数组入参：merge 去重；非 merge 保持既有行为（不额外去重）');
  {
    const c1 = mkCtx();
    const r1 = await c1.post({ to: ['A@X.com', 'a@x.com', 'b@y.com'], subject: 'S', body: 'B', merge: true });
    ok(c1.resend.calls.length === 2, 'merge + 数组：按小写去重后 2 人', `calls=${c1.resend.calls.length}`);
    ok(r1.data.total === 2, 'total=2', `total=${r1.data.total}`);

    const c2 = mkCtx();
    const r2 = await c2.post({ to: ['a@x.com', 'a@x.com'], subject: 'S', body: 'B' });
    ok(c2.resend.calls.length === 1, '非 merge + 数组：仍 1 次调用');
    const toLen = c2.resend.calls[0].body.to.length;
    info(`非 merge + 数组重复地址：body.to 长度 = ${toLen}（既有行为，parseRecipient 的数组分支不做去重）`);
    ok(toLen === 2, '非 merge + 数组：重复项原样透传（= 改造前行为，未变）', JSON.stringify(c2.resend.calls[0].body.to));
    ok(r2.status === 200, 'HTTP 200');
  }

  /* ---- B14 merge 响应字段集合 ---- */
  section('B14 merge 响应字段集合与类型');
  {
    const c = mkCtx();
    const r = await c.post({ to: 'a@x.com', subject: 'S', body: 'B', merge: true });
    const keys = Object.keys(r.data).sort();
    const expected = ['failed', 'failed_count', 'merge', 'ok', 'sent', 'sent_count', 'total'];
    ok(JSON.stringify(keys) === JSON.stringify(expected), '响应键集合与规格一致', JSON.stringify(keys));
    ok(r.data.merge === true && typeof r.data.total === 'number' && typeof r.data.sent_count === 'number' && typeof r.data.failed_count === 'number', '类型正确');
    ok(Array.isArray(r.data.sent) && Array.isArray(r.data.failed), 'sent/failed 均为数组');
    info('注：单个收件人 + merge 也走 merge 分支（total=1），这是规格允许的（0 人才是 400）。');
  }

  /* ---- B15 非 merge 失败仍为 400（既有行为） ---- */
  section('B15 非 merge 失败：HTTP 400 且 error 含 Resend 原因（既有行为）');
  {
    const c = mkCtx(() => ({ status: 422, payload: { message: 'domain not verified' } }));
    const r = await c.post({ to: 'a@x.com', subject: 'S', body: 'B' });
    ok(r.status === 400, 'HTTP 400', `status=${r.status}`);
    ok(/domain not verified/.test(r.data.error), 'error 含 Resend 原因', r.data.error);
    ok(!Object.prototype.hasOwnProperty.call(r.data, 'merge'), '错误响应也不含 merge 字段');
  }

  /* ---- B16 未配置 RESEND_API_KEY ---- */
  section('B16 未配置 RESEND_API_KEY：merge 全失败（ok=false、HTTP 200）');
  {
    const c = mkCtx(undefined, { RESEND_API_KEY: '' });
    const r = await c.post({ to: 'a@x.com, b@y.com', subject: 'S', body: 'B', merge: true });
    ok(r.status === 200, 'HTTP 200', `status=${r.status}`);
    ok(r.data.ok === false && r.data.failed_count === 2, 'ok=false / failed=2', JSON.stringify({ ok: r.data.ok, f: r.data.failed_count }));
    ok(r.data.failed.every((f) => /未配置 RESEND_API_KEY/.test(f.error)), 'error 说明未配置 key', JSON.stringify(r.data.failed.map((f) => f.error)));
    ok(c.resend.calls.length === 0, '未配置 key 时不发出网络请求');
  }

  /* ---- B17 正文/主题不变 ---- */
  section('B17 每封的主题与正文完全一致');
  {
    const c = mkCtx();
    await c.post({ to: 'a@x.com, b@y.com', subject: ' Subject X ', body: 'line1\nline2', merge: true });
    ok(c.resend.calls.every((x) => x.body.subject === 'Subject X'), '主题一致且已 trim', JSON.stringify(c.resend.calls.map((x) => x.body.subject)));
    ok(c.resend.calls.every((x) => x.body.text === 'line1\nline2'), '纯文本正文一致');
    ok(c.resend.calls.every((x) => typeof x.body.html === 'string' && x.body.html.includes('line1')), 'HTML 正文一致');
    const froms = c.resend.calls.map((x) => x.body.from);
    ok(new Set(froms).size === 1 && /support@notionmanager\.com/.test(froms[0]), '每封发件人一致', JSON.stringify(froms));
  }

  /* ---- B18 SQL 占位符与绑定参数数量一致（真实 D1 会拒绝不一致） ---- */
  section('B18 落库 SQL：? 占位符数量 === bind 参数数量');
  {
    const c = mkCtx();
    await c.post({ to: 'a@x.com, b@y.com', subject: 'S', body: 'B', merge: true, attachments: [{ filename: 'f.txt', content: 'aGk=', content_type: 'text/plain' }] });
    const msgs = c.db.messageInserts();
    ok(msgs.length === 2, '有 2 条 messages 插入语句');
    for (const [i, st] of msgs.entries()) {
      const holes = (st.sql.match(/\?/g) || []).length;
      ok(holes === st.args.length, `messages INSERT #${i + 1}：占位符 ${holes} === 绑定 ${st.args.length}`, `${holes} vs ${st.args.length}`);
      ok(st.args.every((a) => a === null || ['string', 'number', 'boolean'].includes(typeof a)), `messages INSERT #${i + 1}：绑定值均为标量（D1 不接受 undefined）`);
    }
    const atts = c.db.attachmentInserts();
    ok(atts.length === 2, '有 2 条 attachments 插入语句');
    for (const [i, st] of atts.entries()) {
      const holes = (st.sql.match(/\?/g) || []).length;
      ok(holes === st.args.length, `attachments INSERT #${i + 1}：占位符 ${holes} === 绑定 ${st.args.length}`, `${holes} vs ${st.args.length}`);
    }
    info('注：真实 D1 的写入路径在假 key 下无法触发（Resend 全失败），故本层用桩 D1 覆盖；占位符/参数一致性可部分弥补该缺口。');
  }

  /* ---- B19 附件感知上限：cap 随附件数下降（1 附件 -> 11，3 附件 -> 7） ---- */
  section('B19 附件感知上限：1 附件 cap=11、3 附件 cap=7（含 400 零 fetch / 无落库）');
  {
    // 手算：cost(1)=2+1+1=4 -> floor(45/4)=11；cost(3)=2+3+1=6 -> floor(45/6)=7
    const att1 = [{ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' }];
    const att3 = [
      { filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' },
      { filename: 'b.txt', content: 'aGk=', content_type: 'text/plain' },
      { filename: 'c.txt', content: 'aGk=', content_type: 'text/plain' },
    ];

    const over1 = Array.from({ length: 12 }, (_, i) => `u${i}@x.com`).join(', ');
    const c1 = mkCtx();
    const r1 = await c1.post({ to: over1, subject: 'S', body: 'B', merge: true, attachments: att1 });
    ok(r1.status === 400, '1 附件 / 12 人 -> HTTP 400', `status=${r1.status}`);
    ok(r1.data.error === '单次合并发送最多 11 位收件人（当前 1 个附件）', '错误文案含「（当前 1 个附件）」', r1.data.error);
    ok(c1.resend.calls.length === 0, '1 附件超限 -> 0 次 fetch', `calls=${c1.resend.calls.length}`);
    ok(c1.db.messageInserts().length === 0 && c1.db.attachmentInserts().length === 0, '1 附件超限 -> messages/attachments 均无落库', `m=${c1.db.messageInserts().length}, a=${c1.db.attachmentInserts().length}`);

    const exactly1 = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`).join(', ');
    const c2 = mkCtx();
    const r2 = await c2.post({ to: exactly1, subject: 'S', body: 'B', merge: true, attachments: att1 });
    ok(r2.status === 200, '1 附件 / 11 人 -> HTTP 200', `status=${r2.status}`);
    ok(c2.resend.calls.length === 11, '1 附件 / 11 人 -> 恰好 11 次 fetch', `calls=${c2.resend.calls.length}`);
    ok(r2.data.total === 11 && r2.data.sent_count === 11 && r2.data.ok === true, '1 附件：total/sent=11、ok=true', JSON.stringify({ t: r2.data.total, s: r2.data.sent_count, ok: r2.data.ok }));

    const over3 = Array.from({ length: 8 }, (_, i) => `u${i}@x.com`).join(', ');
    const c3 = mkCtx();
    const r3 = await c3.post({ to: over3, subject: 'S', body: 'B', merge: true, attachments: att3 });
    ok(r3.status === 400, '3 附件 / 8 人 -> HTTP 400', `status=${r3.status}`);
    ok(r3.data.error === '单次合并发送最多 7 位收件人（当前 3 个附件）', '错误文案含「（当前 3 个附件）」', r3.data.error);
    ok(c3.resend.calls.length === 0, '3 附件超限 -> 0 次 fetch', `calls=${c3.resend.calls.length}`);
    ok(c3.db.messageInserts().length === 0 && c3.db.attachmentInserts().length === 0, '3 附件超限 -> messages/attachments 均无落库', `m=${c3.db.messageInserts().length}, a=${c3.db.attachmentInserts().length}`);

    const exactly3 = Array.from({ length: 7 }, (_, i) => `u${i}@x.com`).join(', ');
    const c4 = mkCtx();
    const r4 = await c4.post({ to: exactly3, subject: 'S', body: 'B', merge: true, attachments: att3 });
    ok(r4.status === 200, '3 附件 / 7 人 -> HTTP 200', `status=${r4.status}`);
    ok(c4.resend.calls.length === 7, '3 附件 / 7 人 -> 恰好 7 次 fetch', `calls=${c4.resend.calls.length}`);
    ok(r4.data.total === 7 && r4.data.sent_count === 7 && r4.data.ok === true, '3 附件：total/sent=7、ok=true', JSON.stringify({ t: r4.data.total, s: r4.data.sent_count, ok: r4.data.ok }));
  }

  /* ---- B20 MERGE_SUBREQ_BUDGET 覆盖：1000 -> 绝对上限 200；0 -> 下限 1；未设置 -> 22 ---- */
  section('B20 MERGE_SUBREQ_BUDGET 覆盖：1000 -> cap=200；0 -> cap=1；未设置 -> cap=22');
  {
    // 手算：budget=1000, cost=2 -> floor(1000/2)=500 -> min(200,500)=200
    const over200 = Array.from({ length: 201 }, (_, i) => `u${i}@x.com`).join(', ');
    const c1 = mkCtx(undefined, { MERGE_SUBREQ_BUDGET: '1000' });
    const r1 = await c1.post({ to: over200, subject: 'S', body: 'B', merge: true });
    ok(r1.status === 400, 'budget=1000 / 201 人 -> HTTP 400（绝对上限 200 生效）', `status=${r1.status}`);
    ok(r1.data.error === '单次合并发送最多 200 位收件人', '错误文案为 200', r1.data.error);
    ok(c1.resend.calls.length === 0, 'budget=1000 超限 -> 0 次 fetch', `calls=${c1.resend.calls.length}`);

    const exactly200 = Array.from({ length: 200 }, (_, i) => `u${i}@x.com`).join(', ');
    const c2 = mkCtx(undefined, { MERGE_SUBREQ_BUDGET: '1000' });
    const r2 = await c2.post({ to: exactly200, subject: 'S', body: 'B', merge: true });
    ok(r2.status === 200, 'budget=1000 / 200 人 -> HTTP 200', `status=${r2.status}`);
    ok(c2.resend.calls.length === 200, 'budget=1000 / 200 人 -> 恰好 200 次 fetch', `calls=${c2.resend.calls.length}`);

    // 手算：budget=0, cost=2 -> floor(0/2)=0 -> max(1, min(200,0)) = 1
    const c3 = mkCtx(undefined, { MERGE_SUBREQ_BUDGET: '0' });
    const r3 = await c3.post({ to: 'a@x.com, b@y.com', subject: 'S', body: 'B', merge: true });
    ok(r3.status === 400, 'budget=0 / 2 人 -> HTTP 400（不会算出 0 或负数）', `status=${r3.status}`);
    ok(r3.data.error === '单次合并发送最多 1 位收件人', 'budget=0 -> cap 下限为 1', r3.data.error);
    ok(c3.resend.calls.length === 0, 'budget=0 超限 -> 0 次 fetch', `calls=${c3.resend.calls.length}`);

    const c4 = mkCtx(undefined, { MERGE_SUBREQ_BUDGET: '0' });
    const r4 = await c4.post({ to: 'a@x.com', subject: 'S', body: 'B', merge: true });
    ok(r4.status === 200 && c4.resend.calls.length === 1, 'budget=0 / 1 人 -> HTTP 200 且 1 次 fetch', `${r4.status}/${c4.resend.calls.length}`);

    // 未设置 -> 默认 45 -> cap=22
    const c5 = mkCtx();
    const r5 = await c5.post({ to: 'a@x.com', subject: 'S', body: 'B', merge: true });
    ok(r5.status === 200, '未设置 budget / 1 人 -> HTTP 200', `status=${r5.status}`);
    const c6 = mkCtx();
    const r6 = await c6.post({ to: Array.from({ length: 23 }, (_, i) => `u${i}@x.com`).join(', '), subject: 'S', body: 'B', merge: true });
    ok(r6.status === 400 && r6.data.error === '单次合并发送最多 22 位收件人', '未设置 budget -> 默认 45 -> cap=22', `${r6.status}/${r6.data.error}`);
  }

  /* ---- B21 非法 budget 值：安全回落到默认 45 -> cap=22 ---- */
  section('B21 非法 MERGE_SUBREQ_BUDGET（"abc"/""/"-5"）-> 安全回落默认 45 -> cap=22');
  {
    for (const bad of ['abc', '', '-5']) {
      const cOver = mkCtx(undefined, { MERGE_SUBREQ_BUDGET: bad });
      const rOver = await cOver.post({ to: Array.from({ length: 23 }, (_, i) => `u${i}@x.com`).join(', '), subject: 'S', body: 'B', merge: true });
      ok(rOver.status === 400 && rOver.data.error === '单次合并发送最多 22 位收件人', `budget=${JSON.stringify(bad)} / 23 人 -> 400 且文案=22`, `${rOver.status}/${rOver.data.error}`);
      ok(cOver.resend.calls.length === 0, `budget=${JSON.stringify(bad)} 超限 -> 0 次 fetch`, `calls=${cOver.resend.calls.length}`);

      const cOk = mkCtx(undefined, { MERGE_SUBREQ_BUDGET: bad });
      const rOk = await cOk.post({ to: Array.from({ length: 22 }, (_, i) => `u${i}@x.com`).join(', '), subject: 'S', body: 'B', merge: true });
      ok(rOk.status === 200 && cOk.resend.calls.length === 22, `budget=${JSON.stringify(bad)} / 22 人 -> 200 且 22 次 fetch`, `${rOk.status}/${cOk.resend.calls.length}`);
    }
  }

  /* ---- B22 去重先于判上限（30 个相同地址 + 0 附件） ---- */
  section('B22 去重先于判上限：30 个相同地址 + 0 附件 -> 去重后 1 人 -> 200');
  {
    const c = mkCtx();
    const r = await c.post({ to: Array(30).fill('dup@x.com').join(', '), subject: 'S', body: 'B', merge: true });
    ok(r.status === 200, '30 个相同地址 -> HTTP 200（未误判超限）', `status=${r.status}`);
    ok(c.resend.calls.length === 1, '去重后只发 1 封', `calls=${c.resend.calls.length}`);
    ok(r.data.total === 1 && r.data.sent_count === 1, 'total=1 / sent=1', JSON.stringify({ t: r.data.total, s: r.data.sent_count }));
  }

  /* ---- B23 附加反例：不整除的 cost、cost>budget、clamp 上界、小数 budget ---- */
  section('B23 附加反例：2 附件 cap=9；50 附件 cost>budget -> cap=1；budget 上界/小数');
  {
    const mkAtt = (n) => Array.from({ length: n }, (_, i) => ({ filename: `f${i}.txt`, content: 'aGk=', content_type: 'text/plain' }));

    // 手算：cost(2)=2+2+1=5 -> floor(45/5)=9
    const c1 = mkCtx();
    const r1 = await c1.post({ to: Array.from({ length: 10 }, (_, i) => `u${i}@x.com`).join(', '), subject: 'S', body: 'B', merge: true, attachments: mkAtt(2) });
    ok(r1.status === 400 && r1.data.error === '单次合并发送最多 9 位收件人（当前 2 个附件）', '2 附件 / 10 人 -> 400 且 cap=9', `${r1.status}/${r1.data.error}`);
    ok(c1.resend.calls.length === 0, '2 附件超限 -> 0 次 fetch', `calls=${c1.resend.calls.length}`);
    const c2 = mkCtx();
    const r2 = await c2.post({ to: Array.from({ length: 9 }, (_, i) => `u${i}@x.com`).join(', '), subject: 'S', body: 'B', merge: true, attachments: mkAtt(2) });
    ok(r2.status === 200 && c2.resend.calls.length === 9, '2 附件 / 9 人 -> 200 且 9 次 fetch', `${r2.status}/${c2.resend.calls.length}`);

    // 手算：cost(50)=2+50+1=53 > 45 -> floor(45/53)=0 -> max(1,0)=1
    const c3 = mkCtx();
    const r3 = await c3.post({ to: 'a@x.com, b@y.com', subject: 'S', body: 'B', merge: true, attachments: mkAtt(50) });
    ok(r3.status === 400 && r3.data.error === '单次合并发送最多 1 位收件人（当前 50 个附件）', '50 附件 / 2 人 -> 400 且 cap 下限为 1', `${r3.status}/${r3.data.error}`);
    ok(c3.resend.calls.length === 0, '50 附件超限 -> 0 次 fetch', `calls=${c3.resend.calls.length}`);
    const c4 = mkCtx();
    const r4 = await c4.post({ to: 'a@x.com', subject: 'S', body: 'B', merge: true, attachments: mkAtt(50) });
    ok(r4.status === 200 && c4.resend.calls.length === 1, '50 附件 / 1 人 -> 200 且 1 次 fetch', `${r4.status}/${c4.resend.calls.length}`);

    // 手算：budget 上界 clamp 到 10000 -> floor(10000/2)=5000 -> min(200,5000)=200
    const c5 = mkCtx(undefined, { MERGE_SUBREQ_BUDGET: '99999' });
    const r5 = await c5.post({ to: Array.from({ length: 201 }, (_, i) => `u${i}@x.com`).join(', '), subject: 'S', body: 'B', merge: true });
    ok(r5.status === 400 && r5.data.error === '单次合并发送最多 200 位收件人', 'budget=99999 -> clamp 10000 -> cap 仍 200', `${r5.status}/${r5.data.error}`);

    // 手算：budget="90.7" -> floor 90 -> floor(90/2)=45
    const c6 = mkCtx(undefined, { MERGE_SUBREQ_BUDGET: '90.7' });
    const r6 = await c6.post({ to: Array.from({ length: 46 }, (_, i) => `u${i}@x.com`).join(', '), subject: 'S', body: 'B', merge: true });
    ok(r6.status === 400 && r6.data.error === '单次合并发送最多 45 位收件人', 'budget="90.7" -> floor 90 -> cap=45', `${r6.status}/${r6.data.error}`);
    const c7 = mkCtx(undefined, { MERGE_SUBREQ_BUDGET: '90.7' });
    const r7 = await c7.post({ to: Array.from({ length: 45 }, (_, i) => `u${i}@x.com`).join(', '), subject: 'S', body: 'B', merge: true });
    ok(r7.status === 200 && c7.resend.calls.length === 45, 'budget="90.7" / 45 人 -> 200 且 45 次 fetch', `${r7.status}/${c7.resend.calls.length}`);
  }

  /* ---- B20 ⭐ 回信的发件人：body.mailbox 必须生效 ---- */
  {
    section('B20 ⭐ 回信发件人：body.mailbox 必须生效（曾忽略它 -> 改选发件人无效）');
    const ORIG = {
      id: 'orig-1', direction: 'inbound', mailbox: 'inbox@notionmanager.com',
      from_email: 'alice@partner.com', from_name: 'Alice',
      to_emails: '["inbox@notionmanager.com"]', cc: null, bcc: null, reply_to: null,
      subject: '报价', body_text: 'hi', body_html: null,
      message_id: '<orig-1@partner.com>', references: null, thread_id: 't-1',
      received_at: 1788000000, read: 1, deleted: 0, starred: 0, status: 'received',
      resend_id: 're_in_1',
    };
    // 只让「按 id 取原邮件」这一次 first() 命中，其余查询保持 null（与默认桩一致）
    const ctxOf = (extra) => mkCtx(undefined, extra, {
      first: (sql, args) =>
        /SELECT \* FROM messages WHERE id = \?/i.test(sql) && args[0] === 'orig-1' ? ORIG : null,
    });
    const fromOf = (c) => (c.resend.calls[0] ? c.resend.calls[0].body.from : undefined);

    // ① 缺省：沿用「收到原邮件的那个信箱」
    const c1 = ctxOf();
    const r1 = await c1.reply('orig-1', { body: '回复内容' });
    ok(r1.status === 200 && r1.data && r1.data.original_id === 'orig-1',
      '负控制：回信路由确实被驱动（否则下面的发件人断言可能是空转）',
      `${r1.status}/${JSON.stringify(r1.data)}`);
    ok(c1.resend.calls.length === 1, '恰好 1 次 Resend 调用', c1.resend.calls.length);
    ok(fromOf(c1) === 'support <inbox@notionmanager.com>',
      '未指定 mailbox -> 沿用原邮件的收件信箱', fromOf(c1));

    // ② ⭐ 指定 mailbox：必须用它（这就是用户报的 bug）
    const c2 = ctxOf();
    const r2 = await c2.reply('orig-1', { body: '回复内容', mailbox: 'billing@notionmanager.com' });
    ok(r2.status === 200, '指定 mailbox 时回信成功', `${r2.status}/${JSON.stringify(r2.data)}`);
    ok(c2.resend.calls.length === 1, '恰好 1 次 Resend 调用', c2.resend.calls.length);
    ok(fromOf(c2) === 'support <billing@notionmanager.com>',
      '⭐ body.mailbox 生效：发件人 = 用户改选的信箱（不再是原邮件的收件信箱）', fromOf(c2));

    // ③ 落库的 from_email / mailbox 与真正发出的发件人一致（否则发件箱会显示错的发件人）
    const ins = c2.db._executed.filter((e) => /INSERT INTO messages/i.test(e.sql));
    ok(ins.length === 1, '出站记录已落库', ins.length);
    const flat = ins.length ? ins[0].args.map((a) => String(a)).join('|') : '';
    ok(flat.includes('billing@notionmanager.com'),
      '落库的 mailbox / from_email 用的是改选后的地址', flat.slice(0, 160));
    ok(!flat.includes('inbox@notionmanager.com'),
      '落库记录里不得再残留原邮件的收件信箱', flat.slice(0, 160));

    // ④ 域名兜底仍然生效：非默认域不会冒充外部域名发信
    const c3 = ctxOf();
    const r3 = await c3.reply('orig-1', { body: '回复内容', mailbox: 'evil@other-domain.com' });
    ok(r3.status === 200, '异域地址不报错（走回退而非 4xx）', `${r3.status}/${JSON.stringify(r3.data)}`);
    ok(fromOf(c3) === 'support <support@notionmanager.com>',
      '非默认域回退到默认发件人（senderFromMailbox 的既有保护，未被本次改动绕过）', fromOf(c3));

    // ⑤ 空白 mailbox 视同未指定，不得把发件人变成空
    const c4 = ctxOf();
    await c4.reply('orig-1', { body: '回复内容', mailbox: '   ' });
    ok(fromOf(c4) === 'support <inbox@notionmanager.com>',
      'mailbox 只有空白 -> 视同未指定，回退原邮件收件信箱', fromOf(c4));
  }

  /* ---- 汇总 ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: src/index.ts md5=${FINGERPRINT['src/index.ts']}`);
  console.log(`编译产物（仓库外，退出时删除）: ${BUILD_DIR}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);

  try { fs.rmSync(BUILD_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
})();
