# Resend 邮件收件箱（Cloudflare Worker + D1 + R2）

接收发往你自己域名的邮件（Resend Inbound `email.received`），在 Worker 上解析入库：
D1 存邮件正文与元数据，R2 存附件；网页端是简化 Gmail 风格的收件箱，支持 阅读 / 标记已读 / 星标 / 删除（回收站）/ 写信 / 回复（通过 Resend 发送）。

## 架构

```
Resend Inbound ──► POST /webhook/inbound ──┐
Resend 域名回执 ─► POST /webhook/events ────┤  Svix 签名校验 + 幂等
                                            │  （inbound 再经 Resend API 拉正文/附件）
                                            ▼
                                       Worker (src/index.ts)
                         ├─ D1: messages / attachments / delivery_events / webhook_deliveries
                         ├─ R2: attachments/{messageId}/{uuid}-{filename}
                         └─ Resend API: 拉收信正文/附件 + 写信 / 回复（发件）
                                            ▲
                       浏览器 SPA (public/, 经 ASSETS 提供)
                       文件夹：收件箱 / 已加星标 / 已发送 / 已删除
```

- 收件与发件混存在一张 `messages` 表，用 `direction`（inbound / outbound）区分，文件夹只是查询视图。
- 已删除 = 软删除（`deleted=1`），回收站里可「还原」或「彻底删除」（删除 R2 附件）。
- `thread_id` 用 References 链的根 Message-ID 归组，列表保持平铺、阅读视图内展示会话上下文。
- `mailbox` 记录邮件所属收件地址，支持多收件地址切换（各自独立的文件夹/未读/搜索）。
- 写信/回复支持富文本（HTML）与附件；发件人默认跟随所选收件地址。

## 目录

```
public/            SPA（无构建）：index.html / app.css / app.js
src/
  index.ts         路由：/webhook/*、/api/*、静态资源回退
  types.ts         Env 与数据行类型
  auth.ts          Basic Auth
  webhook.ts       验签、入站收信（拉正文/附件）、出站回执
  repo.ts          D1/R2 存取、文件夹查询、会话、批量操作、附件代理
  receiving.ts     Resend Received Emails API（正文/附件下载）
  send.ts          通过 Resend 发送（含附件、按 mailbox 发件人）
  util.ts          地址解析 / 时间 / base64 / 编码 / 会话根 等
schema.sql         表结构（新装）
migrations/        老库增量迁移（001_thread_mailbox）
wrangler.toml      绑定与配置
```

## 本地开发

```bash
npm install
npm run typecheck

# 本地初始化数据库（sqlite，位于 .wrangler/state）
npm run db:migrate:local

# 本地敏感配置写入 .dev.vars（不提交）
# RESEND_API_KEY=re_xxx
# API_USERNAME=admin
# API_PASSWORD=change-me

npm run dev            # http://localhost:8787
```

