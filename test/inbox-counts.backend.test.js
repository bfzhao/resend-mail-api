'use strict';

/* =============================================================================
 * BUG-3b 后端聚合口径回归验证（真实 SQLite + 从 src/repo.ts 抽取的真实 SQL）
 *
 * 运行：
 *   node test/inbox-counts.backend.test.js
 *
 * 退出码：0 = 全部通过；1 = 存在失败；2 = 环境缺失（node:sqlite 不可用 / 源码抽取失败）。
 *
 * 为什么不用 tsc 编译 src/repo.ts：
 *   本机（受限沙箱）禁止 Node 派生任何子进程（spawnSync 直接 EBUSY），
 *   而 TS7 的 tsc 是原生可执行文件，必须由子进程启动，因此「编译后再 require」这条路
 *   在本环境跑不通。改为**从源码文本中抽取真实的 SQL 语句**（含 ${groupExpr} 的取值），
 *   用 Node 内置 node:sqlite 建真表、插真数据后原样执行。
 *   因此被测的是**真实 SQL 文本与真实 SQL 引擎语义**，只有「WHERE 片段如何拼装」
 *   这一层是按源码里出现的字面量重建的（下方每条都有抽取守卫，抽不到会明确失败）。
 *
 * 核心断言（需求规格）：
 *   给定一组构造数据（含一条 mailbox = '' 的邮件），
 *   「全部邮箱」的 inbox_total / inbox_unread / sent_total 必须等于各账号分组之和；
 *   并且每个分组的数字必须与该账号单独过滤时的计数一致。
 *
 * 注：「全部邮箱」被要求包含全部行（含 mailbox 为空/未知的行），
 *     否则这些邮件在 UI 上将不可达；这一点以独立于 SQL 的 JS 期望值显式断言。
 * ===========================================================================*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('node:sqlite 不可用（需要 Node >= 22.5）。', String(e && e.message));
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
// QA_REPO_TS 仅用于「变异验证」：指向一份人工构造的旧版/变体源码，确认本测试确实能抓到缺陷。
const REPO_TS = process.env.QA_REPO_TS || path.join(ROOT, 'src', 'repo.ts');
const SRC = fs.readFileSync(REPO_TS, 'utf8');
// 抽取用：统一换行符，避免 CRLF 影响按片段定位的逻辑
const SRC_LF = SRC.replace(/\r\n/g, '\n');
const REPO_MD5 = crypto.createHash('md5').update(SRC).digest('hex');

// A3：用 schema.sql 里 messages 表的**真实 DDL**建表，判定 mailboxes() 的 NULL 合并分支是否可达
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8');
const MESSAGES_DDL = (() => {
  const m = /CREATE TABLE IF NOT EXISTS messages \(([\s\S]*?)\n\);/.exec(SCHEMA_SRC);
  if (!m) throw new Error('源码抽取失败：schema.sql 里找不到 messages 建表语句');
  return `CREATE TABLE messages (${m[1]});`;
})();

/* ---------------------------------------------------------------------------
 * 从源码抽取真实 SQL 与相关字面量（抽不到就明确失败，绝不静默降级）
 * -------------------------------------------------------------------------*/

function must(re, label) {
  const m = re.exec(SRC_LF);
  if (!m) throw new Error(`源码抽取失败：${label}（正则 ${re} 未匹配）。src/repo.ts 结构可能已变化，需同步更新本测试。`);
  return m;
}

/**
 * 截取某个顶层函数/常量的源码片段，避免跨函数误匹配。
 *
 * 加固说明（第二轮）：
 *   旧实现用 `SRC_LF.indexOf('\n}\n', s)` 找函数结束位置 —— 只要有人把结束花括号写成
 *   `} `、或函数体里出现行首 `}`（模板字面量内），定位就会静默截错。
 *   现在改为两步：
 *     1) 起始位置 = anchor（函数体里第一条语句的唯一片段）之前最近的 `{`，从而跳过
 *        TS 返回类型里的对象类型字面量（例如 `Promise<Array<{ mailbox: string ... }>>`）；
 *     2) 结束位置 = 从该 `{` 起做**花括号配平扫描**，扫描时跳过字符串 / 模板 / 注释。
 *   不再依赖任何行号、缩进或 `\n}\n` 形态；anchor 抽不到会明确失败而不是静默降级。
 */
