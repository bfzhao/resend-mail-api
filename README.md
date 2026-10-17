# Resend Mail Inbox (Cloudflare Worker + D1 + R2)

Collect mail for your own domain into a **self-hosted** web inbox:

- **Inbound**: Cloudflare Email Routing receives mail → the Worker stores the raw `.eml` in R2 + records it in D1 (body/metadata), parses it asynchronously, and **never loses mail**.
- **Outbound**: send / reply through [Resend](https://resend.com) (HTML + attachments supported).
- **Web UI**: a simplified Gmail-style interface with read / unread / star / delete (trash) / compose / reply / multi-address switching / search.

All data lives in **your own** Cloudflare account (D1 / R2 / Queue), and the Resend key is stored only in your own D1 — no secrets leave your account.

---

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bfzhao/resend-mail-api)

> On click, Cloudflare clones this repo **into your GitHub account**, provisions D1 / R2 / Queue from `wrangler.toml`, and deploys it to your Cloudflare account.

### Prerequisites

- **Cloudflare account** (Free plan is fine)
- **A domain** whose DNS is hosted on Cloudflare (nameservers pointed at Cloudflare)
- **Resend account** (Free plan is fine; used for outbound and domain verification)
- **GitHub account** (the Deploy Button clones the repo into your account)

### After deploy: follow the in-app wizard

1. Open the URL Cloudflare gives you: `https://<your-worker>.<subdomain>.workers.dev`
2. The first visit opens the setup wizard:
   - **Step 1 · Set up admin**: choose a username and password (used to sign in afterwards; you can also use the `API_USERNAME` / `API_PASSWORD` env vars for Basic Auth).
   - **Step 2 · Connect your domain**: enter the domain + Cloudflare API Token + Resend API Key + from-address.
     Clicking "Start setup" then automatically: finds the zone → enables Email Routing and points catch-all at this Worker → creates the sending domain in Resend → writes DKIM/SPF/DMARC into your DNS → triggers Resend verification.
3. Done — you can now receive, compose, and reply.

**Cloudflare API Token permissions** (zone-level):

| Category | Permission |
|---|---|
| Zone | Zone → Read |
| Zone | DNS → Edit |
| Zone | Email Routing → Edit |

> The token is **used once during setup and never stored**; the Resend key is saved in your own D1 (`app_config`) for long-term sending.
> DNS changes can take a few minutes to propagate; you can re-run the "self-check" in the wizard later (it verifies MX/DKIM/SPF/DMARC via public DNS and needs no token).

---

## Self-hosting / local development

```bash
npm install
npm run typecheck

# Local database (sqlite at .wrangler/state)
npm run db:migrate:local

# Put local secrets in .dev.vars (not committed)
# RESEND_API_KEY=re_xxx
# API_USERNAME=admin
# API_PASSWORD=change-me

npm run dev            # http://localhost:8787
```

To self-host on your own Cloudflare account, use the **local config file** (gitignored, never made public):

```bash
# fill in your own database_id etc. in wrangler.local.toml
wrangler deploy -c wrangler.local.toml
```

> `wrangler.toml` is a **template** for the Deploy Button: its D1 `database_id` is the placeholder `<DATABASE_ID>`, which is created and filled in automatically on cloud deploy. Keep your own production ids in `wrangler.local.toml`.

### Schema (auto-created on a fresh DB)

After deploying to a brand-new empty D1, **the Worker creates the tables automatically on first request** (idempotent) — no manual migration needed. The source of truth is [`schema.sql`](./schema.sql); `src/schema-sql.ts` is its inlined form (used at runtime). After editing `schema.sql`, run:

```bash
npm run schema:sync
```

(`test/schema-sql-sync.test.js` checks that the two stay in sync.)

---

## Architecture

```
Cloudflare Email Routing ──(email)──┐
   (MX = mx.cloudflare.net)         │  ① stream the raw .eml to R2 + register inbound_raw
                                    ▼
                              Worker (src/index.ts)
                 ├─ R2: raw messages + attachments
                 ├─ D1: messages / attachments / inbound_raw / delivery_events / drafts / app_config / users …
                 ├─ Queue: async parsing (never-lose stage 2)
                 └─ Resend API: send / reply (outbound)
                                    ▲
                   Browser SPA (public/, served via ASSETS)
                   Folders: Inbox / Starred / Sent / Trash
```

