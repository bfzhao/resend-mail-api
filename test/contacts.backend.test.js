'use strict';

/* =============================================================================
 * 本地联系人（GET /api/contacts）后端验证 —— 真实 SQLite + 真实 repo.contacts()
 *
 * 运行：
 *   NODE_OPTIONS="--require <仓库外垫片>.js" <node.exe> test/contacts.backend.test.js
 *   （套件内部会 spawnSync 起 tsc，本沙箱下需要垫片；垫片说明见
 *     .workbuddy-ai/memory/reference-product-and-platform.md）
 *
 * 为什么值得单独一个套件：
 *   联系人聚合依赖三条**容易写错但不会报错**的 SQL 语义：
 *     1) `json_each('')` / 任何非法 JSON 会**直接抛 `malformed JSON`**，而 `WHERE` 里的判断
 *        **拦不住它**（表值函数在 JOIN 阶段求值，早于 WHERE）—— 写错就是接口 500；
 *     2) 「取该地址最新的姓名」靠 SQLite「裸列与 min()/max() 同取一行」的规则。实测（3.51.2）
 *        这条规则比文档宽松（多一个 COUNT(*)/SUM 也仍然成立），所以**多加聚合造不出缺陷**；
 *        真正会改坏它的是**方向**：`MIN(received_at)` 或 `MAX(from_name)` 都会静默返回错误的姓名
 *        —— 变异验证里的 M2a / M2b 分别锁这两种写法；
 *     3) 自己的收件信箱（`mailbox` 列）**也要**进联系人（2026-10-03 用户决定）。该列里既有
 *        「我自己的身份」，也可能有**同事/团队的地址**（账号给 `zhanglili@` 配了收信），
 *        早期版本按 `DISTINCT mailbox` 全排除 → 同事地址在联想里**静默消失**（用户报障）。
 *        C4 现在锁「自己的信箱**必须出现**」，并用「没有姓名往来 → name 为 null」作负控制。
 *   这三条都只能靠**真实 SQL 引擎**跑出结果来验证，桩不出来。
 *
 * 退出码：0 = 全部通过；1 = 存在失败。
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
// 确认本测试确实能抓到缺陷。缺了这个钩子，变异脚本会「跑仓库原文件却以为跑的是变体」。
const REPO_TS = process.env.QA_REPO_TS || path.join(ROOT, 'src', 'repo.ts');
const WORK_DIR = path.join(os.tmpdir(), `contacts-qa-build-${process.pid}`);
const SRC_COPY = path.join(WORK_DIR, 'src');
const BUILD_DIR = path.join(WORK_DIR, 'out');
const REPO_MD5 = crypto.createHash('md5').update(fs.readFileSync(REPO_TS)).digest('hex');

/* ---------------------------------------------------------------------------
 * 清理临时目录
 *
 * WORK_DIR/node_modules 是指向**仓库 node_modules** 的 junction。实测
 * fs.rmSync(WORK_DIR, {recursive:true}) 不会穿透 junction 删目标（2026-10-03 探针验证），
 * 但删除顺序一旦出错就是「把仓库依赖删掉」这种不可逆事故，所以这里显式先卸载链接
 * 再删目录 —— 代价只有几行，收益是即使未来 Node 行为变化也不会炸仓库。
 * -------------------------------------------------------------------------*/
function cleanup() {
  const link = path.join(WORK_DIR, 'node_modules');
  try {
    if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  } catch { /* ignore */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ---------------------------------------------------------------------------
 * 1) 把整份 src/ 复制到仓库外（变体覆盖 repo.ts）后编译，拿到真实的 repo.contacts()
 *
 * 为什么复制而不是直接编译仓库里的 src/：
 *   QA_REPO_TS 的变体在仓库外，而 tsc 需要一份完整的 src/ 才能编译；
 *   复制一份再覆盖，就能在**完全不改动仓库**的前提下编译任意变体。
 *   临时 tsconfig 由仓库 tsconfig 改写而来（只换 noEmit/module/outDir/rootDir + files），
 *   避免手抄 compilerOptions 造成与仓库配置漂移。
 *
 * ⚠️ 两个必须的配套（少了任何一个都会编译失败，且失败信息看起来与变体无关）：
 *   a) 临时目录在 os.tmpdir() 下，类型解析（types: ['@cloudflare/workers-types']）
 *      以及编译产物的裸模块解析都要靠 node_modules —— 必须在**编译之前**把
 *      WORK_DIR/node_modules 链接到仓库 node_modules，否则报
 *      TS2688 Cannot find type definition file for '@cloudflare/workers-types'；
 *   b) module 改成 commonjs 后**不要**顺手去动 moduleResolution：
 *      本机 tsc 是 TypeScript 7，`node10` 已被移除（TS5108），而仓库的 'bundler'
 *      与 commonjs 的组合是被接受的（mail-merge.backend.test.js 正是这么跑的）。
 * -------------------------------------------------------------------------*/