function sliceTopLevel(marker, anchor) {
  const s = SRC_LF.indexOf(marker);
  if (s < 0) throw new Error(`源码抽取失败：找不到 ${marker}`);
  const a = SRC_LF.indexOf(anchor, s);
  if (a < 0) throw new Error(`源码抽取失败：${marker} 之后找不到函数体锚点 ${JSON.stringify(anchor)}（函数结构可能已变化）`);
  const open = SRC_LF.lastIndexOf('{', a);
  if (open < s) throw new Error(`源码抽取失败：${marker} 与锚点 ${JSON.stringify(anchor)} 之间找不到 '{'`);
  let depth = 0;
  let mode = 'code'; // code | line | block | sq | dq | tpl
  for (let i = open; i < SRC_LF.length; i++) {
    const ch = SRC_LF[i];
    const nx = SRC_LF[i + 1];
    if (mode === 'code') {
      if (ch === '/' && nx === '/') { mode = 'line'; i++; continue; }
      if (ch === '/' && nx === '*') { mode = 'block'; i++; continue; }
      if (ch === "'") { mode = 'sq'; continue; }
      if (ch === '"') { mode = 'dq'; continue; }
      if (ch === '`') { mode = 'tpl'; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return SRC_LF.slice(s, i + 1); }
      continue;
    }
    if (mode === 'line') { if (ch === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (ch === '*' && nx === '/') { mode = 'code'; i++; } continue; }
    if (mode === 'sq' || mode === 'dq') {
      if (ch === '\\') { i++; continue; }
      if (ch === (mode === 'sq' ? "'" : '"')) mode = 'code';
      continue;
    }
    // tpl：模板字面量整体跳过（本文件的模板里只有 ${ident}，不含裸花括号）
    if (ch === '\\') { i++; continue; }
    if (ch === '`') mode = 'code';
  }
  throw new Error(`源码抽取失败：${marker} 的花括号不配平，无法确定结束位置`);
}

function mustIn(body, re, label) {
  const m = re.exec(body);
  if (!m) throw new Error(`源码抽取失败：${label}（正则 ${re} 未匹配）。src/repo.ts 结构可能已变化，需同步更新本测试。`);
  return m;
}

function extractSql() {
  const mbBody = sliceTopLevel('export async function mailboxes(', 'const groupExpr');
  const scBody = sliceTopLevel('export async function sidebarCounts(', 'const conds: string[] = []');
  const mcBody = sliceTopLevel('function mailboxCond(', 'if (mailbox === UNKNOWN_MAILBOX)');

  // 1) mailboxes() 的 GROUP BY 语句（含 ${groupExpr}）
  const groupsTemplate = mustIn(mbBody, /`([^`]*GROUP BY[^`]*)`/, 'mailboxes() 的 GROUP BY 模板')[1].replace(/\s+/g, ' ').trim();
  // 2) sidebarCounts() 的聚合语句（含 ${whereSql}）
  const countsTemplate = mustIn(scBody, /`([^`]*AS trash_total[^`]*)`/, 'sidebarCounts() 的聚合模板')[1].replace(/\s+/g, ' ').trim();
  // 3) groupExpr 的取值
  const groupExpr = mustIn(mbBody, /const\s+groupExpr\s*=\s*"([^"]*)"\s*;/, 'groupExpr 字面量')[1];
  // 4) 未知邮箱哨兵值（前后端共用）
  const unknownSentinel = must(/export\s+const\s+UNKNOWN_MAILBOX\s*=\s*'([^']*)'/, 'UNKNOWN_MAILBOX 字面量')[1];
  // 5) mailboxCond() 的两个 WHERE 字面量
  const sentinelWhere = mustIn(mcBody, /mailbox\s*===\s*UNKNOWN_MAILBOX\s*\)\s*return\s*\{\s*sql:\s*"([^"]*)"/, 'mailboxCond() 哨兵 WHERE')[1];
  const exactWhere = mustIn(mcBody, /return\s*\{\s*sql:\s*'([^']*)'\s*,\s*params:\s*\[\s*mailbox\s*\]\s*\}/, 'mailboxCond() 精确 WHERE')[1];
  // 6) mailboxes() 的 .bind(...) 实参（用于还原占位符参数）
  const bindArgsSrc = mustIn(mbBody, /\.bind\(([^)]*)\)/, 'mailboxes() 的 .bind 实参')[1];

  return { groupsTemplate, countsTemplate, groupExpr, unknownSentinel, sentinelWhere, exactWhere, bindArgsSrc };
}

