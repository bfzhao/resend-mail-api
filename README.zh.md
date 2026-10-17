# Resend 邮件收件箱（Cloudflare Worker + D1 + R2）

把你自己域名的邮件收进一个**自托管**的网页收件箱：

- **收信**：Cloudflare Email Routing 收到邮件 → Worker 落 R2（原始 `.eml`）+ 入 D1（正文/元数据），异步解析，**绝不丢信**。
- **发信**：通过 [Resend](https://resend.com) 发送 / 回复（支持 HTML 与附件）。
- **网页端**：简化 Gmail 风格界面，支持阅读 / 已读 / 星标 / 删除（回收站）/ 写信 / 回复 / 多收件地址切换 / 搜索。

所有数据都落在**你自己的** Cloudflare 账号（D1 / R2 / Queue）里，Resend Key 也只存在你自己的 D1 —— 密钥不出你的账号。

---

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bfzhao/resend-mail-api)

> 点按钮后，Cloudflare 会把本仓库**克隆到你的 GitHub 账号**，按 `wrangler.toml` 自动创建 D1 / R2 / Queue 并部署到你的 Cloudflare 账号。

### 前置条件

- **Cloudflare 账号**（免费档即可）
- **一个域名**，且 DNS 托管在 Cloudflare（nameserver 已切到 Cloudflare）
- **Resend 账号**（免费档即可，用于发信与域名校验）
- **GitHub 账号**（Deploy Button 会把仓库克隆到你账号下）

### 部署后：跟着站内向导走

1. 打开 Cloudflare 给你的地址 `https://<你的worker>.<子域>.workers.dev`
2. 首次访问自动进入安装向导：
   - **第 1 步 · 设管理员**：设置用户名密码（此后用它登录；也可用环境变量 `API_USERNAME`/`API_PASSWORD` 走 Basic Auth）。
   - **第 2 步 · 连接域名**：填域名 + Cloudflare API Token + Resend API Key + 发件地址。
     点「开始配置」后自动完成：找 zone → 开启 Email Routing 并把 catch-all 指向本 Worker → 在 Resend 建发送域名 → 把 DKIM/SPF/DMARC 写进你的 DNS → 触发 Resend 校验。
3. 完成后即可收信、写信、回复。

**Cloudflare API Token 需要的权限**（区域级）：

| 类别 | 权限 |
|---|---|
| Zone | Zone → Read |
| Zone | DNS → Edit |
| Zone | Email Routing → Edit |

> 该 Token **只在配置时用一次，绝不保存**；Resend Key 会存在你自己 D1 的 `app_config`（发信需要，长期使用）。
> DNS 记录写入后可能有几分钟传播时间，稍后可在向导里重跑「自检」（用公共 DNS 验证 MX/DKIM/SPF/DMARC，不需要 Token）。

---

## 自部署 / 本地开发

```bash
npm install
npm run typecheck

# 本地数据库（sqlite，位于 .wrangler/state）
npm run db:migrate:local

# 本地敏感配置写入 .dev.vars（不提交）
# RESEND_API_KEY=re_xxx
# API_USERNAME=admin
# API_PASSWORD=change-me

npm run dev            # http://localhost:8787
```

自部署到自己的 Cloudflare 账号时，用**本地配置文件**（已被 `.gitignore` 忽略，不会公开）：

```bash
# wrangler.local.toml 里填你自己的 database_id 等
wrangler deploy -c wrangler.local.toml
```

> `wrangler.toml` 是给 Deploy Button 用的**模板**：D1 的 `database_id` 是占位符 `<DATABASE_ID>`，云部署时会自动创建并回填。你自己的生产 id 请放在 `wrangler.local.toml`。

### 表结构（全新库自动建表）

部署到全新的空 D1 后，**Worker 首次请求会自动建表**（幂等），无需手动跑迁移。表结构以 [`schema.sql`](./schema.sql) 为准；`src/schema-sql.ts` 是它的内联产物（运行时用），改完 `schema.sql` 后运行：

```bash
npm run schema:sync
```

（`test/schema-sql-sync.test.js` 会校验两者一致。）

---

## 架构

```
Cloudflare Email Routing ──(email)──┐
   （MX = mx.cloudflare.net）        │  ① 原始 .eml 流式落 R2 + 登记 inbound_raw
                                     ▼
                              Worker (src/index.ts)
                 ├─ R2: 原始邮件 + 附件
                 ├─ D1: messages / attachments / inbound_raw / delivery_events / drafts / app_config / users …
                 ├─ Queue: 异步解析（never-lose 第二段）
                 └─ Resend API: 发信 / 回复（出站）
                                     ▲
                   浏览器 SPA (public/，经 ASSETS 提供)
                   文件夹：收件箱 / 已加星标 / 已发送 / 已删除
```

