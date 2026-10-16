-- 006：入向从 Resend 迁到 Cloudflare Email Routing —— 「绝不丢」索引表
--
-- 背景：CF Email Routing 是**路由器、不是邮箱**，官方不存收到的邮件、也没有任何接口能重拉
-- （对比 Resend 存 30 天并支持 retrieve-received-email）。因此入向的第一优先级不是「解析好」
-- 而是「**绝不丢**」：收到信先落原始副本，解析失败也有兜底。
--
-- 流程（`src/inbound-email.ts`）：
--   1. `email()`：读头 + 把 `message.raw` **流式**落 R2（不整读进内存）+ 在此表登记一行 + 入队（只发 id 指针）
--   2. `queue()`：从 R2 取原始件 → postal-mime 解析 → 复用现有 saveInbound 写入 messages/attachments
--      → 回填 parsed_at / message_row
--
-- 幂等：`id` 同时用作 webhook_deliveries 的幂等 id（saveInbound 内部 INSERT OR IGNORE）；
-- `message_row` 非空即表示已入库，重复投递（Queue 至少一次）直接跳过。
--
-- 本表**纯新增**，不改动 messages/attachments 任何列 —— 历史数据与 Resend 入向路径（/webhook/inbound）完全不受影响。

CREATE TABLE IF NOT EXISTS inbound_raw (
    id           TEXT PRIMARY KEY,                  -- uuid；同时作为 Queue 指针与 webhook_deliveries 幂等 id
    r2_key       TEXT NOT NULL,                     -- 原始 .eml 的 R2 key
    from_email   TEXT,                              -- 信封发件人（SMTP MAIL FROM）
    to_email     TEXT,                              -- 信封收件人（投递地址）
    size         INTEGER NOT NULL DEFAULT 0,        -- 原始字节数
    message_id   TEXT,                              -- 头里的 Message-ID（去尖括号），仅用于诊断
    received_at  INTEGER NOT NULL,
    parsed_at    INTEGER,                           -- 解析完成时间；NULL = 待解析
    message_row  TEXT,                              -- 解析后写入的 messages.id（幂等：非空=已入库）
    error        TEXT,                              -- 永久解析失败原因（原始件仍保留在 R2）
    attempts     INTEGER NOT NULL DEFAULT 0         -- 重试次数（瞬时失败）；超阈值后不再重试
);
CREATE INDEX IF NOT EXISTS idx_inbound_raw_pending ON inbound_raw(parsed_at, received_at) WHERE parsed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_raw_message_id ON inbound_raw(message_id) WHERE message_id IS NOT NULL;
