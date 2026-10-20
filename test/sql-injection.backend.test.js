'use strict';

/* =========================================================
 * SQL injection corpus (zero deps: node test/sql-injection.backend.test.js)
 *
 * The database layer must never build SQL from a *value*. Every path that stores or filters user/mail data is checked
 * here with the classic hostile payloads (quote breakouts, stacked statements, comment terminators, LIKE wildcards,
 * identifiers, unicode) and the assertions are:
 *
 *   · the text is stored and read back **byte for byte** (so it was bound, not pasted into the statement),
 *   · no table is dropped or altered (a successful injection would show up as missing data / a missing table),
 *   · filters treat the payload as data (no "return everything" wildcard escape).
 *
 * It also guards the few places where an identifier *is* interpolated: `sqlIdentifier()` must reject anything that is
 * not a plain SQL identifier.
 * ========================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

let pass = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log(`  PASS  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
  else { failures.push(msg); console.log(`  FAIL  ${msg}${detail !== undefined ? `  [${detail}]` : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-injection-'));
const OUT = path.join(WORK, 'build');

function build() {
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const srcCopy = path.join(WORK, 'src');
  fs.mkdirSync(srcCopy, { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(WORK, 'node_modules'), 'junction');
  for (const name of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (name.endsWith('.ts')) fs.copyFileSync(path.join(ROOT, 'src', name), path.join(srcCopy, name));
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
  delete cfg.include;
  delete cfg.exclude;
  cfg.files = fs.readdirSync(srcCopy).filter((x) => x.endsWith('.ts')).map((x) => path.join(srcCopy, x));
  cfg.compilerOptions = Object.assign({}, cfg.compilerOptions, { noEmit: false, module: 'commonjs', outDir: OUT, rootDir: srcCopy });
  const cfgPath = path.join(WORK, 'tsconfig.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [tsc, '-p', cfgPath], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('tsc 编译失败(exit=' + r.status + '): ' + ((r.stdout || '') + (r.stderr || '')).trim());
}

try {
  build();
} catch (e) {
  console.error(`\n编译失败，无法继续：${e.message}`);
  console.error('（受限沙箱下请加 tsc 垫片：NODE_OPTIONS="--require <临时目录>/mm-tsc-shim.js"）');
  process.exit(2);
}

const repo = require(path.join(OUT, 'repo.js'));

/* ---- a real SQLite database with the real schema, plus the D1 surface repo.ts uses ---- */
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

