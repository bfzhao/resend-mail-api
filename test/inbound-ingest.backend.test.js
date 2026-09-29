'use strict';

/* =============================================================================
 * 入站/出站入库语义回归验证（真实 SQLite 当 D1 + 真实 src/ 编译产物）
 *
 * 运行（本沙箱需 tsc 垫片，见文件末尾说明）：
 *   NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js" node test/inbound-ingest.backend.test.js
 * 正常环境：
 *   node test/inbound-ingest.backend.test.js
 *
 * 退出码：0 = 全部通过；1 = 存在失败；2 = 环境缺失（node:sqlite 不可用 / tsc 不可用）。
 *
 * 覆盖两个线上实测到的缺陷（2026-09-29）：
 *   ① 侧边栏出现「(未识别)」分组，点进去其实全是 support@notionmanager.com 的邮件。
 *      根因：pickMailbox() 里手写的 `Array.isArray(data.to)` 只认数组，而 webhook payload
 *      的 `data.to` / Received Emails API 的 `email.to` **都可能是字符串**。
 *   ② 发件箱全部显示未读、点开也不变。根因：insertMessageStmt 把 read 硬编码为 0。
 *
 * 为什么用真实 SQLite：这两个缺陷都是「存进库里的值不对」，只在参数层面断言
 * （比如断言第 20 个绑定参数是 1）会把测试锁死在列顺序上。这里把真实的 D1 语句
 * 落到真实 SQLite 上执行，再 SELECT 回来比对，断言的是**最终数据**。
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
const BUILD_DIR = path.join(os.tmpdir(), `ingest-qa-build-${process.pid}`);
const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-for-inbound-webhook').toString('base64');
const MAILBOX = 'support@notionmanager.com';

/* ---------------------------------------------------------------------------
 * 1) 编译 src/ -> 仓库外临时目录（与 mail-merge.backend.test.js 同一套做法）
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
  const link = path.join(BUILD_DIR, 'node_modules');
  try {
    if (!fs.existsSync(link)) fs.symlinkSync(path.join(ROOT, 'node_modules'), link, 'junction');
  } catch (e) {
    throw new Error(`无法为临时编译目录链接 node_modules: ${e.message}`);
  }
  return BUILD_DIR;
}

/* ---------------------------------------------------------------------------
 * 2) 用真实 SQLite 冒充 D1（schema.sql 的真实 DDL 建表）
 * -------------------------------------------------------------------------*/
function makeD1() {
  const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);

  // node:sqlite 不接受 undefined（D1 接受并当作 NULL）——统一归一化，否则会抛 TypeError
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
    /** 测试专用：直接查库 */
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

/* ---------------------------------------------------------------------------
 * 5) 用例
 * -------------------------------------------------------------------------*/
