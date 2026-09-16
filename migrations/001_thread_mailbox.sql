-- 迁移 001（老库一次性执行）：messages 增加 thread_id / mailbox
-- 新装库请直接使用根目录 schema.sql，无需执行本文件。
-- 用法: npm run db:migrate:up（先于基础迁移执行即可，本文件幂等地处理已建好的表）

ALTER TABLE messages ADD COLUMN thread_id TEXT;
ALTER TABLE messages ADD COLUMN mailbox TEXT NOT NULL DEFAULT '';

-- 重建依赖 mailbox 的列表索引（旧定义不含 mailbox）
DROP INDEX IF EXISTS idx_messages_inbox;
DROP INDEX IF EXISTS idx_messages_sent;
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(mailbox, deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent  ON messages(mailbox, deleted, received_at DESC) WHERE direction='outbound';
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox, received_at DESC);

-- 老邮件回填：thread_id 用自身 message_id（无引用历史则各自独立成会话）
UPDATE messages
   SET thread_id = message_id
 WHERE thread_id IS NULL OR thread_id = '';
