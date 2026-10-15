'use strict';

/* =============================================================================
 * 会话（thread）归组回归验证 —— 真实 SQLite 当 D1 + 真实 src/ 编译产物 + 真实 Worker 路由
 *
 * 运行（本沙箱需 tsc 垫片，见文件末尾说明）：
 *   NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js" node test/thread-grouping.backend.test.js
 * 正常环境：
 *   node test/thread-grouping.backend.test.js
 *
 * 退出码：0 = 全部通过；1 = 存在失败；2 = 环境缺失（node:sqlite 不可用 / tsc 不可用）。
 *
 * ---------------------------------------------------------------------------
 * 覆盖的线上缺陷（用户报障：「来回好几次了，会话面板里只有两封」）
 *
 * 根因（2026-10-15 用生产 D1 的 132 行真实数据实证）：
 *   Resend 收信接口返回的 `headers.references` **不是** RFC 5322 的空格分隔列表，
 *   而是 **JSON 数组文本** —— `["<a@b>","<c@d>"]`。
 *   旧 `rootThreadId()` 用 `refs.split(/\s+/)[0]` 取「第一条」，拿到的是整个 JSON 文本；
 *   `stripAngle()` 只认首尾尖括号、去不掉方括号 → `thread_id` 落成
 *   `["<a@b>","<c@d>"]` 这种畸形值。
 *   更糟的是 `reply()` 把这串 JSON 文本原样拼进新 References 发回 Resend，
 *   对方再回信时转义层级又深一层（实测已出现 `["<\",\"<\\\",\\\"<\\\\\\\"...` 四层嵌套），
 *   于是**同一物理线程每往返一轮就换一个 thread_id**。
 *
 * 为什么用「真实 Worker 路由 + 真实 SQLite」而不是单元断言：
 *   这个缺陷的形态是「入库的值不对」，只在参数层面断言（第 N 个绑定参数是什么）
 *   会把测试锁死在列顺序上。这里让真实的 handleInbound / reply 跑完，
 *   再把 `thread_id` SELECT 回来比对，断言的是**最终数据**。
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
// QA_UTIL_TS / QA_INDEX_TS 仅用于「变异验证」：指向人工构造的缺陷版源码（放仓库外），
// 确认本测试确实能抓到缺陷。缺了钩子，变异脚本会「跑仓库原文件却以为跑的是变体」→ 假绿。
const UTIL_TS = process.env.QA_UTIL_TS || path.join(ROOT, 'src', 'util.ts');
const INDEX_TS = process.env.QA_INDEX_TS || path.join(ROOT, 'src', 'index.ts');
const WORK_DIR = path.join(os.tmpdir(), `thread-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-for-thread-grouping').toString('base64');
const MAILBOX = 'support@notionmanager.com';
const PEER = 'peer@upvote.network';

/* ---------------------------------------------------------------------------
 * 1) 把整份 src/ 复制到仓库外（变体覆盖 util.ts / index.ts）后编译
 *
 * 为什么要复制 src/：QA_UTIL_TS / QA_INDEX_TS 的变体在仓库外，而 tsc 需要一份完整的
 * src/ 才能编译。复制一份再覆盖同名文件，就能在**完全不改动仓库**的前提下编译任意变体。
 *
 * ⚠️ 两个必须的配套（少了任何一个都会编译失败，且报错看起来与变体无关）：
 *   a) 临时目录在 os.tmpdir() 下，类型解析与产物的裸模块解析都要靠 node_modules ——
 *      必须在**编译之前**把 WORK_DIR/node_modules 链接到仓库 node_modules，
 *      否则报 TS2688 Cannot find type definition file for '@cloudflare/workers-types'；
 *   b) module 改成 commonjs 后**不要**顺手改 moduleResolution：本机 tsc 是
 *      TypeScript 7，`node10` 已被移除（TS5108），仓库的 'bundler' 与 commonjs 的组合是被接受的。
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
  // 变体覆盖（同目录同名 → 直接替换掉复制过来的那份）
  fs.copyFileSync(UTIL_TS, path.join(SRC_COPY, 'util.ts'));
  fs.copyFileSync(INDEX_TS, path.join(SRC_COPY, 'index.ts'));

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
  if (!fs.existsSync(path.join(BUILD_DIR, 'index.js'))) {
    throw new Error(`编译产物缺失: ${path.join(BUILD_DIR, 'index.js')}`);
  }
  return BUILD_DIR;
}

/** 清理临时编译目录（先卸载 junction 再删，避免删到仓库依赖）。 */
function cleanup() {
  const link = path.join(WORK_DIR, 'node_modules');
  try {
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------------------
 * 2) 真实 SQLite 冒充 D1（schema.sql 的真实 DDL 建表）
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
 * 3) Svix 签名（与线上同口径：v1,base64(HMAC-SHA256(secret, id.ts.payload))）
 * -------------------------------------------------------------------------*/