(async function main() {
  console.log('入站/出站入库语义 —— 真实 SQLite + 真实编译产物验证');
  let entry;
  try {
    entry = build();
  } catch (e) {
    console.error(`\n编译失败，无法继续：${e.message}`);
    console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
    process.exit(2);
  }

  const repo = require(path.join(entry, 'repo.js'));
  const webhook = require(path.join(entry, 'webhook.js'));
  const db = makeD1();

  const FINGERPRINT = {
    'src/repo.ts': crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'src', 'repo.ts'))).digest('hex'),
    'src/webhook.ts': crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'src', 'webhook.ts'))).digest('hex'),
  };
  console.log(`被测版本: src/repo.ts md5=${FINGERPRINT['src/repo.ts']}  src/webhook.ts md5=${FINGERPRINT['src/webhook.ts']}`);

  /* ---- 环境自检：证明 D1 桩是真在跑 SQL，不是空转 ---- */
  section('T0 环境自检');
  await db.prepare('INSERT INTO messages (id, direction, to_emails, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind('self-check', 'inbound', '["x@y.com"]', 1, 1, 1).run();
  const selfRow = await db.prepare('SELECT COUNT(*) AS n FROM messages').first();
  ok(Number(selfRow.n) === 1, 'D1 桩确实把数据写进了真实 SQLite（否则后面全是空转）', selfRow.n);
  await db.prepare('DELETE FROM messages WHERE id = ?').bind('self-check').run();

  /* ---- 入站：webhook 全链路（含签名校验）---- */
  const inboundEnv = { DB: db, RESEND_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: 're_test' };
  let lastEmailResponse = null;

  // 桩掉 Resend 的 Received Emails API（webhook 只带元数据，正文靠这个接口拉）
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/emails/receiving/')) {
      return new Response(JSON.stringify(lastEmailResponse), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
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
    return webhook.handleInbound(req, inboundEnv);
  }

  /** 造一封收到邮件：to 形态可指定 string / array / 缺失。 */
  function receivedEmail(emailId, to) {
    const base = {
      id: emailId,
      from: 'Sender <hello@upvote.network>',
      subject: '测试主题',
      html: '<p>hi</p>',
      text: 'hi',
      created_at: new Date().toISOString(),
      message_id: `<${emailId}@upvote.network>`,
      headers: {},
      attachments: [],
    };
    if (to !== undefined) base.to = to;
    return base;
  }

  section('T1 签名负控制组');
  {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'x' } });
    const bad = new Request('https://example.com/webhook/inbound', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': 'm1', 'svix-timestamp': '1', 'svix-signature': 'v1,AAAA' },
      body,
    });
    const res = await webhook.handleInbound(bad, inboundEnv);
    ok(res.status === 401, '错误签名 → 401（否则下面的 200 不能说明签名真的被校验了）', res.status);
  }

  section('T2 ⭐ 入站 to 是【字符串】→ mailbox 必须归到该地址（用户报的「(未识别)」）');
  {
    const emailId = 'em_str_1';
    lastEmailResponse = receivedEmail(emailId, MAILBOX); // ← 字符串，不是数组
    const res = await postInbound({ type: 'email.received', data: { email_id: emailId } });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT mailbox, direction, read, to_emails FROM messages WHERE resend_id = ?', emailId);
    ok(!!row, '邮件已入库', row && row.id);
    ok(row && row.mailbox === MAILBOX,
      '⭐ mailbox 归到 support@notionmanager.com（不再是空串 → 侧边栏不会再出现「(未识别)」）',
      row && JSON.stringify(row.mailbox));
    ok(row && JSON.parse(row.to_emails)[0] === MAILBOX, 'to_emails 正确', row && row.to_emails);
  }

  section('T3 入站 to 是【数组】→ 行为不能回退');
  {
    const emailId = 'em_arr_1';
    lastEmailResponse = receivedEmail(emailId, [MAILBOX]);
    const res = await postInbound({ type: 'email.received', data: { email_id: emailId } });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT mailbox FROM messages WHERE resend_id = ?', emailId);
    ok(row && row.mailbox === MAILBOX, '数组形态同样正确归类', row && JSON.stringify(row.mailbox));
  }

  section('T4 received_for 优先于 to');
  {
    const emailId = 'em_rf_1';
    lastEmailResponse = receivedEmail(emailId, 'other@notionmanager.com');
    const res = await postInbound({
      type: 'email.received',
      data: { email_id: emailId, received_for: ['bingfeng@notionmanager.com'] },
    });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT mailbox FROM messages WHERE resend_id = ?', emailId);
    ok(row && row.mailbox === 'bingfeng@notionmanager.com',
      'received_for 优先（官方推荐口径，不得被 to 覆盖）', row && JSON.stringify(row.mailbox));
  }

  section('T5 to 完全缺失 → 仍可入库（兜底不崩）');
  {
    const emailId = 'em_none_1';
    lastEmailResponse = receivedEmail(emailId, undefined); // 不设 to
    const res = await postInbound({ type: 'email.received', data: { email_id: emailId } });
    ok(res.status === 200, 'webhook 处理成功（不因缺 to 而 500）', res.status);
    const row = db.queryOne('SELECT mailbox FROM messages WHERE resend_id = ?', emailId);
    ok(!!row, '邮件已入库', row && row.mailbox);
    ok(row && row.mailbox === '', '确实无从推断时才落到空串（由前端 UNKNOWN_MAILBOX 兜底展示）',
      row && JSON.stringify(row.mailbox));
  }

  section('T6 入站邮件 read 必须为 0（未读是入站的正确初态）');
  {
    const rows = db.query('SELECT read FROM messages WHERE direction = ?', 'inbound');
    const allZero = rows.length > 0 && rows.every((r) => Number(r.read) === 0);
    ok(allZero, '全部入站邮件 read = 0', rows.map((r) => r.read).join(','));
  }

  section('T7 ⭐ 出站邮件 read 必须为 1（用户报的「发件箱全是未读」）');
  {
    await repo.saveOutbound(inboundEnv, {
      messageId: null, inReplyTo: null, references: null, threadId: 't-out-1',
      mailbox: MAILBOX, fromName: 'support', fromEmail: MAILBOX,
      to: ['bingfeng@outlook.com'], cc: [], subject: '出站测试',
      html: '<p>x</p>', text: 'x', resendId: 're_out_1', receivedAt: 1788800000,
    });
    const row = db.queryOne('SELECT direction, read, mailbox FROM messages WHERE resend_id = ?', 're_out_1');
    ok(!!row, '出站邮件已入库', row && row.direction);
    ok(row && Number(row.read) === 1,
      '⭐ 出站邮件 read = 1（发件箱不再显示未读，且不依赖前端补偿）', row && row.read);
    ok(row && row.mailbox === MAILBOX, '出站 mailbox 正确', row && row.mailbox);
  }

  section('T8 出站 read 可被显式覆盖（保留调用方指定能力）');
  {
    await repo.saveInbound(inboundEnv, {
      rowId: 'row-explicit', resendId: 're_in_explicit', messageId: null, inReplyTo: null, references: null,
      threadId: 't-in-2', mailbox: MAILBOX, fromName: null, fromEmail: 'a@b.com',
      to: [MAILBOX], cc: [], bcc: [], replyTo: [], subject: 's', html: null, text: 't',
      receivedAt: 1788800001, attachments: [],
    }, 'evt-explicit');
    const row = db.queryOne('SELECT read FROM messages WHERE id = ?', 'row-explicit');
    ok(row && Number(row.read) === 0, '入站仍为 0（默认值只对出站生效）', row && row.read);
  }

  /* ---- 汇总 ---- */
  globalThis.fetch = realFetch;
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });

  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n===== 结果: ${pass} passed, ${failed.length} failed =====`);
  const exitCode = failed.length ? 1 : 0;
  const exitFile = path.join(os.tmpdir(), 'qa-inbound-ingest.exit');
  try { fs.writeFileSync(exitFile, String(exitCode), 'utf8'); console.log(`退出码已写入: ${exitFile} = ${exitCode}`); } catch { /* ignore */ }
  process.exit(exitCode);
})().catch((e) => {
  console.error('\n未捕获异常：', e);
  try { fs.rmSync(BUILD_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
