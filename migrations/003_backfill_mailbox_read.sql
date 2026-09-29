-- 003：修复历史数据（幂等，可重复执行）
--
-- 背景（2026-09-29 线上实测）：
--   ① 11 封实际属于 support@notionmanager.com 的邮件 mailbox 为空串，
--      在侧边栏被归入「(未识别)」分组。根因是 pickMailbox() 里手写的
--      Array.isArray(data.to) 判断不认字符串形态的 to（已修，见 src/webhook.ts）。
--   ② 全部 29 封出站邮件 read=0，在发件箱显示未读且点开也不变。
--      根因是 insertMessageStmt 把 read 硬编码为 0（已修，见 src/repo.ts）。
--
-- 本迁移只修**已有数据**；新数据由上面的两处代码修复保证。
-- 全部语句都带 WHERE 条件，重复执行是 no-op。

-- ① 入站：mailbox 为空时，用 to_emails 的第一个地址回填
UPDATE messages
   SET mailbox = lower(json_extract(to_emails, '$[0]')),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE (mailbox IS NULL OR mailbox = '')
   AND direction = 'inbound'
   AND json_valid(to_emails)
   AND json_extract(to_emails, '$[0]') IS NOT NULL
   AND trim(json_extract(to_emails, '$[0]')) <> '';

-- ② 出站：mailbox 为空时，用 from_email 回填（出站邮件的发件地址就是所属账号）
UPDATE messages
   SET mailbox = lower(from_email),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE (mailbox IS NULL OR mailbox = '')
   AND direction = 'outbound'
   AND from_email IS NOT NULL
   AND trim(from_email) <> '';

-- ③ 出站邮件一律已读（自己发的邮件没有「未读」语义）
UPDATE messages
   SET read = 1,
       updated_at = CAST(strftime('%s', 'now') AS INTEGER)
 WHERE direction = 'outbound'
   AND read = 0;