const norm = (a) => a.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
function makeD1() {
  const prepare = (sql) => {
    const db = sqlite;
    const st = {
      args: [],
      bind(...a) { st.args = norm(a); return st; },
      async run() { const r = db.prepare(sql).run(...st.args); return { success: true, results: [], meta: { changes: Number(r.changes) } }; },
      async first() { const row = db.prepare(sql).get(...st.args); return row === undefined ? null : row; },
      async all() { return { results: db.prepare(sql).all(...st.args), success: true, meta: {} }; },
    };
    return st;
  };
  return {
    prepare,
    batch: async (arr) => { for (const s of arr) await s.run(); return []; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    query: (sql, ...a) => sqlite.prepare(sql).all(...norm(a)),
    queryOne: (sql, ...a) => { const r = sqlite.prepare(sql).get(...norm(a)); return r === undefined ? null : r; },
  };
}

const puts = { put: async () => ({ key: 'x' }), get: async () => null, delete: async () => undefined, list: async () => ({ objects: [] }) };
const db = makeD1();
const env = { DB: db, BUCKET: puts, RESEND_API_KEY: 're_test_key' };

/* hostile payloads: a quote breakout, a stacked statement, a comment terminator, a LIKE wildcard, an identifier, unicode */
const PAYLOADS = [
  "'; DROP TABLE messages; --",
  '" OR 1=1 --',
  "x'); DELETE FROM domains WHERE ('1'='1",
  "\\'; UPDATE messages SET read = 1; --",
  '%',
  '_%_',
  'a" || "b',
  '名字 with 😀 and ünïcode',
];

const tables = () => sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
const baselineTables = tables().join(',');

(async () => {
  console.log('SQL 注入语料 —— 值必须被绑定、标识符必须被拒绝');

  section('I1 入站邮件：字段里塞注入串，必须原样存回');
  for (let i = 0; i < PAYLOADS.length; i++) {
    const p = PAYLOADS[i];
    const before = sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    await repo.saveInbound(
      env,
      {
        rowId: `row-${i}`,
        resendId: null,
        messageId: `<${i}@example.com>`,
        inReplyTo: null,
        references: null,
        threadId: `row-${i}`,
        mailbox: `inbox@example.com`,
        fromName: p,
        fromEmail: 'evil@example.com',
        to: ['inbox@example.com'],
        deliveredTo: null,
        cc: [],
        bcc: [],
        replyTo: [],
        subject: p,
        html: `<p>${p}</p>`,
        text: p,
        receivedAt: 1700000000 + i,
        attachments: [],
        rawSize: 10,
      },
      `evt-${i}`
    );
    const row = db.queryOne('SELECT subject, from_name, body_text FROM messages WHERE id = ?', `msg-row-${i}`) ||
      db.queryOne('SELECT subject, from_name, body_text FROM messages WHERE thread_id = ?', `row-${i}`);
    const after = sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    ok(after === before + 1, `payload #${i} 只插入一行`, `${before}->${after}`);
    ok(!!row, `payload #${i} 能读回这一行`);
    if (row) {
      ok(String(row.subject) === p, `⭐ payload #${i} 的 subject 原样存回`, JSON.stringify(row.subject).slice(0, 40));
      ok(String(row.from_name) === p, `⭐ payload #${i} 的 from_name 原样存回`, JSON.stringify(row.from_name).slice(0, 40));
    }
  }
  ok(tables().join(',') === baselineTables, '⭐ 表结构没有变化（没有 DROP/ALTER）', tables().length);

  section('I2 搜索：注入串只当普通文本（不会变成通配/OR 1=1）');
  const totalInbox = (await repo.listFolder(env, { folder: 'inbox', limit: 50, offset: 0 })).total;
  for (const p of ["' OR 1=1 --", "'; DROP TABLE messages; --", '%', '_']) {
    const res = await repo.listFolder(env, { folder: 'inbox', q: p, limit: 50, offset: 0 });
    // A wildcard would sweep every stored message; a literal search can only return rows whose text really contains the term.
    const allContain = res.items.every((it) =>
      [it.subject, it.from_name, it.from_email, it.body_text, it.to_emails].some((v) => String(v ?? '').includes(p))
    );
    ok(allContain && res.total < totalInbox, `⭐ q = ${JSON.stringify(p)} 按字面量匹配（不是通配）`, `${res.total}/${totalInbox}`);
  }
  // 反例：确实存在 '%' 与 '_%_' 两封，所以搜 '%' 命中 2 封（说明是子串匹配，而不是"全返回"）
  const pct = await repo.listFolder(env, { folder: 'inbox', q: '%', limit: 50, offset: 0 });
  ok(pct.total === 2 && pct.total < totalInbox, '⭐ 搜 % 只命中含字面量 % 的两封', `${pct.total}/${totalInbox}`);
  ok(tables().join(',') === baselineTables, '搜索之后表结构仍然完整');

  section('I3 域名 / 邮箱 / 文件夹参数');
  const weirdDomain = "' OR '1'='1";
  const all = await repo.listFolder(env, { folder: 'inbox', domain: weirdDomain, limit: 50, offset: 0 });
  ok(all.items.length === 0, '⭐ 域名里的注入串不会把全部邮件捞出来', all.items.length);
  const unread = await repo.domainUnreadCounts(env);
  ok(typeof unread === 'object', 'domainUnreadCounts 不报错', JSON.stringify(unread).slice(0, 60));

  section('I4 草稿 / 已读 / 星标 / 删除：写路径同样是绑定');
  const draftId = 'draft-inject';
  await repo.upsertDraft(env, {
    id: draftId,
    mailbox: 'inbox@example.com',
    mode: 'new',
    sourceId: null,
    to: ["a@b.com'; DROP TABLE drafts; --"],
    cc: [],
    bcc: [],
    subject: "'; DELETE FROM drafts; --",
    html: '<p>%_</p>',
    text: '%_',
    rich: false,
  });
  const draft = db.queryOne('SELECT subject, body_text, body_html, to_emails FROM drafts WHERE id = ?', draftId);
  ok(!!draft && String(draft.subject) === "'; DELETE FROM drafts; --", '⭐ 草稿主题原样存回', draft && String(draft.subject).slice(0, 30));
  ok(!!draft && String(draft.body_text) === '%_', '⭐ 草稿正文原样存回', draft && String(draft.body_text));
  ok(!!draft && String(draft.to_emails).includes("a@b.com'; DROP TABLE drafts; --"), '⭐ 收件人原样存回（JSON 列）', draft && String(draft.to_emails).slice(0, 40));
  ok(tables().includes('drafts'), 'drafts 表仍在');

  const someId = db.queryOne('SELECT id FROM messages LIMIT 1').id;
  const flagFn = repo.setMessagesFlag || repo.batchSetFlag || repo.updateMessagesFlag;
  if (typeof flagFn === 'function') {
    await flagFn(env, [someId], 'star', 1).catch(() => null);
    ok(tables().join(',') === baselineTables, '批量修改后表结构完整');
    const starred = db.queryOne('SELECT starred FROM messages WHERE id = ?', someId);
    ok(starred && Number(starred.starred) === 1, '批量修改确实生效（绑定参数而不是拼 SQL）', starred && starred.starred);
  } else {
    ok(true, '（该版本没有批量修改导出，跳过）');
  }

  section('I5 标识符守卫：不是合法标识符一律拒绝');
  ok(repo.sqlIdentifier('messages') === '"messages"', '合法表名通过', repo.sqlIdentifier('messages'));
  ok(repo.sqlIdentifier('body_text') === '"body_text"', '合法列名通过');
  for (const bad of ['messages; DROP TABLE x', 'a b', 'x"y', "x'y", '1abc', '', 'a.b']) {
    let threw = false;
    try { repo.sqlIdentifier(bad); } catch { threw = true; }
    ok(threw, `⭐ 拒绝非法标识符 ${JSON.stringify(bad)}`);
  }

  section('I6 设置写入：Key / 发件地址里带引号');
  await repo.upsertDomain(env, {
    domain: 'inject.com',
    fromAddress: "x@inject.com'; DROP TABLE domains; --",
    fromName: "'; DELETE FROM domains; --",
    resendApiKey: 're_key_with_quote\'',
    enabled: true,
  });
  const domRow = db.queryOne("SELECT from_address, from_name, resend_api_key FROM domains WHERE domain = 'inject.com'");
  ok(!!domRow && String(domRow.from_address) === "x@inject.com'; DROP TABLE domains; --", '⭐ from_address 原样存回',
    domRow && String(domRow.from_address).slice(0, 40));
  ok(!!domRow && String(domRow.from_name) === "'; DELETE FROM domains; --", '⭐ from_name 原样存回');
  ok(tables().includes('domains'), 'domains 表仍在');

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log(`\n===== 结果: ${pass} passed, ${failures.length} failed =====`);
  if (failures.length) console.log(`失败项：\n- ${failures.join('\n- ')}`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('测试运行异常：', e);
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(1);
});