function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error(`找不到 tsc: ${tsc}`);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(SRC_COPY, { recursive: true });

  // (b) 先于编译建立 node_modules 链接（types 解析 + 产物裸模块解析都靠它）
  try {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK_DIR, 'node_modules'), 'junction');
  } catch (e) {
    throw new Error(`无法为临时编译目录链接 node_modules: ${e.message}`);
  }

  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.ts')) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(SRC_COPY, f));
  }
  // 变体覆盖（同目录同名 -> 直接替换掉复制过来的那份）
  fs.copyFileSync(REPO_TS, path.join(SRC_COPY, 'repo.ts'));

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  delete cfg.include;
  delete cfg.exclude;
  cfg.files = fs.readdirSync(SRC_COPY).filter((f) => f.endsWith('.ts')).map((f) => path.join(SRC_COPY, f));
  cfg.compilerOptions = Object.assign({}, cfg.compilerOptions, {
    noEmit: false,
    module: 'commonjs', // moduleResolution 保持仓库的 'bundler'（见上方 b 注释）
    outDir: BUILD_DIR,
    rootDir: SRC_COPY,
  });
  const cfgPath = path.join(WORK_DIR, 'tsconfig.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tsc 编译失败(exit=${r.status}): ${(r.stdout || '') + (r.stderr || '')}`);
  const entry = path.join(BUILD_DIR, 'repo.js');
  if (!fs.existsSync(entry)) throw new Error(`编译产物缺失: ${entry}`);
  return entry;
}

/* ---------------------------------------------------------------------------
 * 2) 用 schema.sql 的真实 DDL 建库，并把 D1 接口最小适配到 node:sqlite
 * -------------------------------------------------------------------------*/
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

  const prepare = (sql) => {
    const stmt = db.prepare(sql);
    const st = {
      sql,
      args: [],
      bind(...a) { st.args = a; return st; },
      async run() {
        const r = stmt.run(...st.args);
        return { success: true, results: [], meta: { changes: Number(r.changes || 0) } };
      },
      async first() { return stmt.get(...st.args) ?? null; },
      async all() { return { results: stmt.all(...st.args), success: true, meta: {} }; },
    };
    return st;
  };

  return {
    db,
    env: {
      DB: {
        prepare,
        async batch(stmts) { for (const s of stmts) await s.run(); return []; },
        async exec() { return { count: 0, duration: 0 }; },
        async dump() { return new ArrayBuffer(0); },
      },
      BUCKET: { async put() { return {}; }, async get() { return null; }, async delete() { return {}; }, async list() { return { objects: [] }; } },
      SEND_FROM_ADDRESS: 'support@notionmanager.com',
      SEND_FROM_NAME: 'support',
    },
  };
}

/* ---------------------------------------------------------------------------
 * 3) 用例运行器
 * -------------------------------------------------------------------------*/
const results = [];
let currentTest = '(init)';
let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  const good = !!cond;
  if (good) pass++; else fail++;
  results.push({ test: currentTest, ok: good, msg, detail });
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}
function section(name) { currentTest = name; console.log(`\n=== ${name} ===`); }

