-- Resend 收件箱数据模型（Gmail 简化版）
-- 消息表：入站(收件)与出站(发送/回复)统一存放，direction 区分，文件夹=查询视图

CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,                 -- 内部主键 (uuid)
    direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    message_id    TEXT,                             -- RFC5322 Message-ID
    in_reply_to   TEXT,                             -- 原信 Message-ID (回信时填充)
    "references"  TEXT,                             -- 原始 References (线程归组用)
    thread_id     TEXT,                             -- 会话根 id（References 最根 token）
    mailbox       TEXT NOT NULL DEFAULT '',         -- 所属收件地址（如 support@example.com）
    from_name     TEXT,
    from_email    TEXT,
    to_emails     TEXT NOT NULL DEFAULT '[]',       -- JSON 数组；**入站=真实 To: 头**（修复前是投递地址，见 delivered_to）
    delivered_to  TEXT,                             -- JSON 数组；入站邮件的**投递地址（信封收件人）**，来自 Resend 的 to/received_for
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

CREATE INDEX IF NOT EXISTS idx_messages_inbox  ON messages(mailbox, deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent   ON messages(mailbox, deleted, received_at DESC) WHERE direction='outbound';
CREATE INDEX IF NOT EXISTS idx_messages_star   ON messages(deleted, received_at DESC, starred) WHERE starred=1;
CREATE INDEX IF NOT EXISTS idx_messages_trash  ON messages(deleted, received_at DESC) WHERE deleted=1;
CREATE INDEX IF NOT EXISTS idx_messages_resend ON messages(resend_id) WHERE resend_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox, received_at DESC);

-- 性能：让 /api/counts 与 /api/mailboxes 变成**纯索引扫描**，不再全表扫描并读取每行正文大字段
-- （实测 20000 行：计数 88ms → 4.6ms；账号分组 100ms → 4.0ms）
CREATE INDEX IF NOT EXISTS idx_messages_counts ON messages(mailbox, direction, deleted, read, starred);
-- 性能：「全部邮箱」视图没有 mailbox 条件，现有 idx_messages_inbox/sent 的前导列用不上，
-- 只能走临时 B 树排序；这两个索引让无 mailbox 条件时也能按 received_at DESC 有序取数
-- （实测 20000 行深翻页 5000：128ms → 0.5ms）
CREATE INDEX IF NOT EXISTS idx_messages_inbox_all ON messages(deleted, received_at DESC) WHERE direction='inbound';
CREATE INDEX IF NOT EXISTS idx_messages_sent_all  ON messages(deleted, received_at DESC) WHERE direction='outbound';

-- 同一封 Resend 收信(email_id)只入一条（并发/重复投递兜底）
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_inbound_resend ON messages(resend_id) WHERE direction='inbound' AND resend_id IS NOT NULL;

-- 出站发信额度统计（/api/usage）：按 received_at 统计「经本服务发出」的封数，走这个偏索引避免全表扫描。见 migrations/009_outbound_sent_index.sql。
CREATE INDEX IF NOT EXISTS idx_messages_outbound_sent ON messages(received_at) WHERE direction='outbound' AND resend_id IS NOT NULL;

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

-- Cloudflare 入向「绝不丢」索引（见 migrations/006_inbound_cf.sql）。
-- CF Email Routing 是路由器、**不存信**（对比 Resend 存 30 天可重拉），所以收到信的第一件事
-- 是把原始 .eml 流式落 R2 并在此登记，再入队异步解析 —— 任何时刻原始邮件都有持久副本。
CREATE TABLE IF NOT EXISTS inbound_raw (
    id           TEXT PRIMARY KEY,                  -- uuid；同时作为 Queue 指针与 webhook_deliveries 幂等 id
    r2_key       TEXT NOT NULL,                     -- 原始 .eml 的 R2 key
    from_email   TEXT,                              -- 信封发件人（SMTP MAIL FROM）
    to_email     TEXT,                              -- 信封收件人（投递地址）
    size         INTEGER NOT NULL DEFAULT 0,        -- 原始字节数（message.rawSize）
    message_id   TEXT,                              -- 头里的 Message-ID（去尖括号），仅用于诊断
    subject      TEXT,                              -- Subject 头（解析前就记下，供「入站异常」提示）
    received_at  INTEGER NOT NULL,
    parsed_at    INTEGER,                           -- 解析完成时间；NULL = 待解析
    message_row  TEXT,                              -- 解析后写入的 messages.id（幂等：非空=已入库）
    error        TEXT,                              -- 永久解析失败原因（原始件仍保留在 R2）
    attempts     INTEGER NOT NULL DEFAULT 0         -- 重试次数（瞬时失败）；超阈值后不再重试
);
CREATE INDEX IF NOT EXISTS idx_inbound_raw_pending ON inbound_raw(parsed_at, received_at) WHERE parsed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_raw_message_id ON inbound_raw(message_id) WHERE message_id IS NOT NULL;

-- 草稿箱（写了一半的邮件）。独立成表的原因见 migrations/005_drafts.sql。
-- 该表的列改动必须**同时**更新 005 迁移，保持「全量建库」与「增量升级」两条路径一致。
CREATE TABLE IF NOT EXISTS drafts (
    id          TEXT PRIMARY KEY,               -- uuid（前端生成，便于自动保存直接 upsert）
    mailbox     TEXT NOT NULL DEFAULT '',
    mode        TEXT NOT NULL DEFAULT 'new',    -- new | reply | forward
    source_id   TEXT,
    to_emails   TEXT NOT NULL DEFAULT '[]',
    cc          TEXT,
    bcc         TEXT,
    subject     TEXT,
    body_html   TEXT,
    body_text   TEXT,
    rich        INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_drafts_mailbox ON drafts(mailbox, updated_at DESC);

-- 用量统计缓存（前端显示 D1 / R2 占用百分比，提前知道何时该升级）。
-- 值是**估算**：D1 = 各表文本/二进制列的 UTF-8 字节和；R2 = 列举对象求和。见 src/repo.ts 的 getStorageUsage。
-- 直接实时算很贵（D1 全表扫描 / R2 列举按 Class A 计费），故按 TTL 缓存在这里。见 migrations/008_app_stats.sql。
CREATE TABLE IF NOT EXISTS app_stats (
    key        TEXT PRIMARY KEY,                    -- 如 'd1_bytes' / 'r2_bytes' / 'r2_objects'
    value      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
