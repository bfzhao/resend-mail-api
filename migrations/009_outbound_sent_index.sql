-- 出站发信额度统计（/api/usage 的 resend.day / resend.month）：按 received_at 统计「经本服务发出」
-- （resend_id 非空）的封数。走这个偏索引可避免全表扫描。见 src/repo.ts 的 resendUsage。
CREATE INDEX IF NOT EXISTS idx_messages_outbound_sent ON messages(received_at) WHERE direction='outbound' AND resend_id IS NOT NULL;