- Inbound and outbound share one `messages` table, distinguished by `direction` (inbound / outbound); folders are just query views.
- Deleted = soft delete (`deleted=1`); the trash can either restore or permanently delete (which also removes the R2 attachments).
- `thread_id` groups by the root Message-ID of the References chain; `mailbox` records the receiving address, enabling multi-address switching.
- Cloudflare Email Routing is a router and **does not store mail**, so the first thing we do on receive is persist to R2 + register, then enqueue for async parsing; a `*/15` cron re-enqueues anything left unparsed to self-heal.

## Layout

```
public/            SPA (no build step): index.html / app.css / app.js
src/
  index.ts         routing: /webhook/*, /api/*, /api/setup/*, static asset fallback
  auth.ts          auth (env Basic / D1 session)
  session.ts       PBKDF2 password hashing + session cookie
  setup.ts         setup wizard: domain + automatic DNS + send/receive auth + self-check
  cloudflare.ts    Cloudflare API (DNS / Email Routing)
  resend-domains.ts Resend domain API
  schema.ts        ensureSchema: idempotent table creation on first request for a fresh DB
  schema-sql.ts    inlined form of schema.sql (generated by npm run schema:sync)
  webhook.ts       Resend webhook signature verification, inbound receipt, outbound receipts
  inbound-email.ts CF Email Routing inbound (persist to R2 + enqueue + async parse + self-heal)
  repo.ts          D1/R2 access, folder queries, sessions, batch operations
  receiving.ts     Resend Received Emails API
  send.ts          send via Resend (with attachments)
  util.ts          address parsing / time / base64 / encoding, etc.
schema.sql         table schema (single source of truth)
scripts/sync-schema.js  generates src/schema-sql.ts from schema.sql
migrations/        incremental migrations for existing DBs (001 … 010)
wrangler.toml      Deploy Button template config
wrangler.local.toml self-host config (gitignored)
```

## API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET/POST | `/api/setup/status` `/api/setup/admin` `/api/setup/domain` `/api/setup/check` | Setup wizard / self-check |
| POST | `/api/login` `/api/logout` | Session sign-in / sign-out |
| POST | `/webhook/inbound` | Resend Inbound receipt (optional; signature verification + idempotency) |
| POST | `/webhook/events` | Resend delivery events (optional; updates sent status) |
| GET | `/api/folders/:folder` | List; folder ∈ `inbox/sent/starred/trash`; params `q`, `unread=1`, `mailbox`, `limit/offset` |
| GET | `/api/counts` | Sidebar unread / total counts (optionally per `mailbox`) |
| GET | `/api/mailboxes` | List of receiving addresses with their unread counts |
| GET | `/api/account` | Sending capability and sender info |
| GET | `/api/messages/:id` | Detail + attachments + `thread` (conversation context) |
| PATCH | `/api/messages/:id` | `{read?, starred?, deleted?}` |
| POST | `/api/messages/batch` | `{ids, action}`, action ∈ `read/unread/star/unstar/trash/restore/delete` |
| POST | `/api/messages` | Compose `{to, cc?, subject, body?, html?, mailbox?, attachments?}` |
| POST | `/api/messages/:id/reply` | Reply |
| GET | `/api/attachments/:id` | Attachment proxy: images inline, everything else forced download |

## Security

- Inbound HTML bodies are sanitized with a front-end allowlist before rendering; the attachment proxy sends non-images with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`.
- The admin password is hashed with PBKDF2-SHA256 (100k iterations) and stored in D1; sessions are HMAC-signed cookies.
- Webhooks verify a 5-minute timestamp window; `webhook_deliveries` provides idempotency.
- In production, configure via env vars / the wizard; never put secrets in `wrangler.toml`.

## Known limitations

- Cloudflare Email Routing enforces a 25 MiB inbound limit (larger mail is rejected), so practical attachment size is ~18–19 MB.
- The list is flat per message (thread aggregation lives inside the detail view).
- Replies don't quote inline images, only plain-text quoting.
- Single admin account only.

## License

MIT
