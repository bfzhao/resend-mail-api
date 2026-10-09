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
// QA_REPO_TS 仅用于「变异验证」：指向一份人工构造的 repo.ts 变体（放仓库外），
// 确认本测试确实能抓到缺陷。缺了这个钩子，变异脚本会「跑仓库原文件却以为跑的是变体」→ 假绿。
const REPO_TS = process.env.QA_REPO_TS || path.join(ROOT, 'src', 'repo.ts');
const WORK_DIR = path.join(os.tmpdir(), `ingest-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');
const REPO_MD5 = crypto.createHash('md5').update(fs.readFileSync(REPO_TS)).digest('hex');
const SECRET = 'whsec_' + Buffer.from('a-test-signing-key-for-inbound-webhook').toString('base64');
const MAILBOX = 'support@notionmanager.com';

/* ---------------------------------------------------------------------------
 * 1) 把整份 src/ 复制到仓库外（变体覆盖 repo.ts）后编译，拿到真实的 repo.*
 *
 * 为什么要复制 src/ 而不是直接编译仓库里的 src/：QA_REPO_TS 的变体在仓库外，
 * 而 tsc 需要一份完整的 src/ 才能编译。复制一份再覆盖同名文件，就能在
 * **完全不改动仓库**的前提下编译任意变体。
 * 临时 tsconfig 由仓库 tsconfig 改写而来（只换 noEmit/module/outDir/rootDir + files），
 * 避免手抄 compilerOptions 造成与仓库配置漂移。
 *
 * ⚠️ 两个必须的配套（少了任何一个都会编译失败，且报错看起来与变体无关）：
 *   a) 临时目录在 os.tmpdir() 下，类型解析（types: ['@cloudflare/workers-types']）与
 *      产物的裸模块解析都要靠 node_modules —— 必须在**编译之前**把
 *      WORK_DIR/node_modules 链接到仓库 node_modules，否则报
 *      TS2688 Cannot find type definition file for '@cloudflare/workers-types'；
 *   b) module 改成 commonjs 后**不要**顺手改 moduleResolution：本机 tsc 是
 *      TypeScript 7，`node10` 已被移除（TS5108），仓库的 'bundler' 与 commonjs
 *      的组合是被接受的。
 * -------------------------------------------------------------------------*/
function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc: ${tsc}`);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SRC_COPY, { recursive: true });

  // (a) 先于编译建立 node_modules 链接
  try {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK_DIR, 'node_modules'), 'junction');
  } catch (e) {
    throw new Error(`无法为临时编译目录链接 node_modules: ${e.message}`);
  }

  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.ts')) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(SRC_COPY, f));
  }
  // 变体覆盖（同目录同名 → 直接替换掉复制过来的那份）
  fs.copyFileSync(REPO_TS, path.join(SRC_COPY, 'repo.ts'));

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  delete cfg.include;
  delete cfg.exclude;
  cfg.files = fs.readdirSync(SRC_COPY).filter((f) => f.endsWith('.ts')).map((f) => path.join(SRC_COPY, f));
  cfg.compilerOptions = Object.assign({}, cfg.compilerOptions, {
    noEmit: false,
    module: 'commonjs', // moduleResolution 保持仓库的 'bundler'（见上方 b）
    outDir: BUILD_DIR,
    rootDir: SRC_COPY,
  });
  const cfgPath = path.join(WORK_DIR, 'tsconfig.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (r.status !== 0) throw new Error(`tsc 编译失败(exit=${r.status}): ${out}`);
  if (!fs.existsSync(path.join(BUILD_DIR, 'repo.js'))) {
    throw new Error(`编译产物缺失: ${path.join(BUILD_DIR, 'repo.js')}`);
  }
  return BUILD_DIR;
}

/**
 * 清理临时编译目录。
 *
 * WORK_DIR/node_modules 是指向**仓库 node_modules** 的 junction。实测
 * fs.rmSync(WORK_DIR, {recursive:true}) 不会穿透 junction 删目标，但删除顺序一旦出错
 * 就是「把仓库依赖删掉」这种不可逆事故 —— 显式先卸载链接再删目录，代价只有几行。
 */