function svixHeaders(id, ts, body) {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}

/* ---------------------------------------------------------------------------
 * 4) 迷你断言器
 * -------------------------------------------------------------------------*/
let pass = 0;
const results = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; results.push({ ok: true, msg }); console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { results.push({ ok: false, msg, detail }); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }
function info(t) { console.log(`  INFO  ${t}`); }

/** 旧实现（缺陷版）的根推导，仅用于「负控制组」——证明新实现不是空转。 */
function legacyRoot(references, inReplyTo, messageId) {
  const strip = (s) => {
    if (!s) return null;
    const t = String(s).trim();
    if (t.startsWith('<') && t.endsWith('>')) return t.slice(1, -1);
    return t || null;
  };
  const refs = (references || '').trim();
  if (refs) {
    const first = refs.split(/\s+/)[0];
    const root = strip(first);
    if (root) return root;
  }
  const inReply = strip(inReplyTo);
  if (inReply) return inReply;
  return strip(messageId) || '';
}

/** 干净的 References：只允许 `<id>` 以空格分隔；不得含方括号 / 引号 / 反斜杠（转义污染的特征）。 */
const REFS_OK = /^(?:<[^<>\s]+>\s*)+$/;

/* ===========================================================================
 * 用例
 * ===========================================================================*/
(async function main() {
  console.log('会话（thread）归组 —— 真实 SQLite + 真实编译产物 + 真实 Worker 路由');
  let entry;
  try {
    entry = build();
  } catch (e) {
    console.error(`\n编译失败，无法继续：${e.message}`);
    console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
    process.exit(2);
  }

  const util = require(path.join(entry, 'util.js'));
  const repo = require(path.join(entry, 'repo.js'));
  const worker = require(path.join(entry, 'index.js'));
  const db = makeD1();

  console.log(`被测版本: src/util.ts md5=${md5(UTIL_TS)}${process.env.QA_UTIL_TS ? '  ← QA_UTIL_TS 变异体' : ''}`);
  console.log(`          src/index.ts md5=${md5(INDEX_TS)}${process.env.QA_INDEX_TS ? '  ← QA_INDEX_TS 变异体' : ''}`);

  /* ---- T0 环境自检：证明 D1 桩与 Worker 入口是真在跑，不是空转 ---- */
  section('T0 环境自检');
  await db.prepare('INSERT INTO messages (id, direction, to_emails, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind('self-check', 'inbound', '["x@y.com"]', 1, 1, 1).run();
  const selfRow = await db.prepare('SELECT COUNT(*) AS n FROM messages').first();
  ok(Number(selfRow.n) === 1, 'D1 桩确实把数据写进了真实 SQLite（否则后面全是空转）', selfRow.n);
  await db.prepare('DELETE FROM messages WHERE id = ?').bind('self-check').run();
  ok(typeof worker.default.fetch === 'function', 'Worker 入口已加载（走真实路由 + 真实 reply()）');
  ok(typeof util.rootThreadId === 'function' && typeof util.isSaneThreadId === 'function',
    '被测函数 rootThreadId / isSaneThreadId 存在（否则下面的断言会静默跳过）');

  /* ---- T1 单元：生产实测的各种 References 形态都必须取到同一个正确根 ---- */
  section('T1 rootThreadId 对生产实测形态的解析');
  const ROOT_ID = 'DM6PR02MB1234.abc@outlook.com';
  const shapes = [
    ['JSON 数组文本（Resend 真实形态）', `["<${ROOT_ID}>","<m2@x>"]`],
    ['JSON 数组单元素', `["<${ROOT_ID}>"]`],
    ['RFC 5322 空格分隔', `<${ROOT_ID}> <m2@x> <m3@x>`],
    ['单个 Message-ID', `<${ROOT_ID}>`],
    ['裸 Message-ID（无尖括号）', ROOT_ID],
    ['已被嵌套转义污染的历史值', `["<\\",\\"<\\\\\\"<${ROOT_ID}>\\\\\\">\\">"]`],
  ];
  for (const [label, refs] of shapes) {
    const got = util.rootThreadId({ references: refs, inReplyTo: null, messageId: null, fallback: 'fb' });
    ok(got === ROOT_ID, `${label} -> 根 = ${ROOT_ID}`, got);
  }
  ok(util.rootThreadId({ references: null, inReplyTo: `["<${ROOT_ID}>"]`, messageId: null, fallback: 'fb' }) === ROOT_ID,
    'References 缺失时回退 In-Reply-To（同样是 JSON 数组文本形态）');
  ok(util.rootThreadId({ references: null, inReplyTo: null, messageId: ROOT_ID, fallback: 'fb' }) === ROOT_ID,
    '两者都缺失时用自身 message_id');
  ok(util.rootThreadId({ references: '   ', inReplyTo: null, messageId: null, fallback: 'fb' }) === 'fb',
    '全空 -> 落到 fallback');

  /* ---- T1b 负控制组：旧算法在同一输入上必须产出畸形值 ---- */
  section('T1b 负控制组：旧算法（split(/\s+/)[0] + stripAngle）确实会产出畸形值');
  const jsonRefs = `["<${ROOT_ID}>","<m2@x>"]`;
  const legacy = legacyRoot(jsonRefs, null, null);
  ok(legacy !== ROOT_ID, '⭐ 旧算法对 JSON 数组文本取不到根（否则「修复」无从谈起）', JSON.stringify(legacy));
  ok(/[[\]"]/.test(legacy), '旧算法结果里残留方括号/引号（畸形 thread_id 的特征）', JSON.stringify(legacy));
  ok(util.rootThreadId({ references: jsonRefs, inReplyTo: null, messageId: null, fallback: 'fb' }) === ROOT_ID,
    '⭐ 同一输入下新实现取到正确根（对照成立 -> 下面 T2 的断言不是空转）');

  /* ---- T1c isSaneThreadId：畸形判定 ---- */
  section('T1c isSaneThreadId 判定');
  const saneCases = [
    ['正常 message-id 形态', 'DM6PR02MB1234.abc@outlook.com', true],
    ['内部 uuid（出站 message_id 就是它）', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', true],
    ['JSON 数组文本', `["<${ROOT_ID}>"]`, false],
    ['含空格', 'a b', false],
    ['含尖括号', '<a@b>', false],
    ['含反斜杠', 'a\\b', false],
    ['空串', '', false],
    ['null', null, false],
  ];
  for (const [label, v, expect] of saneCases) {
    ok(util.isSaneThreadId(v) === expect, `isSaneThreadId(${label}) === ${expect}`, String(util.isSaneThreadId(v)));
  }

  /* ---------------------------------------------------------------------------
   * T2 全链路：3 轮往返后，所有邮件必须共享同一个 thread_id
   * -------------------------------------------------------------------------*/
  const env = {
    DB: db,
    RESEND_WEBHOOK_SECRET: SECRET,
    RESEND_API_KEY: 're_test',
    SEND_FROM_ADDRESS: MAILBOX,
    SEND_FROM_NAME: 'Support',
  };

  // 桩掉 Resend 的出站发送与收信内容拉取（都走全局 fetch）
  let lastReceived = null;
  const sentBodies = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (u.includes('/emails/receiving/')) return jsonRes(lastReceived);
    if (u.includes('/emails')) {
      sentBodies.push(init && init.body ? JSON.parse(init.body) : null);
      return jsonRes({ id: `resend_${sentBodies.length}` });
    }
    return jsonRes({});
  };

  let seq = 0;
  async function postInbound(payload) {
    const body = JSON.stringify(payload);
    const id = `msg_${++seq}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const req = new Request('https://example.com/webhook/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...svixHeaders(id, ts, body) },
      body,
    });
    return worker.default.fetch(req, env);
  }

  /** 造一封收到的邮件；extra 覆盖任意字段（headers / message_id / …）。 */
  function receivedEmail(emailId, extra) {
    return Object.assign({
      id: emailId,
      from: `Peer <${PEER}>`,
      subject: '往返测试',
      html: '<p>hi</p>',
      text: 'hi',
      created_at: new Date(1700000000000 + seq * 60000).toISOString(),
      message_id: `<${emailId}@upvote.network>`,
      to: MAILBOX,
      headers: {},
      attachments: [],
    }, extra || {});
  }

  async function replyViaApi(rowId, text) {
    const req = new Request(`https://example.com/api/messages/${rowId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: text, mailbox: MAILBOX }),
    });
    const res = await worker.default.fetch(req, env);
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  section('T2 ⭐ 3 轮往返：thread_id 必须自始至终只有一个');
  const threadIds = [];
  const rowIds = [];

  // ---- 第 1 封来信：没有任何 References / In-Reply-To ----
  lastReceived = receivedEmail('m1');
  let res = await postInbound({ type: 'email.received', data: { email_id: 'm1' } });
  ok(res.status === 200, '入站 #1 处理成功', res.status);
  const in1 = db.queryOne('SELECT id, thread_id, message_id FROM messages WHERE resend_id = ?', 'm1');
  ok(!!in1, '入站 #1 已入库', in1 && in1.id);
  ok(in1 && in1.thread_id === 'm1@upvote.network', '入站 #1 的 thread_id = 自身 message_id', in1 && in1.thread_id);
  threadIds.push(in1.thread_id);
  rowIds.push(in1.id);

  // ---- 我们回复第 1 封 ----
  let r = await replyViaApi(in1.id, '第一封回复');
  ok(r.status === 200 && r.json && r.json.ok === true, '回复 #1 发送成功', JSON.stringify(r.json));
  // 出站行 id 一律取接口返回的 id：三封出站的 received_at 会落在同一秒，
  // 用 `ORDER BY received_at DESC LIMIT 1` 取「最新一行」在并列时是不确定的。
  const out1 = db.queryOne('SELECT id, thread_id, "references" AS refs, in_reply_to FROM messages WHERE id = ?', r.json.id);
  ok(!!out1, '出站 #1 已入库', r.json.id);
  ok(out1 && out1.thread_id === 'm1@upvote.network',
    '⭐ 出站 #1 继承原邮件 thread_id（不是按 References 重新推导出一个新会话）', out1 && out1.thread_id);
  threadIds.push(out1.thread_id);
  rowIds.push(out1.id);

  // ---- 第 2 封来信：Resend 真实形态的 References（JSON 数组文本） ----
  // 对方客户端引用的「我们那封」用的是 Resend 生成的 RFC Message-ID（我们没有留存），
  // 这里用一个等价的占位值，形态与线上一致。
  const RESEND_MID_1 = 'a1b2c3d4-1111-2222-3333-444455556666@smtp.resend.com';
  lastReceived = receivedEmail('m2', {
    headers: { References: `["<m1@upvote.network>"]`, 'In-Reply-To': `["<${RESEND_MID_1}>"]` },
  });
  res = await postInbound({ type: 'email.received', data: { email_id: 'm2' } });
  ok(res.status === 200, '入站 #2 处理成功', res.status);
  const in2 = db.queryOne('SELECT id, thread_id, "references" AS refs, in_reply_to FROM messages WHERE resend_id = ?', 'm2');
  ok(in2 && in2.thread_id === 'm1@upvote.network',
    '⭐⭐ 入站 #2 与第 1 封同会话（旧实现在这里会落成畸形 thread_id）', in2 && in2.thread_id);
  threadIds.push(in2.thread_id);
  rowIds.push(in2.id);

  // 负控制：旧算法算出来的 thread_id 与真实会话不一致 —— 这就是「碎片化」的证据
  const legacyIn2 = legacyRoot(`["<m1@upvote.network>"]`, `["<${RESEND_MID_1}>"]`, '<m2@upvote.network>');
  ok(legacyIn2 !== 'm1@upvote.network',
    '⭐ 负控制：旧算法把入站 #2 归到了另一个会话（用户看到的「会话里只有两封」）', JSON.stringify(legacyIn2));

  ok(in2 && in2.in_reply_to === RESEND_MID_1,
    '入站 #2 的 in_reply_to 是干净的 Message-ID（旧实现会残留 `["` 前缀）', in2 && JSON.stringify(in2.in_reply_to));

  // ---- 我们回复第 2 封 ----
  r = await replyViaApi(in2.id, '第二封回复');
  ok(r.status === 200 && r.json && r.json.ok === true, '回复 #2 发送成功', JSON.stringify(r.json));
  const out2 = db.queryOne('SELECT id, thread_id, "references" AS refs FROM messages WHERE id = ?', r.json.id);
  ok(out2 && out2.thread_id === 'm1@upvote.network', '出站 #2 仍是同一个 thread_id', out2 && out2.thread_id);
  threadIds.push(out2.thread_id);
  rowIds.push(out2.id);

  // ---- 第 3 封来信：References 链已变长 ----
  const RESEND_MID_2 = 'b2c3d4e5-2222-3333-4444-555566667777@smtp.resend.com';
  lastReceived = receivedEmail('m3', {
    headers: {
      References: `["<m1@upvote.network>","<m2@upvote.network>","<${RESEND_MID_2}>"]`,
      'In-Reply-To': `["<${RESEND_MID_2}>"]`,
    },
  });
  res = await postInbound({ type: 'email.received', data: { email_id: 'm3' } });
  ok(res.status === 200, '入站 #3 处理成功', res.status);
  const in3 = db.queryOne('SELECT id, thread_id FROM messages WHERE resend_id = ?', 'm3');
  ok(in3 && in3.thread_id === 'm1@upvote.network', '入站 #3 仍在同一会话', in3 && in3.thread_id);
  threadIds.push(in3.thread_id);
  rowIds.push(in3.id);

  r = await replyViaApi(in3.id, '第三封回复');
  ok(r.status === 200, '回复 #3 发送成功', r.status);
  const out3 = db.queryOne('SELECT id, thread_id FROM messages WHERE id = ?', r.json.id);
  threadIds.push(out3.thread_id);
  rowIds.push(out3.id);

  const uniq = Array.from(new Set(threadIds));
  ok(uniq.length === 1, `⭐⭐⭐ 6 封邮件（3 来 3 回）只落 1 个 thread_id（实际 ${uniq.length} 个）`, uniq.join(' | '));
  ok(uniq[0] === 'm1@upvote.network', '会话 id 就是整条链的根 Message-ID', uniq[0]);

  // ---- 会话面板：一次往返都不能少 ----
  const threadRows = await repo.listThread(env, uniq[0]);
  ok(threadRows.length === 6, `⭐ 会话面板能看到全部 6 封（修复前只有 2 封）`, String(threadRows.length));
  const threadRowIds = threadRows.map((x) => x.id).sort();
  ok(threadRowIds.join(',') === rowIds.slice().sort().join(','), '会话里的每一行都对应到上面那 6 封邮件');

  /* ---- T3 回复写出的 References 不得再含方括号 / 引号 / 反斜杠（防嵌套转义复发） ---- */
  section('T3 出站 References 必须是规范的空格分隔列表');
  const outRows = db.query('SELECT "references" AS refs, thread_id FROM messages WHERE direction = ?', 'outbound');
  ok(outRows.length === 3, '出站共 3 行（前置条件）', String(outRows.length));
  for (const row of outRows) {
    const refs = row.refs || '';
    ok(REFS_OK.test(refs), `References 形态规范：${JSON.stringify(refs)}`, JSON.stringify(refs));
    ok(!/[[\]"\\]/.test(refs), '不含方括号 / 引号 / 反斜杠（转义污染的特征）', JSON.stringify(refs));
  }
  const refsOfOut3 = outRows[outRows.length - 1].refs;
  info(`出站 #3 的 References = ${JSON.stringify(refsOfOut3)}`);

  // 精确锁住链条语义：出站 References = 原邮件 References 链 + 原邮件 Message-ID（去重）。
  // 这一条同时是「嵌套转义」的回归闸门：旧实现会把整段 JSON 文本再拼一遍，
  // 长度逐轮暴涨（生产实测 178 → 334 → 500 → 686），下面的相等断言会立刻挂。
  const sortedOut = outRows.slice().sort((a, b) => (a.refs || '').length - (b.refs || '').length);
  ok(sortedOut[0].refs === '<m1@upvote.network>',
    '出站 #1 的 References = `<m1@upvote.network>`（只有根）', JSON.stringify(sortedOut[0].refs));
  ok(sortedOut[1].refs === '<m1@upvote.network> <m2@upvote.network>',
    '出站 #2 的 References = 根 + 上一封（不重复、不带方括号）', JSON.stringify(sortedOut[1].refs));
  ok(sortedOut[2].refs === `<m1@upvote.network> <m2@upvote.network> <${RESEND_MID_2}> <m3@upvote.network>`,
    '出站 #3 的 References = 完整链（长度线性增长，不是逐轮翻倍转义）', JSON.stringify(sortedOut[2].refs));

  /* ---- T4 历史畸形数据：原 thread_id 不干净时必须回退推导，不能把畸形值传下去 ---- */
  section('T4 历史畸形 thread_id 的兜底（回退按 References 重新推导）');
  const malformed = `["<m1@upvote.network>","<m2@upvote.network>"]`;
  await db.prepare('UPDATE messages SET thread_id = ? WHERE resend_id = ?').bind(malformed, 'm3').run();
  lastReceived = receivedEmail('m4', {
    headers: { References: `["<m1@upvote.network>","<m2@upvote.network>"]` },
  });
  res = await postInbound({ type: 'email.received', data: { email_id: 'm4' } });
  ok(res.status === 200, '入站 #4 处理成功', res.status);
  const in4 = db.queryOne('SELECT id, thread_id FROM messages WHERE resend_id = ?', 'm4');
  ok(in4 && in4.thread_id === 'm1@upvote.network', '入站 #4 按 References 归到根会话', in4 && in4.thread_id);
  const r4 = await replyViaApi(in4.id, '回复畸形会话');
  ok(r4.status === 200, '回复 #4 发送成功', r4.status);
  const out4 = db.queryOne('SELECT id, thread_id FROM messages WHERE id = ?', r4.json.id);
  ok(out4 && out4.thread_id === 'm1@upvote.network',
    '⭐ 回复时不会把畸形 thread_id 传下去（回退推导出干净值）', out4 && out4.thread_id);
  ok(out4 && util.isSaneThreadId(out4.thread_id) === true, '新出站行的 thread_id 通过 isSaneThreadId 检查', out4 && out4.thread_id);

  /* ---- 汇总 ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r2) => !r2.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);
  console.log(`\n===== 结果: ${pass} passed, ${failed.length} failed =====`);
  cleanup();
  process.exit(failed.length ? 1 : 0);
})();
