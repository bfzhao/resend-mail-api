-- 004：区分「真实 To: 头」与「投递地址（信封收件人）」
--
-- 背景（生产数据实测）：Resend 收信接口的 `to` 字段返回的是**投递地址**，不是 `To:` 头。
-- 例：发件人 zhanglili@notionmanager.com → To: lara@realmarketlabs.com，Cc: bingfeng@notionmanager.com，
-- 这封信在 bingfeng 的收件箱里落成 `to = ["bingfeng@notionmanager.com"]`、`cc = ["bingfeng@notionmanager.com"]`。
-- 真实 To 头只保留在 `headers.to` 里。此前 `to_emails` 直接存了投递地址，导致详情页
-- 「收件人」显示成用户自己。
--
-- 修复后：
--   * `to_emails`    = 真实 `To:` 头（取不到时回退投递地址，行为不倒退）
--   * `delivered_to` = 投递地址（信封收件人），始终写入
--
-- 历史行 `delivered_to` 为 NULL —— 前端据此判定该行是「修复前入库」，
-- 展示收件人时把投递地址减去 cc/bcc（避免把自己标成收件人）。

ALTER TABLE messages ADD COLUMN delivered_to TEXT;