function evalBindArgs(src, sentinel) {
  return src
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      if (s === 'UNKNOWN_MAILBOX') return sentinel;
      if (/^\d+$/.test(s)) return Number(s);
      const q = /^'([^']*)'$/.exec(s) || /^"([^"]*)"$/.exec(s);
      if (q) return q[1];
      throw new Error(`无法求值的 .bind 实参: ${s}`);
    });
}

function countPlaceholders(sql) {
  return (sql.match(/\?/g) || []).length;
}

function substitute(sql, map) {
  let out = sql;
  for (const [k, v] of Object.entries(map)) out = out.split('${' + k + '}').join(v);
  if (/\$\{/.test(out)) throw new Error(`SQL 中仍有未替换的插值: ${out}`);
  return out;
}

/* ---------------------------------------------------------------------------
 * SQLite + 假 D1（只把 SQL 原样转发给 SQLite，不实现任何业务聚合逻辑）
 * -------------------------------------------------------------------------*/

function makeFakeD1(db) {
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...a) { params = a; return stmt; },
        all() { return { results: db.prepare(sql).all(...params), success: true, meta: {} }; },
        first() {
          const row = db.prepare(sql).get(...params);
          return row === undefined ? null : row;
        },
        run() {
          const info = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: info.changes } };
        },
      };
      return stmt;
    },
  };
}

/* ---------------------------------------------------------------------------
 * 固定装置：必须包含一条 mailbox = '' 的邮件
 * -------------------------------------------------------------------------*/

const ROWS = [
  { id: 'm1', direction: 'inbound', mailbox: 'a@x.com', read: 0, starred: 0, deleted: 0 },
  { id: 'm2', direction: 'inbound', mailbox: 'a@x.com', read: 1, starred: 0, deleted: 0 },
  { id: 'm3', direction: 'outbound', mailbox: 'a@x.com', read: 1, starred: 0, deleted: 0 },
  { id: 'm4', direction: 'inbound', mailbox: 'b@x.com', read: 0, starred: 1, deleted: 0 },
  { id: 'm5', direction: 'outbound', mailbox: 'b@x.com', read: 1, starred: 0, deleted: 0 },
  { id: 'm6', direction: 'inbound', mailbox: '', read: 0, starred: 0, deleted: 0 }, // 关键：无 mailbox
  { id: 'm7', direction: 'outbound', mailbox: '', read: 1, starred: 0, deleted: 0 }, // 关键：无 mailbox
  { id: 'm8', direction: 'inbound', mailbox: 'a@x.com', read: 0, starred: 0, deleted: 1 }, // 已删除
];