本地联调入站 webhook：用 [Svix CLI](https://github.com/svix/svix-cli) 或自行计算 `svix-signature`：

```text
待签名串 = {svix-id}.{svix-timestamp}.{原始body}
HMAC-SHA256(key = Resend 显示的那个 signing secret 中 whsec_ 前缀之后 base64 解码出的字节, 待签名串) → base64
请求头：svix-id / svix-timestamp / svix-signature: v1,{base64}
```

注意：Svix 约定签名密钥形如 `whsec_<base64>`，**HMAC 密钥是 `<base64>` 解码后的字节，不是整个字符串**。把 Resend 页面显示的 signing secret 原样填入 `RESEND_WEBHOOK_SECRET` 即可，本项目的验签会自动按该规则处理（带 `whsec_` 前缀且后缀为合法 base64 时解码为密钥，否则兼容本地明文测试密钥）。

## 部署

前置：已注册 [Resend](https://resend.com)，验证了发送域名（回信/写信用），并开通 Inbound Email（接收域名指向 Resend 的 MX/路由）。

```bash
# 1. 创建资源并回填 id
wrangler d1 create resend-webhooks-db            # 输出 database_id，填入 wrangler.toml
wrangler r2 bucket create resend-mail-attachments

# 2. 初始化数据库
npm run db:migrate

# 3. 敏感配置（覆盖 wrangler.toml 里的占位值）
wrangler secret put API_USERNAME
wrangler secret put API_PASSWORD
wrangler secret put RESEND_API_KEY               # 写信/回复 + 拉取收信正文/附件都要用
wrangler secret put RESEND_WEBHOOK_SECRET        # Resend Inbound 签名密钥
# RESEND_EVENTS_SECRET 可选；不设则回执复用 RESEND_WEBHOOK_SECRET

# 4. 发送域名与发件人（按需改成 vars 或 secret）
wrangler secret put SEND_FROM_ADDRESS            # 例 you@your-domain.com
wrangler secret put SEND_FROM_NAME               # 例 My Inbox

# 5. 上线
npm run deploy
```

### Resend 控制台配置

1. **Inbound**：在 Resend 的 Inbound Routes 里给接收域名添加路由，把收到的邮件转发到
   `https://<你的worker>.<子域>.workers.dev/webhook/inbound`。
   - 事件类型勾选「Email Received」。签名字段在 Resend 页面可查看，把签名密钥填入 `RESEND_WEBHOOK_SECRET`。
   - `email.received` webhook 只带元数据（不含正文/附件），Worker 会用 `RESEND_API_KEY` 调
     [Received emails API](https://resend.com/docs/api-reference/emails/retrieve-received-email)
     拉取正文（`html_format=cid`），再下载附件存 R2。
2. **发送域名**（可选，用于回执更新已发送状态）：域名 Domain Events Webhook 指向
   `https://<worker>/webhook/events`，并勾选 `sent / delivered / bounced / failed / complained`。
   - 收信转发只送 `email.received`；回执更新 `已发送` 里的送达状态。
3. Basic Auth：`API_USERNAME / API_PASSWORD` 都设置后，页面与 `/api/*` 均需登录。更稳妥可用 Cloudflare Access 挡在 Worker 前面。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/webhook/inbound` | Resend Inbound 收信（签名校验 + 幂等） |
| POST | `/webhook/events` | Resend 发送回执（可选，更新已发送状态） |
| GET | `/health` | 健康检查 |
| GET | `/api/folders/:folder` | 列表，folder ∈ `inbox/sent/starred/trash`；参数 `q`（搜索）、`unread=1`、`mailbox`、`limit/offset` |
| GET | `/api/counts` | 侧边栏未读/总数（可按 `mailbox`） |
| GET | `/api/mailboxes` | 收件地址列表及各自未读数（多邮箱切换） |
| GET | `/api/account` | 发送能力与发件人信息 |
| GET | `/api/messages/:id` | 详情 + 附件 + `thread`（会话上下文）；收件未读会自动标为已读 |
| PATCH | `/api/messages/:id` | `{read?, starred?, deleted?}` |
| POST | `/api/messages/batch` | `{ids, action}`，action ∈ `read/unread/star/unstar/trash/restore/delete` |
| POST | `/api/messages` | 写信 `{to, cc?, subject, body?, html?, mailbox?, attachments?}` |
| POST | `/api/messages/:id/reply` | 回复（自动 `Re:` + 引用头，同上字段，发件人默认跟随原信 mailbox） |
| GET | `/api/attachments/:id` | 附件代理：图片 inline，其余强制下载（`nosniff`） |

## 安全说明

- 入站 HTML 正文在前端白名单清洗后才渲染（剥离 script/事件属性/非法协议），内联图片 `cid:` 改写为本地附件代理地址。
- 附件代理对非图片一律 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`，不会把上传内容当 HTML 打开。
- Webhook 校验带 5 分钟时间戳窗口，事件表 `webhook_deliveries` 做幂等。
- 生产请务必用 `wrangler secret put`，不要用 `wrangler.toml` 里的明文占位值。

## 已知限制 / 后续可做

- 富文本/正文与附件通过 Resend 发送；回复时不支持「引用原文后编辑图片/内嵌图片」，仅普通文本引用。
- 列表仍为单封平铺（会话聚合展示在详情内）；如需收件箱按会话折叠可扩展。
- 超大正文仍存 D1；若邮件正文超大可扩展为按体积阈值落 R2。

## 升级老库（新增 thread_id / mailbox 后）

```bash
npm run db:migrate:up        # 一次性：为已存在的库加列、重建索引、回填 thread_id
npm run db:migrate:up:local  # 本地开发同款
```
新装库直接 `npm run db:migrate` 即可，无需 up。