function cleanup() {
  const link = path.join(WORK_DIR, 'node_modules');
  try {
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
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
    // ⚠️ repo.ts 的指纹必须取**实际被编译的那份**（QA_REPO_TS 变体或仓库原件），
    //    否则变异跑会打印仓库原件的 md5 → 让人误以为变体生效了。
    'src/repo.ts': REPO_MD5,
    'src/webhook.ts': crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, 'src', 'webhook.ts'))).digest('hex'),
  };
  console.log(`被测版本: src/repo.ts md5=${FINGERPRINT['src/repo.ts']}${process.env.QA_REPO_TS ? '  ← QA_REPO_TS 变异体' : ''}  src/webhook.ts md5=${FINGERPRINT['src/webhook.ts']}`);

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

  /** 造一封收到邮件：to 形态可指定 string / array / 缺失；extra 覆盖任意字段（headers / cc / …）。 */
  function receivedEmail(emailId, to, extra) {
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
    return Object.assign(base, extra || {});
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

  section('T9 ⭐ 列表查询必须带回 mailbox（信封卡乐观渲染靠它显示「收至 …」）');
  {
    const res = await repo.listFolder(inboundEnv, { folder: 'inbox', limit: 50, offset: 0 });
    ok(res.items.length > 0, '列表有数据（否则下面的断言空转）', res.items.length);
    ok(res.items.every((it) => Object.prototype.hasOwnProperty.call(it, 'mailbox')),
      'LIST_SELECT 每一行都带 mailbox 字段', JSON.stringify(Object.keys(res.items[0] || {})));
    const mine = res.items.find((it) => it.mailbox === MAILBOX);
    ok(!!mine, 'mailbox 的值正确（不是恒 null / 恒空串）', mine && mine.mailbox);

    // 负控制：不同信箱的行各自带回自己的值，排除「恰好所有行都一样」也能通过
    await repo.saveInbound(inboundEnv, {
      rowId: 'row-other-mb', resendId: 're_in_other', messageId: null, inReplyTo: null, references: null,
      threadId: 't-in-3', mailbox: 'other@notionmanager.com', fromName: null, fromEmail: 'a@b.com',
      to: ['other@notionmanager.com'], cc: [], bcc: [], replyTo: [], subject: 's', html: null, text: 't',
      receivedAt: 1788800002, attachments: [],
    }, 'evt-other');
    const res2 = await repo.listFolder(inboundEnv, { folder: 'inbox', limit: 50, offset: 0 });
    const other = res2.items.find((it) => it.id === 'row-other-mb');
    ok(other && other.mailbox === 'other@notionmanager.com',
      '负控制：不同信箱的行各自带回自己的 mailbox（区分度成立）', other && other.mailbox);
  }

  section('T10 ⭐ 入站收件人 = 真实 To: 头，投递地址另存 delivered_to');
  {
    // 生产数据实测（用户报障）：发件人 zhanglili@notionmanager.com 发往
    //   To: lara@realmarketlabs.com，Cc: bingfeng@notionmanager.com
    // Resend 收信接口的 `to` 返回的是**投递地址**（bingfeng@notionmanager.com），
    // 真实 To 头只保留在 `headers.to` 里。此前直接把 `email.to` 当收件人存 →
    // 详情页「收件人」显示成用户自己。
    const emailId = 'em_cc_1';
    lastEmailResponse = receivedEmail(emailId, ['bingfeng@notionmanager.com'], {
      headers: { to: 'Lara Valencia <lara@realmarketlabs.com>' },
      cc: ['bingfeng@notionmanager.com'],
    });
    const res = await postInbound({
      type: 'email.received',
      data: { email_id: emailId, received_for: ['bingfeng@notionmanager.com'], cc: ['bingfeng@notionmanager.com'] },
    });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT mailbox, to_emails, delivered_to, cc FROM messages WHERE resend_id = ?', emailId);
    ok(!!row, '邮件已入库', row && row.id);
    ok(row && row.mailbox === 'bingfeng@notionmanager.com', 'mailbox = 实际投递信箱', row && row.mailbox);
    ok(row && JSON.stringify(JSON.parse(row.to_emails)) === JSON.stringify(['lara@realmarketlabs.com']),
      '⭐ to_emails = 真实 To: 头（不再是投递地址 → 不会再显示成自己）', row && row.to_emails);
    ok(row && JSON.stringify(JSON.parse(row.delivered_to)) === JSON.stringify(['bingfeng@notionmanager.com']),
      '⭐ delivered_to = 投递地址（信封收件人），单独一列存', row && row.delivered_to);
    ok(row && JSON.stringify(JSON.parse(row.cc)) === JSON.stringify(['bingfeng@notionmanager.com']),
      'cc 仍存真实抄送头（前端据此判定「你是抄送」）', row && row.cc);
  }

  section('T10b 负控制：拿不到 headers.to 时回退投递地址（行为不倒退）');
  {
    const emailId = 'em_noheaderto_1';
    lastEmailResponse = receivedEmail(emailId, ['bingfeng@notionmanager.com'], { headers: {} });
    const res = await postInbound({ type: 'email.received', data: { email_id: emailId } });
    ok(res.status === 200, 'webhook 处理成功', res.status);
    const row = db.queryOne('SELECT to_emails, delivered_to FROM messages WHERE resend_id = ?', emailId);
    ok(row && JSON.stringify(JSON.parse(row.to_emails)) === JSON.stringify(['bingfeng@notionmanager.com']),
      'to_emails 回退到投递地址（取不到头时不至于丢收件人）', row && row.to_emails);
    ok(row && JSON.stringify(JSON.parse(row.delivered_to)) === JSON.stringify(['bingfeng@notionmanager.com']),
      'delivered_to 照常写入', row && row.delivered_to);
  }

  section('T11 ⭐ 附件代理：可预览类型内联，其余下载；forceDownload 强制下载');
  {
    const bytes = new TextEncoder().encode('x');
    const mkBucket = (key, data) => ({
      async get(k) { return k === key ? { size: data.length, body: data } : null; },
      async put() { return {}; },
    });
    const putAtt = (id, key, filename, type, env) =>
      db.prepare(
        'INSERT INTO attachments (id, message_id, r2_key, filename, content_type, size, inline, content_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(id, 'row-att', key, filename, type, bytes.length, 0, null, 1).run();

    // attachments.message_id 有外键约束，先造一封宿主邮件
    await db.prepare('INSERT INTO messages (id, direction, to_emails, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .bind('row-att', 'inbound', '[]', 1, 1, 1).run();

    // ① 类型判定纯函数：与前端 attachmentKind() 同一口径
    const cases = [
      ['image/png', true], ['image/jpeg', true], ['image/webp', true],
      ['image/svg+xml', false], // ⭐ SVG 能带 <script>，内联到同源 = XSS
      ['application/pdf', true], ['video/mp4', true], ['audio/mpeg', true],
      ['text/plain', true], ['text/csv', true], ['application/json', true],
      ['text/html', false], ['application/zip', false], ['application/octet-stream', false],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', false], ['', false],
    ];
    for (const [t, want] of cases) {
      const got = repo.isInlinePreviewType(t);
      ok(got === want, `isInlinePreviewType(${JSON.stringify(t)}) === ${want}`, got);
    }

    // ② 真跑一次代理：Content-Disposition 决定浏览器「就地打开」还是「存盘」
    const pngEnv = { DB: db, BUCKET: mkBucket('k-png', bytes) };
    await putAtt('att-png', 'k-png', 'pic.png', 'image/png');
    const r1 = await repo.proxyAttachment(pngEnv, 'att-png');
    ok(r1 && /^inline/i.test(r1.headers.get('Content-Disposition') || ''),
      'image/png → inline（点开即预览）', r1 && r1.headers.get('Content-Disposition'));
    const r2 = await repo.proxyAttachment(pngEnv, 'att-png', { forceDownload: true });
    ok(r2 && /^attachment/i.test(r2.headers.get('Content-Disposition') || ''),
      '⭐ forceDownload（路由的 ?dl=1）→ attachment，下载按钮拿到的确实是文件', r2 && r2.headers.get('Content-Disposition'));

    const svgEnv = { DB: db, BUCKET: mkBucket('k-svg', bytes) };
    await putAtt('att-svg', 'k-svg', 'x.svg', 'image/svg+xml');
    const r3 = await repo.proxyAttachment(svgEnv, 'att-svg');
    ok(r3 && /^attachment/i.test(r3.headers.get('Content-Disposition') || ''),
      '⭐ image/svg+xml → attachment（可执行脚本，绝不内联）', r3 && r3.headers.get('Content-Disposition'));

    const pdfEnv = { DB: db, BUCKET: mkBucket('k-pdf', bytes) };
    await putAtt('att-pdf', 'k-pdf', 'doc.pdf', 'application/pdf');
    const r4 = await repo.proxyAttachment(pdfEnv, 'att-pdf');
    ok(r4 && /^inline/i.test(r4.headers.get('Content-Disposition') || ''),
      'application/pdf → inline（浏览器内置查看器）', r4 && r4.headers.get('Content-Disposition'));

    const zipEnv = { DB: db, BUCKET: mkBucket('k-zip', bytes) };
    await putAtt('att-zip', 'k-zip', 'a.zip', 'application/zip');
    const r5 = await repo.proxyAttachment(zipEnv, 'att-zip');
    ok(r5 && /^attachment/i.test(r5.headers.get('Content-Disposition') || ''),
      'application/zip → attachment（浏览器不会预览，别指望它）', r5 && r5.headers.get('Content-Disposition'));

    // ③ 负控制：不存在 / R2 缺对象都返回 null（否则「404」这条路径没被验证过）
    ok((await repo.proxyAttachment(pngEnv, 'no-such-id')) === null, '未知附件 id → null（路由转 404）');
    const emptyEnv = { DB: db, BUCKET: mkBucket('nope', bytes) };
    ok((await repo.proxyAttachment(emptyEnv, 'att-png')) === null, 'R2 里没有对象 → null（不返回空 200）');
  }

  /* -------------------------------------------------------------------------
   * T12 会话上下文（listThread）：降序 + 折叠「同一封物理邮件的回环副本」
   *
   * 生产数据实测（2026-10-08）：账号下配了多个收信信箱，用 bingfeng@ 发信并抄送
   * zhanglili@ 时，Resend 会把同一封邮件投递回 zhanglili@，于是库里既有出站副本、
   * 又有入站副本；两者 from/to/cc/主题/in_reply_to 完全相同、入库时间差 1~2 秒，
   * 会话面板里逐字相同 → 用户报「同一封信显示了两次」。
   * -----------------------------------------------------------------------*/
  section('T12 会话上下文：降序 + 折叠回环副本');

  let t12seq = 0;
  /** 造一条出站记录。默认发件人 bingfeng@notionmanager.com（本账号身份）。 */
  async function addOut(threadId, opts) {
    const rid = `t12-out-${++t12seq}`;
    await repo.saveOutbound(inboundEnv, {
      messageId: null, inReplyTo: null, references: null, threadId,
      mailbox: opts.mailbox || 'bingfeng@notionmanager.com',
      fromName: null, fromEmail: opts.from || 'bingfeng@notionmanager.com',
      to: opts.to || [], cc: opts.cc || [], bcc: opts.bcc || [],
      subject: opts.subject || 'Re: T12', html: null, text: 'x',
      resendId: `re-${rid}`, receivedAt: opts.at,
    });
    return rid;
  }
  /** 造一条入站记录（read 默认 0，与真实入站一致）。 */
  async function addIn(threadId, opts) {
    const rid = `t12-in-${++t12seq}`;
    await repo.saveInbound(inboundEnv, {
      rowId: rid, resendId: `re-${rid}`, messageId: `${rid}@ses`, inReplyTo: null, references: null,
      threadId,
      mailbox: opts.mailbox || 'zhanglili@notionmanager.com',
      fromName: null, fromEmail: opts.from || 'bingfeng@notionmanager.com',
      to: opts.to || [], deliveredTo: opts.deliveredTo || null,
      cc: opts.cc || [], bcc: opts.bcc || [], replyTo: [],
      subject: opts.subject || 'Re: T12', html: null, text: 'x',
      receivedAt: opts.at, attachments: [],
    }, `evt-${rid}`);
    return rid;
  }

  /* ---- T12a 排序：最近在前 ---- */
  {
    const TID = 't12-order';
    await addOut(TID, { at: 1000, to: ['a@x.com'] });
    await addOut(TID, { at: 3000, to: ['a@x.com'] });
    await addOut(TID, { at: 2000, to: ['a@x.com'] });
    const th = await repo.listThread(inboundEnv, TID);
    ok(th.length === 3, '前置：会话里有 3 条（否则下面的顺序断言空转）', th.length);
    ok(th.map((r) => r.received_at).join(',') === '3000,2000,1000',
      '⭐ 会话按 received_at 降序（最近 → 最早）', th.map((r) => r.received_at).join(','));
    ok(th.map((r) => r.received_at).join(',') !== '1000,2000,3000',
      '负控制：不是升序（旧实现会返回 1000,2000,3000）', th.map((r) => r.received_at).join(','));
    ok(th[0].received_at > th[th.length - 1].received_at,
      '首条确实比末条新', `${th[0].received_at} > ${th[th.length - 1].received_at}`);
  }

  /* ---- T12b 折叠：线上真实形态（抄送本账号另一个信箱 → 投递回环）---- */
  {
    const TID = 't12-loop';
    const outId = await addOut(TID, {
      at: 1791343361, mailbox: 'bingfeng@notionmanager.com',
      to: ['lara@realmarketlabs.com'], cc: ['zhanglili@notionmanager.com'],
    });
    const inId = await addIn(TID, {
      at: 1791343363, mailbox: 'zhanglili@notionmanager.com',
      to: ['lara@realmarketlabs.com'], cc: ['zhanglili@notionmanager.com'],
      deliveredTo: ['zhanglili@notionmanager.com'],
    });

    // 负控制：库里确实是两条 —— 折叠发生在读取侧，不是入库时丢了
    const n = db.queryOne('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', TID);
    ok(Number(n.n) === 2, '负控制：库里确实有 2 条记录（不是入库时就少了一条）', n.n);

    const th = await repo.listThread(inboundEnv, TID);
    ok(th.length === 1, '⭐ 回环副本被折叠：会话里只剩 1 条（用户看到「同一封信两次」的直接原因）', th.length);
    ok(th.length === 1 && th[0].direction === 'outbound', '留存的是**出站**副本（我发出的那封）',
      th.length ? th[0].direction : 'n/a');
    ok(th.length === 1 && Array.isArray(th[0].copy_ids) && th[0].copy_ids.length === 1,
      '被折叠副本的 id 挂在留存行的 copy_ids 上（前端据此把「打开的是副本」也认作当前行）',
      th.length ? JSON.stringify(th[0].copy_ids) : 'n/a');
    ok(th.length === 1 && Number(th[0].read) === 0,
      '⭐ 副本未读 → 留存行也标为未读（折叠不得静默吞掉未读信号）',
      th.length ? th[0].read : 'n/a');
    // 出站行自己仍在（没被连带删掉）
    ok(db.queryOne('SELECT id FROM messages WHERE resend_id = ?', `re-${outId}`) !== null,
      '出站记录本身仍在库里（折叠只影响读取结果）');
    ok(db.queryOne('SELECT id FROM messages WHERE resend_id = ?', `re-${inId}`) !== null,
      '入站副本本身仍在库里（在 zhanglili@ 自己的收件箱里照常显示）');
  }

  /* ---- T12c 折叠的负控制：以下形态**必须保留**，一条都不许吞 ---- */
  {
    // ① 对方来信被投递到本账号的两个信箱 → 两条都是真实来信，不是回环
    //    （刻意让该会话里**也有**一条我的出站行，否则会走到「无出站 → 早退」分支，测不到判定逻辑）
    const TID1 = 't12-neg-multi-in';
    await addOut(TID1, { at: 5002, to: ['lara@realmarketlabs.com'], cc: ['zhanglili@notionmanager.com'] });
    await addIn(TID1, { at: 5000, mailbox: 'bingfeng@notionmanager.com', from: 'lara@realmarketlabs.com', to: ['bingfeng@notionmanager.com'] });
    await addIn(TID1, { at: 5001, mailbox: 'zhanglili@notionmanager.com', from: 'lara@realmarketlabs.com', to: ['zhanglili@notionmanager.com'] });
    const th1 = await repo.listThread(inboundEnv, TID1);
    ok(th1.length === 3,
      '① 对方来信投递到两个本账号信箱 + 我的一封回信 → 3 条全保留（发件人是对方，不是回环）', th1.length);

    // ② 发件人是对方（即使时间、投递信箱都吻合）→ 保留
    const TID2 = 't12-neg-from';
    await addOut(TID2, { at: 6000, to: ['lara@realmarketlabs.com'], cc: ['zhanglili@notionmanager.com'] });
    await addIn(TID2, { at: 6001, mailbox: 'zhanglili@notionmanager.com', from: 'lara@realmarketlabs.com', to: ['lara@realmarketlabs.com'], cc: ['zhanglili@notionmanager.com'] });
    const th2 = await repo.listThread(inboundEnv, TID2);
    ok(th2.length === 2, '② 发件人不是我 → 保留（对方来信不得被当成回环吞掉）', th2.length);

    // ③ 时间差超出窗口 → 保留
    const TID3 = 't12-neg-time';
    await addOut(TID3, { at: 7000, to: ['lara@realmarketlabs.com'], cc: ['zhanglili@notionmanager.com'] });
    await addIn(TID3, { at: 7000 + 3600, mailbox: 'zhanglili@notionmanager.com', to: ['lara@realmarketlabs.com'], cc: ['zhanglili@notionmanager.com'] });
    const th3 = await repo.listThread(inboundEnv, TID3);
    ok(th3.length === 2, '③ 入库时间差 1 小时 → 保留（不是同一封）', th3.length);

    // ④ 投递信箱不在出站收件人里 → 保留（我发给 lara，不该把「投到 support@」的信吞掉）
    const TID4 = 't12-neg-box';
    await addOut(TID4, { at: 8000, to: ['lara@realmarketlabs.com'], cc: [] });
    await addIn(TID4, { at: 8001, mailbox: 'support@notionmanager.com', to: ['lara@realmarketlabs.com'], cc: [] });
    const th4 = await repo.listThread(inboundEnv, TID4);
    ok(th4.length === 2, '④ 投递信箱不在出站收件人里 → 保留', th4.length);

    // ⑤ 会话里没有出站行 → 一条都不折叠（早退分支）
    const TID5 = 't12-neg-noout';
    await addIn(TID5, { at: 9000 });
    await addIn(TID5, { at: 9001 });
    const th5 = await repo.listThread(inboundEnv, TID5);
    ok(th5.length === 2, '⑤ 无出站行的会话不做任何折叠', th5.length);
  }

  /* ---- T12d 折叠的正控制补充：走 bcc 回环也要折叠；副本已读时不得把留存行拉成未读 ---- */
  {
    const TID1 = 't12-bcc-loop';
    await addOut(TID1, { at: 11000, to: ['lara@realmarketlabs.com'], cc: [], bcc: ['zhanglili@notionmanager.com'] });
    await addIn(TID1, { at: 11002, mailbox: 'zhanglili@notionmanager.com', to: ['lara@realmarketlabs.com'], cc: [] });
    const th1 = await repo.listThread(inboundEnv, TID1);
    ok(th1.length === 1, '⑥ 密送回环同样折叠（收件人集合含 bcc）', th1.length);

    const TID2 = 't12-read-merge';
    const outId2 = await addOut(TID2, { at: 12000, to: ['lara@realmarketlabs.com'], cc: ['zhanglili@notionmanager.com'] });
    const inId2 = await addIn(TID2, { at: 12002, mailbox: 'zhanglili@notionmanager.com', to: ['lara@realmarketlabs.com'], cc: ['zhanglili@notionmanager.com'] });
    // 把副本标为已读 → 留存行必须仍是已读（负控制：不能无条件置 0）
    await repo.patchMessage(inboundEnv, inId2, { read: true });
    const th2 = await repo.listThread(inboundEnv, TID2);
    ok(th2.length === 1, '前置：仍被折叠', th2.length);
    ok(th2.length === 1 && Number(th2[0].read) === 1,
      '⭐ 副本已读 → 留存行保持已读（「无条件置 0」会被这条抓住）',
      th2.length ? th2[0].read : 'n/a');
    // 前置自证：出站行本身在库里就是已读（否则「留存行已读」可能来自别的原因）
    const outRow2 = db.queryOne('SELECT read FROM messages WHERE resend_id = ?', `re-${outId2}`);
    ok(outRow2 && Number(outRow2.read) === 1, '前置：出站行入库时即 read=1（出站默认已读）',
      outRow2 && outRow2.read);
  }

  /* ---- 汇总 ---- */
  globalThis.fetch = realFetch;
  cleanup();
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
  cleanup();
  process.exit(1);
});