function makeDb(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    mailbox TEXT,
    read INTEGER NOT NULL DEFAULT 0,
    starred INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    received_at INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'received',
    thread_id TEXT,
    subject TEXT,
    from_email TEXT,
    to_emails TEXT DEFAULT '[]',
    body_text TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  );`);
  const ins = db.prepare(
    'INSERT INTO messages (id, direction, mailbox, read, starred, deleted) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const r of rows) ins.run(r.id, r.direction, r.mailbox, r.read, r.starred, r.deleted);
  return db;
}

/* ---------------------------------------------------------------------------
 * 独立于 SQL 的 JS 期望值（真值来源：固定装置本身）
 * -------------------------------------------------------------------------*/

const isInbox = (r) => r.direction === 'inbound' && r.deleted === 0;
const isSent = (r) => r.direction === 'outbound' && r.deleted === 0;

const EXPECTED_ALL = {
  inbox_unread: ROWS.filter((r) => isInbox(r) && r.read === 0).length,
  inbox_total: ROWS.filter(isInbox).length,
  sent_total: ROWS.filter(isSent).length,
  starred_total: ROWS.filter((r) => r.starred === 1 && r.deleted === 0).length,
  trash_total: ROWS.filter((r) => r.deleted === 1).length,
};

const EXPECTED_GROUPS = (() => {
  const keys = [...new Set(ROWS.map((r) => r.mailbox))];
  return keys.map((k) => {
    const rows = ROWS.filter((r) => r.mailbox === k);
    return {
      key: k,
      inbox_unread: rows.filter((r) => isInbox(r) && r.read === 0).length,
      inbox_total: rows.filter(isInbox).length,
      sent_total: rows.filter(isSent).length,
    };
  });
})();

const EXPECTED_NON_EMPTY_SUM = EXPECTED_GROUPS
  .filter((g) => g.key !== '')
  .reduce((s, g) => s + g.inbox_total, 0);

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
  console.log(`  ${good ? 'PASS' : 'FAIL'}  ${msg}${detail === undefined ? '' : `  [${detail}]`}`);
}
function info(msg) { console.log(`  INFO  ${msg}`); }
async function test(name, fn) {
  currentTest = name;
  console.log(`\n=== ${name} ===`);
  try { await fn(); } catch (e) {
    ok(false, `用例抛出异常: ${e && e.message}`, e && e.stack ? String(e.stack).split('\n')[1].trim() : '');
  }
}
const triples = (arr) => arr.map((x) => [x.inbox_unread, x.inbox_total, x.sent_total].join('/')).sort();

/* ===========================================================================
 * 用例
 * ===========================================================================*/

(async function main() {
  console.log('BUG-3b 后端聚合口径 —— 独立验证（真实 SQLite 执行真实 SQL）');
  console.log(`被测版本: src/repo.ts md5=${REPO_MD5}  bytes=${Buffer.byteLength(SRC)}`);

  let sql;
  try {
    sql = extractSql();
  } catch (e) {
    console.error(`\n源码抽取失败：${e.message}`);
    console.error('=> 本测试无法覆盖真实 SQL 口径，按失败处理（不静默降级）。');
    const exitFile = path.join(os.tmpdir(), 'qa-inbox-counts.backend.exit');
    try { fs.writeFileSync(exitFile, '2', 'utf8'); } catch { /* ignore */ }
    process.exit(2);
  }

  // 组装三条待测 SQL（参数按源码中的字面量还原）
  const groupsParams = evalBindArgs(sql.bindArgsSrc, sql.unknownSentinel);
  const SQL_GROUPS = substitute(sql.groupsTemplate, { groupExpr: sql.groupExpr });
  const SQL_ALL = substitute(sql.countsTemplate, { whereSql: '' });
  const SQL_PER = (mailbox) => {
    const isSentinel = mailbox === sql.unknownSentinel;
    const where = isSentinel ? sql.sentinelWhere : substitute(sql.exactWhere, {});
    return {
      sql: substitute(sql.countsTemplate, { whereSql: `WHERE ${where}` }),
      params: isSentinel ? [] : [mailbox],
    };
  };

  console.log(`\n抽取到的 SQL：`);
  console.log(`  [groups] ${SQL_GROUPS}`);
  console.log(`  [groups params] ${JSON.stringify(groupsParams)}`);
  console.log(`  [all]    ${SQL_ALL}`);
  console.log(`  [per]    ${SQL_PER('a@x.com').sql}  params=${JSON.stringify(['a@x.com'])}`);
  console.log(`  [sentinel] ${sql.unknownSentinel}  where=${sql.sentinelWhere}`);

  const db = makeDb(ROWS);
  const env = { DB: makeFakeD1(db) };

  // SUM 在零行时返回 NULL，src/repo.ts 用 `?? 0` 归一化（该归一化的存在性由 T6 源码级断言守住）。
  const norm = (v) => (v === null || v === undefined ? 0 : v);
  const readCounts = (q, params = []) => {
    const row = db.prepare(q).get(...params) || {};
    return {
      inbox_unread: norm(row.inbox_unread),
      inbox_total: norm(row.inbox_total),
      sent_total: norm(row.sent_total),
      starred_total: norm(row.starred_total),
      trash_total: norm(row.trash_total),
    };
  };
  const readGroups = () =>
    db.prepare(SQL_GROUPS).all(...groupsParams).map((r) => ({
      mailbox: r.mailbox,
      inbox_unread: norm(r.inbox_unread),
      inbox_total: norm(r.inbox_total),
      sent_total: norm(r.sent_total),
    }));

  /* ---- T0 环境自检 ---- */
  await test('T0 测试环境自检（harness 可信度）', async () => {
    ok(SQL_GROUPS.includes('GROUP BY'), '抽取到的分组 SQL 含 GROUP BY');
    ok(/SUM\s*\(\s*CASE WHEN/i.test(SQL_GROUPS), '抽取到的分组 SQL 含 SUM(CASE WHEN ...) 聚合');
    ok(/SUM\s*\(\s*CASE WHEN/i.test(SQL_ALL), '抽取到的全部邮箱 SQL 含 SUM(CASE WHEN ...) 聚合');
    ok(countPlaceholders(SQL_GROUPS) === groupsParams.length,
      '分组 SQL 的占位符数量与 .bind 实参数量一致',
      `${countPlaceholders(SQL_GROUPS)} vs ${groupsParams.length}`);
    ok(groupsParams.length >= 1 && groupsParams.every((p) => p === sql.unknownSentinel),
      '分组 SQL 的参数为未知邮箱哨兵', JSON.stringify(groupsParams));
    ok(ROWS.some((r) => r.mailbox === ''), '固定装置包含 mailbox = \'\' 的邮件（口径差异的必要条件）');
    ok(EXPECTED_ALL.inbox_total > EXPECTED_NON_EMPTY_SUM,
      '自检：若忽略空 mailbox 分组，总和会小于「全部邮箱」（证明该数据能暴露 BUG-3b）',
      `all=${EXPECTED_ALL.inbox_total} vs 非空分组之和=${EXPECTED_NON_EMPTY_SUM}`);
    ok(SRC.includes('?? 0'), '源码保留了 null -> 0 归一化（SUM 在零行时返回 NULL）');
    const row = db.prepare(SQL_ALL).get();
    info(`SQL_ALL 原始返回 = ${JSON.stringify(row)}`);
    ok(row && row.inbox_total > 0, 'SQL 确实在真实 SQLite 上执行并返回非零结果（非空转）', row && row.inbox_total);
  });

  /* ---- T1 sidebarCounts(全部邮箱) 与独立 JS 期望值一致 ---- */
  await test('T1 全部邮箱聚合：覆盖全部行（含空 mailbox）', async () => {
    const all = readCounts(SQL_ALL);
    info(`实际 = ${JSON.stringify(all)}`);
    info(`期望 = ${JSON.stringify(EXPECTED_ALL)}（独立 JS 计算，不依赖被测 SQL）`);
    ok(all.inbox_unread === EXPECTED_ALL.inbox_unread, 'inbox_unread 与独立期望一致', `${all.inbox_unread} vs ${EXPECTED_ALL.inbox_unread}`);
    ok(all.inbox_total === EXPECTED_ALL.inbox_total, 'inbox_total 与独立期望一致', `${all.inbox_total} vs ${EXPECTED_ALL.inbox_total}`);
    ok(all.sent_total === EXPECTED_ALL.sent_total, 'sent_total 与独立期望一致', `${all.sent_total} vs ${EXPECTED_ALL.sent_total}`);
    ok(all.starred_total === EXPECTED_ALL.starred_total, 'starred_total 与独立期望一致', `${all.starred_total} vs ${EXPECTED_ALL.starred_total}`);
    ok(all.trash_total === EXPECTED_ALL.trash_total, 'trash_total 与独立期望一致', `${all.trash_total} vs ${EXPECTED_ALL.trash_total}`);
  });

  /* ---- T2 mailboxes() 分组必须覆盖空 mailbox ---- */
  await test('T2 分组聚合：分组口径必须覆盖全部行', async () => {
    const list = readGroups();
    info(`实际分组 = ${JSON.stringify(list)}`);
    info(`期望分组 = ${JSON.stringify(EXPECTED_GROUPS)}（共 ${EXPECTED_GROUPS.length} 组）`);
    ok(list.length === EXPECTED_GROUPS.length, `分组数量与期望一致（${list.length} vs ${EXPECTED_GROUPS.length}）`, list.length);
    ok(JSON.stringify(triples(list)) === JSON.stringify(triples(EXPECTED_GROUPS)),
      '各分组的 (unread/total/sent) 组合与独立期望一致',
      `实际=${JSON.stringify(triples(list))} 期望=${JSON.stringify(triples(EXPECTED_GROUPS))}`);
  });

  /* ---- T3 核心不变量：各账号之和 === 全部邮箱 ---- */
  await test('T3 「全部邮箱」必须等于各账号分组之和（BUG-3b 核心）', async () => {
    const all = readCounts(SQL_ALL);
    const list = readGroups();
    const sum = list.reduce(
      (acc, m) => ({
        inbox_unread: acc.inbox_unread + m.inbox_unread,
        inbox_total: acc.inbox_total + m.inbox_total,
        sent_total: acc.sent_total + m.sent_total,
      }),
      { inbox_unread: 0, inbox_total: 0, sent_total: 0 }
    );
    info(`全部邮箱 = ${JSON.stringify({ inbox_unread: all.inbox_unread, inbox_total: all.inbox_total, sent_total: all.sent_total })}`);
    info(`各账号之和 = ${JSON.stringify(sum)}`);
    ok(all.inbox_unread === sum.inbox_unread, 'inbox_unread：全部邮箱 === 各账号之和', `${all.inbox_unread} vs ${sum.inbox_unread}`);
    ok(all.inbox_total === sum.inbox_total, 'inbox_total：全部邮箱 === 各账号之和', `${all.inbox_total} vs ${sum.inbox_total}`);
    ok(all.sent_total === sum.sent_total, 'sent_total：全部邮箱 === 各账号之和', `${all.sent_total} vs ${sum.sent_total}`);
  });

  /* ---- T4 下拉里每个账号的数字必须等于「按该账号过滤」的计数 ---- */
  await test('T4 每个分组的数字必须与该账号单独过滤的计数一致', async () => {
    const list = readGroups();
    for (const m of list) {
      const q = SQL_PER(m.mailbox);
      const per = readCounts(q.sql, q.params);
      ok(m.inbox_unread === per.inbox_unread && m.inbox_total === per.inbox_total && m.sent_total === per.sent_total,
        `账号「${m.mailbox}」的分组计数 === 该账号过滤计数`,
        `分组=${m.inbox_unread}/${m.inbox_total}/${m.sent_total} 过滤=${per.inbox_unread}/${per.inbox_total}/${per.sent_total}`);
    }
  });

  /* ---- T5 单个账号过滤（回归：不要为了凑等式把过滤改坏） ---- */
  await test('T5 单个账号过滤仍然正确', async () => {
    for (const g of EXPECTED_GROUPS.filter((x) => x.key !== '')) {
      const q = SQL_PER(g.key);
      const per = readCounts(q.sql, q.params);
      ok(per.inbox_unread === g.inbox_unread && per.inbox_total === g.inbox_total && per.sent_total === g.sent_total,
        `按账号 '${g.key}' 过滤结果正确`,
        `实际=${per.inbox_unread}/${per.inbox_total}/${per.sent_total} 期望=${g.inbox_unread}/${g.inbox_total}/${g.sent_total}`);
    }
    const q = SQL_PER('ghost@x.com');
    const ghost = readCounts(q.sql, q.params);
    ok(ghost.inbox_unread === 0 && ghost.inbox_total === 0 && ghost.sent_total === 0,
      '不存在的账号过滤结果全为 0', JSON.stringify(ghost));
  });

  /* ---- T6 空库：SUM 返回 NULL，源码必须归一化为 0 ---- */
  await test('T6 空库边界：SUM 返回 NULL，函数层需归一化为 0', async () => {
    const empty = makeDb([]);
    const raw = empty.prepare(SQL_ALL).get();
    info(`空库 SQL_ALL 原始返回 = ${JSON.stringify(raw)}`);
    ok(raw.inbox_total === null || raw.inbox_total === undefined,
      'SQLite 语义确认：零行时 SUM 返回 NULL（这正是源码 `?? 0` 存在的原因）', JSON.stringify(raw));
    ok((SRC.match(/\?\?\s*0/g) || []).length >= 5,
      '源码对 5 个计数字段都做了 `?? 0` 归一化（源码级检查，未执行函数体）',
      (SRC.match(/\?\?\s*0/g) || []).length);
    try { empty.close(); } catch { /* ignore */ }
  });

  /* ---- T7 mailboxes() 对 mailbox='' 的真实返回：'' / null / 哨兵？ ---- */
  await test("T7 mailboxes() 对 mailbox='' 的真实返回（判定合并分支是否可达）", async () => {
    const db7 = makeDb(ROWS);
    const raw = db7.prepare(SQL_GROUPS).all(...groupsParams);
    info(`SQL_GROUPS 返回的 mailbox 列 = ${JSON.stringify(raw.map((r) => r.mailbox))}`);
    const emptyValued = raw.filter((r) => r.mailbox === '' || r.mailbox === null);
    const sentinelRows = raw.filter((r) => r.mailbox === sql.unknownSentinel);
    ok(sentinelRows.length === 1,
      "mailbox='' 的分组在 SELECT 里已被归一化为哨兵（恰好 1 行）", sentinelRows.length);
    ok(emptyValued.length === 0,
      "返回结果里不存在 '' 或 null 的 mailbox 值（SELECT 的 CASE 已生效，不是靠 JS 合并兜的）",
      JSON.stringify(raw.map((r) => r.mailbox)));
    info('结论：在真实 SQL 上，空 mailbox 已经在 SQL 层变成哨兵，JS 层的 `r.mailbox === \'\'` 分支收不到这种输入。');
    try { db7.close(); } catch { /* ignore */ }
  });

  /* ---- T8 schema 的 NOT NULL 是否使 :212-232 的 NULL 合并分支成为死代码 ---- */
  await test('T8 NULL 分支可达性：schema 的 mailbox NOT NULL 是否让合并逻辑成为死代码', async () => {
    ok(/mailbox\s+TEXT\s+NOT NULL\s+DEFAULT\s+''/i.test(MESSAGES_DDL),
      "前提：schema.sql 里 mailbox 定义为 TEXT NOT NULL DEFAULT ''");
    const DDL_NULLABLE = MESSAGES_DDL.replace(/mailbox\s+TEXT\s+NOT NULL\s+DEFAULT\s+''/i, 'mailbox TEXT');
    ok(DDL_NULLABLE !== MESSAGES_DDL, '成功构造出 mailbox 可空的对照表（替换命中）');

    // 8.1 真实 schema：NULL 必须被约束拒绝
    const dbReal = new DatabaseSync(':memory:');
    dbReal.exec(MESSAGES_DDL);
    let threw = null;
    try {
      dbReal.prepare('INSERT INTO messages (id, direction, mailbox, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run('n1', 'inbound', null, 1, 1, 1);
    } catch (e) { threw = e; }
    ok(!!threw && /NOT NULL/i.test(String(threw.message)),
      '真实 schema 下插入 mailbox = NULL 被 NOT NULL 约束拒绝（NULL 不可能入库）',
      threw ? String(threw.message) : '居然插入成功了');
    try { dbReal.close(); } catch { /* ignore */ }

    // 8.2 可空对照表：'' 与 NULL 会各产生一行哨兵 —— 这正是 JS 合并逻辑存在的意义
    const dbNull = new DatabaseSync(':memory:');
    dbNull.exec(DDL_NULLABLE);
    const ins = dbNull.prepare('INSERT INTO messages (id, direction, mailbox, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?)');
    ins.run('e1', 'inbound', '', 1, 1, 1);     // 空串
    ins.run('e2', 'inbound', null, 2, 1, 1);   // NULL（可空表才允许）
    const rows = dbNull.prepare(SQL_GROUPS).all(...groupsParams);
    info(`可空表下 SQL_GROUPS 返回 = ${JSON.stringify(rows.map((r) => r.mailbox))}`);
    const sentinelRows = rows.filter((r) => r.mailbox === sql.unknownSentinel);
    ok(sentinelRows.length === 2,
      "可空表下 '' 与 NULL 各产生一行哨兵（若真存在 NULL，JS 合并就是必要的）", sentinelRows.length);
    ok(sentinelRows.reduce((a, r) => a + (r.inbox_total || 0), 0) === 2,
      '两行哨兵合计覆盖 2 封邮件（合并后语义才正确）', sentinelRows.reduce((a, r) => a + (r.inbox_total || 0), 0));
    try { dbNull.close(); } catch { /* ignore */ }

    info('结论：schema.sql 的 NOT NULL 使 NULL 不可能入库 → :212-232 里 `r.mailbox === null` 分支不可达；');
    info("      同时 '' 已在 SELECT 的 CASE 里归一化为哨兵 → `r.mailbox === ''` 分支也收不到输入。");
    info('      => 在当前 schema + 当前 SQL 下，该合并逻辑是**防御性死代码**（无害，不建议删除）。');
  });

  /* ---- 汇总 ---- */
  console.log('\n================ 失败用例清单 ================');
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) console.log('（无）');
  else for (const f of failed) console.log(`- [${f.test}] ${f.msg}${f.detail !== undefined ? `  [${f.detail}]` : ''}`);

  console.log(`\n被测版本: src/repo.ts md5=${REPO_MD5}`);
  console.log(`===== 结果: ${pass} passed, ${fail} failed =====`);

  const exitCode = fail ? 1 : 0;
  const exitFile = path.join(os.tmpdir(), 'qa-inbox-counts.backend.exit');
  try {
    fs.writeFileSync(exitFile, String(exitCode), 'utf8');
    console.log(`退出码已写入: ${exitFile} = ${exitCode}`);
  } catch (e) {
    console.log(`退出码文件写入失败: ${e.message}`);
  }

  try { db.close(); } catch { /* ignore */ }
  process.exit(exitCode);
})();
