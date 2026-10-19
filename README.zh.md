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
     向导里的 **「打开 Cloudflare 授权页」** 会打开 Cloudflare 的 Token 页面并**自动勾选前 3 项**（`CF_TOKEN_PERMS`，配合 Cloudflare 的 token template URL，已带上必需的 `accountId` / `zoneId` 参数）：

     - 自动勾选：`Zone → Read`、`DNS → Edit`、`Zone Settings → Edit`
     - **需手动补 1 项**：`Zone → Email Routing Rules → Edit`（Cloudflare 目前不允许用链接预选这一项，向导里会提示点「+ Add more」补上）
     - `Zone Resources` 默认 All zones，可改成 `Include → 你的域名` 只授权这一个域

     若 Token 缺某项权限，向导那一步会直接报「该操作需要 Token 具备 xxx 权限」，不用猜。
     点「开始配置」后自动完成：找 zone → 开启 Email Routing 并把 catch-all 指向本 Worker → 在 Resend 建发送域名 → 把 DKIM/SPF/DMARC 写进你的 DNS → 触发 Resend 校验。
3. 完成后即可收信、写信、回复。

**Cloudflare API Token 需要的权限**（区域级）：

| 类别 | 权限 |
|---|---|
| Zone | Zone → Read |
| Zone | DNS → Edit |
| Zone | Zone Settings → Edit |
| Zone | Email Routing Rules → Edit |

> Resend API Key 必须是 **Full access** 权限（「仅发送」的 Key 能发信，但建域 / 读域 / 触发验证都会被拒，Resend 会回 `This API key is restricted to only send emails`）。
> ✅ **数据库是权威来源，而且每个域名有自己的一把 Resend Key**：Key **绑定在域名上**（`domains.resend_api_key`），唯一的兜底是环境变量 `RESEND_API_KEY` —— 特意**没有「数据库全局 Key」这一级**，因为一把 Key 不可能同时适配两个不同 Resend 账号下的域。所以**两个域分属不同 Resend 账号也能同时发信** —— 「控制台明明验证过了却报未验证」正是因为这个域落到了另一个账号的 Key 上。Key / 默认发件人在**域名按钮右上角状态点 → 修改该域专属 Key / 默认发件人** 里改，保存即生效、不用重新部署。
> 该 Cloudflare Token **只在配置时用一次，绝不保存**。
> DNS 记录写入后可能有几分钟传播时间。每个域名按钮右上角都有一个**状态点**：蓝 **✓** 正常、灰 **?** 还没检查、红 **✕** 有问题。检查是**自动的**（页面加载时一次，之后最多每 30 分钟一次），用真正发信的 Key 查逐域 Resend 状态 + 用公共 DNS 验证 MX/DKIM/SPF/DMARC（不需要 Token）。点状态点可看明细、改发信 Key 与默认发件人。

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

> `.dev.vars` 里的 `RESEND_API_KEY` / `SEND_FROM_ADDRESS` 只作**首次兜底**：首次请求会被导入本地 D1，之后以数据库为准
> （从域名按钮的状态点进去改发信 Key）。`API_USERNAME` / `API_PASSWORD` 仍然只走环境变量。

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
- `thread_id` 用 References 链的根 Message-ID 归组（**发件箱不合并**，每封独立一行）；`mailbox` 记录所属收件地址，支持多地址切换。草稿不合并不筛选——草稿属于你选的发件人，不受「全部邮箱 / 域名」过滤影响。
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
  resend-errors.ts Resend 错误 → 可操作提示（Key / 域名 / 权限）
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
migrations/        老库增量迁移（001 … 012）
wrangler.toml      Deploy Button 模板配置
wrangler.local.toml 自部署配置（gitignored）
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET/POST | `/api/setup/status` `/api/setup/admin` `/api/setup/domain` `/api/setup/check` | 安装向导 / 自检（自检 = 用发信 Key 查每域的 Resend 状态 + 公共 DNS 记录；前端每 30 分钟自动调用，结果显示为域名按钮右上角状态点） |
| POST | `/api/login` `/api/logout` | 会话登录 / 登出 |
| POST | `/webhook/inbound` | Resend Inbound 收信（可选，签名校验 + 幂等） |
| POST | `/webhook/events` | Resend 发送回执（可选，更新已发送状态） |
| GET | `/api/folders/:folder` | 列表，folder ∈ `inbox/sent/starred/trash`；参数 `q`、`unread=1`、`mailbox`、`limit/offset` |
| GET | `/api/counts` | 侧边栏未读 / 总数（可按 `mailbox`） |
| GET | `/api/mailboxes` | 收件地址列表及各自未读数 |
| GET | `/api/account` | 发送能力与发件人信息 |
| POST | `/api/settings/send` | 修改存在 D1 的发信配置 `{domain?, resend_key?, from_address?, from_name?}`：**Resend Key 必须带 `domain`**（Key 按域绑定）；不带 `domain` 只改全局默认发件人（Key 会先经 Resend 校验再入库） |
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

