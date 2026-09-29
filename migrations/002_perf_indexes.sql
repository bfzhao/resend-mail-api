-- =============================================================================
-- 002_perf_indexes.sql —— 性能索引迁移（只对「已存在」的库生效）
--
-- 背景：schema.sql 里的 CREATE INDEX IF NOT EXISTS 只在**新建库**时执行；
--       已经建好的 D1 库不会自动补索引，必须手动跑本迁移。
--
-- 用法（本地）：
--   node node_modules/wrangler/bin/wrangler.js d1 execute resend-webhooks-db --local \
--     --file migrations/002_perf_indexes.sql
-- 用法（线上）：
--   node node_modules/wrangler/bin/wrangler.js d1 execute resend-webhooks-db --remote \
--     --file migrations/002_perf_indexes.sql
--
-- 幂等：全部带 IF NOT EXISTS，可重复执行。
--
-- 收益（20000 行合成数据、node:sqlite 实测，详见交付说明）：
--   GET /api/counts           88.4 ms → 4.6 ms（SCAN → COVERING INDEX）
--   GET /api/counts?mailbox=  64.7 ms → 1.7 ms
--   GET /api/mailboxes       100.0 ms → 4.0 ms（去掉 TEMP B-TREE FOR GROUP BY）
--   GET /api/folders/inbox 深翻页 128.5 ms → 0.5 ms（去掉 TEMP B-TREE FOR ORDER BY）
-- =============================================================================

-- 覆盖索引：让 /api/counts 与 /api/mailboxes 变成纯索引扫描，不再读正文大字段
CREATE INDEX IF NOT EXISTS idx_messages_counts ON messages(mailbox, direction, deleted, read, starred);

-- 「全部邮箱」视图专用：没有 mailbox 条件时也能直接按 received_at DESC 有序取数，避免临时 B 树排序
CREATE INDEX IF NOT EXISTS idx_messages_inbox_all ON messages(deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent_all  ON messages(deleted, received_at DESC) WHERE direction='outbound';
