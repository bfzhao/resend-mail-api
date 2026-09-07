-- Resend 收件箱数据模型（Gmail 简化版）
-- 消息表：入站(收件)与出站(发送/回复)统一存放，direction 区分，文件夹=查询视图

CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,                 -- 内部主键 (uuid)
    direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    message_id    TEXT,                             -- RFC5322 Message-ID
    in_reply_to   TEXT,                             -- 原信 Message-ID (回信时填充)
    "references"  TEXT,                             -- 原始 References (留线程扩展位)
    from_name     TEXT,
    from_email    TEXT,
    to_emails     TEXT NOT NULL DEFAULT '[]',       -- JSON 数组
    cc            TEXT,                             -- JSON 数组
    bcc           TEXT,                             -- JSON 数组
    reply_to      TEXT,                             -- JSON 数组
    subject       TEXT,
    body_html     TEXT,
    body_text     TEXT,
    received_at   INTEGER NOT NULL,                 -- 秒级 unix 时间戳 (排序键)
    status        TEXT NOT NULL DEFAULT 'received', -- inbound: received; outbound: queued/sent/delivered/bounced/failed
    resend_id     TEXT,                             -- outbound 由 Resend 返回的邮件 id (回执匹配)
    read          INTEGER NOT NULL DEFAULT 0,
    starred       INTEGER NOT NULL DEFAULT 0,
    deleted       INTEGER NOT NULL DEFAULT 0,       -- 软删除 -> 已删除文件夹
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_inbox  ON messages(deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent   ON messages(deleted, received_at DESC) WHERE direction='outbound';
CREATE INDEX IF NOT EXISTS idx_messages_star   ON messages(deleted, received_at DESC, starred) WHERE starred=1;
CREATE INDEX IF NOT EXISTS idx_messages_trash  ON messages(deleted, received_at DESC) WHERE deleted=1;
CREATE INDEX IF NOT EXISTS idx_messages_resend ON messages(resend_id) WHERE resend_id IS NOT NULL;

-- 附件元数据表（二进制内容在 R2）
CREATE TABLE IF NOT EXISTS attachments (
    id           TEXT PRIMARY KEY,                  -- uuid
    message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    r2_key       TEXT NOT NULL,                     -- attachments/{messageId}/{uuid}-{filename}
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size         INTEGER NOT NULL DEFAULT 0,
    inline       INTEGER NOT NULL DEFAULT 0,        -- 是否内联图片 (cid)
    content_id   TEXT,                              -- 规范化后的 cid (无尖括号)
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

-- 出站投递事件回执 (email.sent/delivered/bounced/failed, 可选)
CREATE TABLE IF NOT EXISTS delivery_events (
    id         TEXT PRIMARY KEY,                    -- svix 事件 id
    message_id TEXT NOT NULL,                       -- 关联 messages.id
    event_type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data       TEXT NOT NULL                        -- 原始 payload
);
CREATE INDEX IF NOT EXISTS idx_delivery_events_message ON delivery_events(message_id);

-- Webhook 幂等日志（Resend 会重试失败投递）
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           TEXT PRIMARY KEY,                  -- svix 事件 id
    processed_at INTEGER NOT NULL
);