- 收件与发件混存在一张 `messages` 表，用 `direction`（inbound / outbound）区分，文件夹只是查询视图。
- 已删除 = 软删除（`deleted=1`），回收站可「还原」或「彻底删除」（连带删除 R2 附件）。
- `thread_id` 用 References 链的根 Message-ID 归组；`mailbox` 记录所属收件地址，支持多地址切换。
- Cloudflare Email Routing 是路由器、**不存信**，所以收到信的第一件事是落 R2 + 登记，再入队异步解析；`*/15` cron 会把未解析完的重新入队自愈。

## 目录

```
public/            SPA（无构建）：index.html / app.css / app.js
src/
  index.ts         路由：/webhook/*、/api/*、/api/setup/*、静态资源回退
  auth.ts          鉴权（env Basic / D1 会话）
  session.ts       PBKDF2 口令哈希 + 会话 cookie
  setup.ts         安装向导：域名 + 自动 DNS + 收发认证 + 自检
  cloudflare.ts    Cloudflare API（DNS / Email Routing）
  resend-domains.ts Resend 域名 API
  schema.ts        ensureSchema：全新库首次请求幂等建表
  schema-sql.ts    schema.sql 的内联产物（由 npm run schema:sync 生成）
  webhook.ts       Resend webhook 验签、入站收信、出站回执
  inbound-email.ts CF Email Routing 入向（落 R2 + 入队 + 异步解析 + 自愈）
  repo.ts          D1/R2 存取、文件夹查询、会话、批量操作
  receiving.ts     Resend Received Emails API
  send.ts          通过 Resend 发送（含附件）
  util.ts          地址解析 / 时间 / base64 / 编码 等
schema.sql         表结构（唯一来源）
scripts/sync-schema.js  由 schema.sql 生成 src/schema-sql.ts
migrations/        老库增量迁移（001 … 010）
wrangler.toml      Deploy Button 模板配置
wrangler.local.toml 自部署配置（gitignored）
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET/POST | `/api/setup/status` `/api/setup/admin` `/api/setup/domain` `/api/setup/check` | 安装向导 / 自检 |
| POST | `/api/login` `/api/logout` | 会话登录 / 登出 |
| POST | `/webhook/inbound` | Resend Inbound 收信（可选，签名校验 + 幂等） |
| POST | `/webhook/events` | Resend 发送回执（可选，更新已发送状态） |
| GET | `/api/folders/:folder` | 列表，folder ∈ `inbox/sent/starred/trash`；参数 `q`、`unread=1`、`mailbox`、`limit/offset` |
| GET | `/api/counts` | 侧边栏未读 / 总数（可按 `mailbox`） |
| GET | `/api/mailboxes` | 收件地址列表及各自未读数 |
| GET | `/api/account` | 发送能力与发件人信息 |
| GET | `/api/messages/:id` | 详情 + 附件 + `thread`（会话上下文） |
| PATCH | `/api/messages/:id` | `{read?, starred?, deleted?}` |
| POST | `/api/messages/batch` | `{ids, action}`，action ∈ `read/unread/star/unstar/trash/restore/delete` |
| POST | `/api/messages` | 写信 `{to, cc?, subject, body?, html?, mailbox?, attachments?}` |
| POST | `/api/messages/:id/reply` | 回复 |
| GET | `/api/attachments/:id` | 附件代理：图片 inline，其余强制下载 |

## 安全说明

- 入站 HTML 正文在前端白名单清洗后才渲染；附件代理对非图片一律 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`。
- 管理员口令用 PBKDF2-SHA256（10 万次）哈希存 D1；会话为 HMAC 签名 cookie。
- Webhook 校验带 5 分钟时间戳窗口，`webhook_deliveries` 做幂等。
- 生产请用环境变量 / 向导配置，不要把密钥写进 `wrangler.toml`。

## 已知限制

- Cloudflare Email Routing 入站上限 25 MiB（超限会被拒），实际可收附件约 18–19 MB。
- 列表按单封平铺（会话聚合在详情内）。
- 回复不引用内嵌图片，仅普通文本引用。
- 仅单管理员账号。

## License

MIT