(async () => {
  const entry = build();
  const repo = require(entry);
  if (typeof repo.contacts !== 'function') throw new Error('编译产物未导出 contacts()');
  console.log(`编译: ${BUILD_DIR}（仓库外临时目录）`);
  console.log(`被测版本: src/repo.ts md5=${REPO_MD5}`);

  const { db, env } = makeEnv();

  // 用**真实** saveInbound / saveOutbound 灌数据，而不是手写 INSERT
  const inbound = (o) =>
    repo.saveInbound(env, Object.assign({
      rowId: o.rowId, resendId: o.resendId, messageId: null, inReplyTo: null, references: null,
      threadId: o.threadId || 't', mailbox: o.mailbox, fromName: o.fromName ?? null, fromEmail: o.fromEmail ?? null,
      to: o.to || [], cc: o.cc || [], bcc: [], replyTo: [], subject: 's', html: null, text: 't',
      receivedAt: o.receivedAt, attachments: [],
    }, {}), `evt-${o.rowId}`);

  const outbound = (o) =>
    repo.saveOutbound(env, {
      messageId: null, inReplyTo: null, references: null, threadId: o.threadId || 't2',
      mailbox: o.mailbox, fromName: null, fromEmail: o.mailbox,
      to: o.to || [], cc: o.cc || [], bcc: [], subject: 's', html: null, text: 't',
      resendId: o.resendId, receivedAt: o.receivedAt,
    });

  /* ---- C1 聚合来源：入站 from_email + 出站 to/cc ---- */
  section('C1 地址来源：入站 from_email + 出站 to_emails / cc');
  await inbound({ rowId: 'm1', resendId: 'r1', mailbox: 'inbox@me.com', fromName: 'Lili Wang', fromEmail: 'lili@partner.com', to: ['inbox@me.com'], receivedAt: 100 });
  await outbound({ mailbox: 'inbox@me.com', to: ['lili@partner.com'], receivedAt: 200, resendId: 'r2' });
  await inbound({ rowId: 'm3', resendId: 'r3', mailbox: 'inbox@me.com', fromName: 'Lili W. (new)', fromEmail: 'LILI@partner.com', to: ['inbox@me.com'], cc: ['boss@x.com'], receivedAt: 300 });
  await inbound({ rowId: 'm4', resendId: 'r4', mailbox: 'inbox@me.com', fromName: null, fromEmail: 'anon@x.com', to: ['inbox@me.com'], receivedAt: 400 });
  await outbound({ mailbox: 'billing@me.com', to: ['boss@x.com'], cc: ['anon@x.com'], receivedAt: 500, resendId: 'r5' });

  const list = await repo.contacts(env);
  ok(Array.isArray(list), '返回数组', typeof list);
  const emails = list.map((c) => c.email);
  ok(emails.length === 5, '恰好 5 个联系人（去重；自己的信箱不再被排除）', JSON.stringify(emails));
  ok(emails.includes('lili@partner.com') && emails.includes('boss@x.com') && emails.includes('anon@x.com'),
    '入站发件人 / 出站 to / 出站 cc 三种来源都进来了', JSON.stringify(emails));

  /* ---- C2 ⭐ 姓名取「最新一封**带姓名**的邮件」，出站的无姓名不能把姓名冲掉 ---- */
  section('C2 ⭐ 姓名取最新一封「带姓名」的邮件（出站邮件的 NULL 姓名不得覆盖）');
  const lili = list.find((c) => c.email === 'lili@partner.com');
  ok(!!lili, 'lili@partner.com 在列表里（否则下面的断言空转）', JSON.stringify(lili));
  ok(lili && lili.name === 'Lili W. (new)',
    '⭐ 姓名取最新一封带姓名的（m3, received_at=300），而不是被 m2 出站邮件的 NULL 冲掉',
    lili && JSON.stringify(lili.name));
  const anon = list.find((c) => c.email === 'anon@x.com');
  ok(anon && anon.name === null, '从来没有姓名往来的地址 name 为 null（不编造）', anon && JSON.stringify(anon.name));

  /* ---- C3 计数与排序 ---- */
  section('C3 往来次数与排序');
  ok(lili && lili.count === 3, 'lili 往来 3 次（m1 from + m2 to + m3 from）', lili && lili.count);
  ok(anon && anon.count === 2, 'anon 往来 2 次（m4 from + m5 cc）', anon && anon.count);
  ok(JSON.stringify(emails) === JSON.stringify(['inbox@me.com', 'lili@partner.com', 'anon@x.com', 'boss@x.com', 'billing@me.com']),
    '按次数降序，同次数按邮箱升序', JSON.stringify(emails));

  /* ---- C4 ⭐ 自己的收件信箱也要能联想（2026-10-03 行为变更）---- */
  section('C4 ⭐ 自己的收件信箱也进联想（用户明确要求「也可以给自己发」）');
  ok(emails.includes('inbox@me.com'), 'inbox@me.com 是自己的收件信箱 -> 仍然出现在联系人里', JSON.stringify(emails));
  ok(emails.includes('billing@me.com'), 'billing@me.com 同理不再被排除', JSON.stringify(emails));
  // 负控制：自己的信箱只是因为「有过往来」才进来，不能凭空给它编个姓名（它从来没有过 from_name）
  const inbox = list.find((c) => c.email === 'inbox@me.com');
  ok(inbox && inbox.name === null, '自己的信箱没有姓名往来 -> name 为 null（不编造）', inbox && JSON.stringify(inbox.name));

  /* ---- C5 ⭐ 负控制：json_each(NULL) 不得造出幽灵空地址 ---- */
  section('C5 ⭐ 负控制：不得出现空地址（json_each(NULL) 返回 1 行 value=NULL）');
  ok(emails.every((e) => typeof e === 'string' && e.trim() !== ''), '没有空串 / 纯空白地址', JSON.stringify(emails));
  ok(emails.length === 5, '总数没被幽灵行撑大', emails.length);

  /* ---- C6 大小写合并 + limit ---- */
  section('C6 大小写合并为一个联系人；limit 生效');
  ok(emails.filter((e) => e === 'lili@partner.com').length === 1,
    'LILI@partner.com 与 lili@partner.com 合并成一个小写地址（不重复出现）', JSON.stringify(emails));
  const two = await repo.contacts(env, 2);
  ok(two.length === 2, 'limit=2 -> 只返回 2 条', two.length);
  ok(JSON.stringify(two.map((c) => c.email)) === JSON.stringify(['inbox@me.com', 'lili@partner.com']),
    'limit 截取的是排序后的前 2 条', JSON.stringify(two.map((c) => c.email)));

  /* ---- C7 ⭐ 脏数据容错：非法 JSON 列不得让接口 500 ---- */
  section('C7 ⭐ 脏数据容错：to_emails/cc 是空串或 NULL 时不得抛 malformed JSON');
  // 真实成因：cc 列可空且无默认值，历史行/部分写入会留下 '' 或 NULL。
  // json_each('') 会**直接抛 malformed JSON**，且 WHERE 拦不住（表值函数在 JOIN 阶段求值），
  // 后果是整个 /api/contacts 返回 500 —— 前端联想功能整体不可用。
  const ins = (id, to, cc, receivedAt) =>
    db.prepare(
      `INSERT INTO messages (id, direction, mailbox, from_name, from_email, to_emails, cc,
         subject, body_text, received_at, status, read, starred, deleted, created_at, updated_at)
       VALUES (?, 'inbound', 'inbox@me.com', NULL, 'dirty@x.com', ?, ?, 's', 't', ?, 'received', 0, 0, 0, ?, ?)`
    ).run(id, to, cc, receivedAt, receivedAt, receivedAt);
  ins('dirty1', '', '', 600);        // 两列都是空串（非法 JSON）
  ins('dirty2', '[]', null, 610);    // to_emails 合法但 cc 是 NULL

  let dirty = null;
  let threw = null;
  try {
    dirty = await repo.contacts(env);
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  ok(threw === null, '⭐ 存在脏行时 contacts() 不抛异常（抛了就是线上 500）', threw);
  ok(Array.isArray(dirty), '脏行下仍返回数组', typeof dirty);
  const dirtyEmails = (dirty || []).map((c) => c.email);
  ok(dirtyEmails.includes('dirty@x.com'),
    '脏行的 from_email 仍被正常收进联系人（容错而非整表丢弃）', JSON.stringify(dirtyEmails));
  ok(dirtyEmails.every((e) => typeof e === 'string' && e.trim() !== ''),
    '脏行的空串 to_emails/cc 没有变成空地址联系人', JSON.stringify(dirtyEmails));
  ok(!dirtyEmails.includes('null'), 'NULL 列没有被拼成字符串 "null"', JSON.stringify(dirtyEmails));

  /* ---- 汇总 ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: src/repo.ts md5=${REPO_MD5}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试脚本异常：', e && e.stack ? e.stack : e);
  cleanup();
  process.exit(2);
});