## 故障排查

### 发信报 `The <域名> domain is not verified`，但 Resend 控制台显示已验证

这条错误来自**发信用的那把 API Key**，不是 DNS：这把 Key 用不了那个域。常见原因按可能性排序：

1. **不是同一个 Team / 账号** —— 服务这个域的 Key 属于 A 团队，你看的控制台是 B 团队。每个域优先用**它自己的** Key（`domains.resend_api_key`），没有才退回全局 Key；所以两个域在不同 Resend 账号时，各配一把即可：**状态点 → 修改该域专属 Key**。
2. **Key 被限制在别的域名上** —— `Sending access` 的 Key 如果选了某个域名，就只能从那个域发。
3. **子域 ≠ 根域** —— 验证了 `mail.example.com` 不代表能用 `@example.com` 发（反之亦然）。
4. **服务这个域的 Key 不是你以为的那把** —— 比如它没有专属 Key，落到了旧的全局 Key 上。自检面板里 `发信 Key · <域名>` 一行会写明来源（域名绑定 / 环境变量）。

一个地方全查：点域名按钮右上角的**状态点**（它也会自动刷新，最多每 30 分钟一次；等价接口 `GET /api/setup/check`）。它会用**真正发信的那把 Key** 调
`GET https://api.resend.com/domains`，并对每个已配置域名显示：

| 自检行 | 含义 |
|---|---|
| `Resend · <域名>` ✓ 已验证 | 这把 Key 可以用该域发信 |
| `Resend · <域名>` ✕ 看不到 | 这把 Key 看不到该域 → Team 不对或 Key 被限制到别的域名（与 DNS 无关） |
| `Resend · <域名>` ✕ 状态不是 verified | Resend 侧确实还没验证完 —— 等 DNS 生效后刷新 |
| `发信 Key` 出现 `!` | 环境变量里还留着**另一把** Key（已不生效，数据库优先）—— 建议删掉避免混淆 |

发现 Key 不对？就地改：**状态点 → 修改发信 Key / 默认发件人 → 保存并重新检查**。新 Key 会**先拿去 Resend 校验**再入库
（打错字不会顶掉正在用的 Key），保存后自动重跑检查。等价的 HTTP 接口：`POST /api/settings/send {domain, resend_key?, from_address?, from_name?}`。

### `This API key is restricted to only send emails`

这把 Key 是「仅发送」权限。建域 / 读域 / 触发验证都需要 **Full access** 的 Key（Resend → API Keys）。
换成 Full access 后重新走一次站内 **＋ 域名** 流程（或等下一次自动检查 / 点状态点确认新 Key 能看到哪些域）。

### 收不到信

状态点面板里 `收信 MX · <域名>` 必须是 `mx.cloudflare.net`。没有的话说明该 zone 没开 Email Routing（重跑向导，或在 Cloudflare 控制台开启）。

## 已知限制

- Cloudflare Email Routing 入站上限 25 MiB（超限会被拒），实际可收附件约 18–19 MB。
- 列表按单封平铺（会话聚合在详情内；**发件箱不做聚合**，每封一行）。草稿是全局列表，不受「全部邮箱 / 域名」筛选影响。
- 每个域名有自己的颜色（域名按钮上的圆点，以及该域发出/收到的邮件底色与左侧色条），颜色由域名计算得出、无需配置。
- 回复不引用内嵌图片，仅普通文本引用。
- 仅单管理员账号。
- 界面为**中英文双语**：顶栏右上角 `EN / 中文` 一键切换，选择记在浏览器（localStorage）。只翻译界面元素，**邮件内容（主题、发件人、正文、附件名）永远原样显示**；服务端返回的诊断错误信息仍是中文。

## License

MIT
