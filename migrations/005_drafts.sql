-- 草稿箱：写了一半、还没发出去的邮件。
--
-- 为什么不塞进 messages 表：
--   1) messages.direction 有 `CHECK (direction IN ('inbound','outbound'))`，
--      加 'draft' 需要重建整张表（SQLite 不能修改 CHECK 约束）；
--   2) 草稿没有投递语义 —— 没有 message_id / thread_id / status / resend_id，
--      混在一起会让**每一个**文件夹查询都不得不额外排除草稿行；
--   3) 草稿的主键由**前端生成**（打开写信弹窗时就有 id），自动保存走 upsert，
--      不需要「先创建再拿到 id」的往返。

CREATE TABLE IF NOT EXISTS drafts (
    id          TEXT PRIMARY KEY,               -- uuid（前端生成，便于自动保存直接 upsert）
    mailbox     TEXT NOT NULL DEFAULT '',       -- 发件身份（写信时「发件人」下拉的值）
    mode        TEXT NOT NULL DEFAULT 'new',    -- new | reply | forward（决定恢复时的标题与按钮）
    source_id   TEXT,                           -- 回复/转发时的原邮件 id
    to_emails   TEXT NOT NULL DEFAULT '[]',     -- JSON 数组
    cc          TEXT,                           -- JSON 数组，空为 NULL
    bcc         TEXT,                           -- JSON 数组，空为 NULL
    subject     TEXT,
    body_html   TEXT,
    body_text   TEXT,
    rich        INTEGER NOT NULL DEFAULT 0,     -- 正文是否为富文本模式（恢复时保持一致）
    updated_at  INTEGER NOT NULL,               -- 列表排序键（草稿按「最后修改」倒序）
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_mailbox ON drafts(mailbox, updated_at DESC);
