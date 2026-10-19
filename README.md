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

The wizard's **"Open the Cloudflare authorisation page"** button opens Cloudflare's token UI with the **first three** permissions pre-selected (Cloudflare "token template URL", see `CF_TOKEN_PERMS`, including the required `accountId` / `zoneId` parameters):

- Auto-selected: `Zone → Read`, `DNS → Edit`, `Zone Settings → Edit`
- **One manual click**: `Zone → Email Routing Rules → Edit` (Cloudflare does not allow pre-selecting this one from a link; the wizard tells you to use "+ Add more")
- `Zone Resources` defaults to All zones — change it to `Include → your domain` to authorise just that zone

The button stays **disabled until a domain is typed**; when the app already knows that domain's zone id (a domain it is already configured for), the token page opens **scoped to that exact zone** — otherwise use `Zone Resources → Include → <your domain>`.

If the token lacks a permission, the wizard step says "this operation needs the xxx permission" instead of failing silently.

**Cloudflare API Token permissions** (zone-level, four in total):

| Category | Permission |
|---|---|
| Zone | Zone → Read |
| Zone | DNS → Edit |
| Zone | Zone Settings → Edit |
| Zone | Email Routing Rules → Edit |

> The Resend API Key must have **Full access** (a sending-only key can send, but cannot create / read / verify domains — Resend answers `This API key is restricted to only send emails`).
> ✅ **The database is the source of truth, and every domain has its own Resend key.** A key is **bound to a domain** (`domains.resend_api_key`) with env `RESEND_API_KEY` as the only fallback — there is deliberately **no global database key**, because one key can never be right for two domains in different Resend accounts. That is why two domains in **different Resend accounts** both work (that is why "same domain, verified in my dashboard" can still fail: the key used to send belonged to the other account). The key of a domain is editable in-app, no redeploy: click the **health marker** after the domain name (**✓** = check passed · **?** = not checked yet · **!** = problem) → **Edit the sending key for <domain>** → **Save and re-check**. Env vars (`RESEND_API_KEY` / `SEND_FROM_ADDRESS`) are only a **bootstrap fallback** — a purely env-configured deployment is imported into D1 once on first request, after which the env vars can be deleted (one env key / one sender is simply not enough for several domains, and an env key silently shadowing the saved one looked exactly like "Resend shows the domain verified, but sending says it is not").
> The Cloudflare token is **used once during setup and never stored**.
> DNS changes can take a few minutes to propagate. Each domain chip reports its state in two places: the **health marker right after the domain name** (blue **✓** = the check passed, gray **?** = not checked yet, red **!** = something is wrong) and the **unread count** in the chip's top-right corner (`99+` above 99, hidden at zero). The check runs **by itself** (on page load, then at most every 30 minutes) and verifies, with the key that actually sends, the Resend status per domain plus MX/DKIM/SPF/DMARC via public DNS (no token needed). Click the health marker for that domain's detail tables and its key settings.

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

> `RESEND_API_KEY` / `SEND_FROM_ADDRESS` in `.dev.vars` are **bootstrap only**: they are imported into the local D1 on the
> first request, after which D1 wins (edit them in-app from the domain chip: health marker → Edit the sending key). `API_USERNAME` / `API_PASSWORD` stay env-only.

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
- `thread_id` groups by the root Message-ID of the References chain (**the Sent folder is not grouped** — one row per message); `mailbox` records the receiving address, enabling multi-address switching. Drafts are never narrowed by the mailbox/domain filters: a draft belongs to the sender you picked.
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
  resend-errors.ts Resend error messages → actionable hints (key / domain / permissions)
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
migrations/        incremental migrations for existing DBs (001 … 012)
wrangler.toml      Deploy Button template config
wrangler.local.toml self-host config (gitignored)
```

## API

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check |
| GET/POST | `/api/setup/status` `/api/setup/admin` `/api/setup/domain` `/api/setup/check` | Setup wizard / self-check (check = per-domain Resend status with the sending key + DNS records) |
| POST | `/api/login` `/api/logout` | Session sign-in / sign-out |
| POST | `/webhook/inbound` | Resend Inbound receipt (optional; signature verification + idempotency) |
| POST | `/webhook/events` | Resend delivery events (optional; updates sent status) |
| GET | `/api/folders/:folder` | List; folder ∈ `inbox/sent/starred/trash`; params `q`, `unread=1`, `mailbox`, `limit/offset` |
| GET | `/api/counts` | Sidebar unread / total counts (optionally per `mailbox`) |
| GET | `/api/mailboxes` | List of receiving addresses with their unread counts |
| GET | `/api/account` | Sending capability and sender info |
| POST | `/api/settings/send` | Update the sending config stored in D1 (`{domain?, resend_key?, from_address?, from_name?}`): a Resend key always needs `domain` (keys are bound per domain); without `domain` only the global default sender is changed. The key is verified against Resend first |
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

## Troubleshooting

### Sending fails with `The <domain> domain is not verified` even though Resend's dashboard shows it verified

That error comes from the **API key used for sending**, not from DNS: the key cannot use that domain. The usual causes, in order:

1. **Different Team / account** — the key that serves this domain belongs to another Resend team than the dashboard you are looking at. A domain sends with **its own** key (`domains.resend_api_key`, falling back only to env `RESEND_API_KEY`), so two domains in two Resend accounts each need their own key: **health marker → Edit the sending key**.
2. **Domain-restricted sending key** — a `Sending access` key limited to another domain may only send from that domain.
3. **Subdomain ≠ root domain** — verifying `mail.example.com` does not allow sending from `@example.com` (and vice versa).
4. **A stale copy is still around** — the key used for this domain is not the one you think (for example an env var that still holds the old key). The health panel names the source per domain (`Sending key · <domain>`: bound to domain / environment fallback, plus the masked key), so you can see exactly which key is in play.

Check all of it in one place: click the **health marker** after a domain's name (it also refreshes automatically, at most every 30 minutes), or call `GET /api/setup/check` directly. The panel describes **one domain only**, split into two tables — *Sending (Resend)* and *Receiving (Cloudflare Email Routing)* — and it queries `GET https://api.resend.com/domains` **with the key that actually sends**:

| Sending (Resend) table row | Meaning |
|---|---|
| `Sending key` ✓ bound to domain | this domain uses its own key (`re_***`) — what you want when two domains live in two Resend accounts |
| `Sending key` ✓ environment fallback | no key is bound to this domain, so env `RESEND_API_KEY` is used — bind a key to make it independent |
| `Sending key` ✕ | no key at all → nothing can be sent from this domain (bind one right below the tables) |
| `Resend` ✓ verified | this key can send from this domain |
| `Resend` ✕ not listed | the key cannot see the domain → wrong Team or a restricted key (DNS is irrelevant) |
| `Resend` ✕ status ≠ verified | the domain really is still pending in Resend — wait for DNS, then re-check |
| `Sending MX` / `DKIM` / `SPF` | Resend sending records (`send.<domain>` MX + TXT, `resend._domainkey`) |
| `DMARC` `!` | advisory only — a missing `_dmarc` never turns the health marker red |

| Receiving (Cloudflare Email Routing) table row | Meaning |
|---|---|
| `Receiving MX` | `mx.cloudflare.net` records — required for inbound mail |

Found a wrong key? Fix it right there: **health marker → Edit the sending key for <domain> → Save and re-check**. The new key is verified
against Resend *before* it is stored (a typo never replaces a working key), and the panel re-runs immediately. Same thing over
HTTP: `POST /api/settings/send {domain, resend_key}` — a key always needs `domain`; `from_address` / `from_name` still set the
**global default sender** for API callers, but the UI no longer asks for them because the sender is chosen when you compose.

### `This API key is restricted to only send emails`

The key is `Sending access`. Creating / reading / verifying domains needs a **Full access** key (Resend → API Keys). After
that, run the in-app **＋ Domain** flow again (or wait for the next automatic check / click the health marker to confirm the new key can see the domains).

### Mail is not arriving

In the health panel's **Receiving** table → `Receiving MX` must show a `mx.cloudflare.net` record. If it is missing, Email Routing is not enabled for
that zone (re-run the wizard, or enable it in the Cloudflare dashboard).

## Known limitations

- Cloudflare Email Routing enforces a 25 MiB inbound limit (larger mail is rejected), so practical attachment size is ~18–19 MB.
- The list is flat per message (thread aggregation lives inside the detail view; **the Sent folder is never grouped** — one row per message). Drafts are a global list, never narrowed by the "all mailboxes / domain" filters.
- Every domain has its own colour from a fixed eight-colour palette: the **chip background** carries it (light while the filter is off, solid while it is on) and the same hue tints the rows of mail sent from / received at that domain. Nothing to configure.
- The domain chips are a **filter**, not a shortcut: with no domain ticked the list is empty (the empty state says so); ticking none never means "all domains".
- Replies don't quote inline images, only plain-text quoting.
- Single admin account only.
- The UI is **bilingual**: one click on the language toggle in the top bar switches between Chinese and English and the choice is remembered in the browser (localStorage). Only interface elements are translated — **mail content (subject, sender, body, attachment names) is always shown verbatim**; server-side diagnostic errors stay in Chinese.

## License

MIT
