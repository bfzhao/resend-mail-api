-- 007：给 inbound_raw 增加 subject 列。
--
-- 背景：CF 入向是「先落原始件 + 登记索引，再异步解析」。失败/卡住的邮件只有 message_id，
-- 界面上无法辨认。这里在收信时顺手记下 Subject 头，让「入站异常」提示能显示「谁发来的、主题是什么」，
-- 用户才能判断是垃圾邮件还是真该抢救的邮件。
--
-- 与 schema.sql 的 inbound_raw 定义保持一致（全量建库 / 增量升级两条路径都要有这一列）。

ALTER TABLE inbound_raw ADD COLUMN subject TEXT;
