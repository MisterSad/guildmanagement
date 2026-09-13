# 🏗️ Architecture Specification & System Design — FGF Guild Management Tool

> **Status**: Authoritative Reference • **Standard**: August 2026 Production Specification  
> **Platform**: Multi-Tenant Serverless SaaS • **Single Source of Truth (SSOT)**

---

## PART 1 — CURRENT LIVE ARCHITECTURE (VERIFIED PRODUCTION REALITY)

### 1. High-Level System Topology

**FGF Guild Management Tool** is a serverless, multi-tenant SaaS tactical command and analytics platform built for competitive guilds in *Foundation Galactic Frontier*. The live production system is a single TypeScript/ESM frontend (`/src/main.ts`) that assembles the legacy `window.GM_*` bridge in-browser, backed by Supabase PostgreSQL 17 with Row Level Security (RLS) and Deno TypeScript Edge Functions. The former root monolith `app.js` was removed in the Strangler final cutover. The project root now holds no application script at all — only tooling configs (`playwright.config.js`, `vitest.config.js`) — and the service worker is a typed module at `src/sw/service-worker.ts` (pure parser in `src/sw/push-payload.ts`) compiled to the root-scoped `dist/sw.js` by esbuild in `scripts/build.js`.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENT LAYER (Browser / PWA)                          │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ TypeScript / ESM Frontend (`index.html` + `/src/main.ts` module)              │  │
│  │ ├─ Core Utilities & Legacy Bridge: `/src/core/gm-bridge.ts` (window.GM)        │  │
│  │ ├─ Admin Command Center: `/src/modules/app/admin/*` (accounts, requests,       │  │
│  │ │   subscriptions, migration groups), EventsView/StatsView (`/src`)            │  │
│  │ ├─ Player Self-Service Portal: PortalView (`/src`), `/src/modules/push`        │  │
│  │ ├─ Roster OCR (screenshots or video) + Rank Detection:                         │  │
│  │ │   `/src/modules/app/ocr/*` + `/src/modules/ocr/ocr.service.ts`              │  │
│  │ ├─ Identity: `/src/core/auth/webauthn.service.ts` (Passkeys client)           │  │
│  │ └─ Design System: Material Design 3.0 Tokens (`tokens.css`) + Apple Cozy Neutral│  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │ HTTPS / WSS / Cryptographic JWT
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   EDGE & SECURITY LAYER                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Supabase Deno TypeScript Edge Functions (`supabase/functions/`) — 16 live         │  │
│  │ ├─ Public (`verify_jwt = false`):                                                 │  │
│  │ │   ├─ `auth-login`: Bcrypt dual-read, lockout, IP rate limit, JWT issuer         │  │
│  │ │   ├─ `auth-passkey`: Passkeys/WebAuthn — register, sign in (scoped or fully     │  │
│  │ │   │   discoverable across accounts), backup codes, admin reset escape hatch     │  │
│  │ │   ├─ `player-register`: Self-service member registration                        │  │
│  │ │   ├─ `guild-request`: Public guild self-service request submission (reviewed    │  │
│  │ │   │   manually by a super_admin; provisions nothing on its own)                 │  │
│  │ │   ├─ `event-reminders`: Cron-secret gated notification dispatcher (Vault),      │  │
│  │ │   │   fans out to both Discord webhooks and Web Push subscribers                │  │
│  │ │   ├─ `gm-stripe-webhook`: Stripe webhook signature verification                 │  │
│  │ │   ├─ `discord-bot-interactions`: Slash-command handler, Ed25519-verified        │  │
│  │ │   ├─ `discord-profile-verification`: Worker shared-secret gated (screenshot     │  │
│  │ │   │   OCR → guild tag → Discord role/nickname)                                  │  │
│  │ │   └─ JWT-Gated (`verify_jwt = true`):                                           │  │
│  │ │       ├─ `member-portal`: Cryptographically resolved player portal backend      │  │
│  │ │       ├─ `admin-accounts`: Centralized admin role provisioner (`admin-authz.ts`)│  │
│  │ │       ├─ `ocr-guild-members`: Gemini vision multimodal OCR — screenshots OR     │  │
│  │ │       │   a screen-recording video (client extracts frames first); Members      │  │
│  │ │       │   scans also detect R1-R4 rank from the roster's section headers        │  │
│  │ │       ├─ `discord-webhook-proxy`: Whitelisted Discord webhook proxy (SSRF safe) │  │
│  │ │       ├─ `gm-create-order`: Stripe subscription checkout session initializer    │  │
│  │ │       ├─ `gm-order-status`: Order status reader and verification                │  │
│  │ │       ├─ `guild-data-export`: Guild data export (JWT-gated)                     │  │
│  │ │       └─ `tickets`: Bug-report ticketing console backend                        │  │
│  │ ├─ Non implémenté / Déprécié: `gm-revolut-webhook` (Revolut) — aucun code         │  │
│  │ │   associé dans `supabase/functions/`; ne pas déployer (voir note §1).           │  │
│  │ └─ Shared Modules: _shared/auth.ts, _shared/logger.ts, _shared/rate-limit.ts,     │  │
│  │     _shared/admin-authz.ts, _shared/shadow-session.ts, _shared/cors.ts            │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │ Postgres Wire Protocol / RLS
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   DATABASE LAYER (Postgres 17)                          │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Supabase Postgres 17 (Multi-Tenant Schema with Zero-Trust Row Level Security)       │  │
│  │ ├─ 45 table definitions / 42 persistent active, Full RLS Enforcement              │  │
│  │ ├─ Security Definer Access Helpers with `SET search_path TO ''`                   │  │
│  │ ├─ Deterministic Event Session Generator: `public.gm_event_session_id()`           │  │
│  │ ├─ Distributed Audit Ledger: `public.system_audit_logs` (service_role only)       │  │
│  │ ├─ Vault-Backed Secrets: `vault.decrypted_secrets`                                │  │
│  │ └─ Automated pg_cron Jobs: Reminders, Demo Reset, Stale Lock Cleanup              │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

> **⚠️ `gm-revolut-webhook` — Non implémenté / Déprécié**: historically referenced as a Revolut webhook receiver, but there is **no handler** in `supabase/functions/` and no `[functions.gm-revolut-webhook]` block in `supabase/config.toml`. Only the Stripe webhook (`gm-stripe-webhook`) is implemented. Do not include it in deployment matrices.

---

### 2. Authentication & Zero-Trust Role Resolution

Authentication operates on an **accounts-table-only** role resolution model. `user_metadata` and `app_metadata` claims are strictly forbidden as authorization sources.

```
[ User Enters Credentials ]
            │
            ▼
[ POST /functions/v1/auth-login ]
            │
            ├─► 1. Extract Client IP (`cf-connecting-ip` -> `x-forwarded-for`)
            ├─► 2. Check Sliding Window Rate Limit (30 req / 5 min in `public.login_throttle`)
            │      └─ Exceeded: Returns HTTP 429 `too_many_attempts`
            │
            ├─► 3. Call `public.gm_check_login(p_id, p_password)`
            │      ├─ Check account lockout: `failed_login_count >= 5` AND `locked_until > now()`
            │      ├─ Verify password: Dual-read (Bcrypt `$2a$10$` with legacy PGP fallback)
            │      ├─ If PGP match: Auto-migrates hash to Bcrypt and updates `password_hash`
            │      ├─ On Failure: Increment `failed_login_count` (lockout after 5 failed attempts)
            │      └─ On Success: Reset `failed_login_count = 0`, record `last_login_at = now()`
            │
            ├─► 4. Resolve / Provision Shadow GoTrue User (`gm_<sha256(id)>@no-reply.guildmgmt.app`)
            │      └─ Set `raw_app_meta_data.app_role = accounts.role`
            │
            └─► 5. Issue Cryptographically Signed GoTrue Access Token (JWT)
```

#### The Four Access Roles:
1. **`super_admin`**: Single global master account (`HawkEye`). Bypasses tenant RLS qualifiers. Accesses full Command Center and `#tab-tickets`.
2. **`server_admin`**: Reads and writes all tenant guilds sharing their assigned `server_number`. Uses server-scoped Guild Switcher.
3. **`guild_admin`**: Scoped strictly to own guild tenant (`accounts.guild`). Write operations require active SaaS subscription (`public.is_subscription_active()`).
4. **`member`**: **Zero direct database table access**. Communicates exclusively through the `member-portal` Edge Function.

> These are the **only** values `accounts.role` may hold — the DB enforces it via the `accounts_role_check` CHECK constraint (column default `member`). The legacy virtual/in-game ranks (`R5`, `R4`) and the historical `admin` alias were **retired on 2026-09-13** and are rejected by the constraint; no helper maps them to elevated access anymore.

#### 2.1 Passkeys / WebAuthn (Alternate Sign-In, added 2026-09)
Any account (admin or portal) can additionally register a Passkey per device instead of typing a password every time. Backed by `@simplewebauthn/server@10.0.1` (server-side crypto only — no `@simplewebauthn/browser` client dependency; `gm-webauthn.js` hand-rolls the base64url/ArrayBuffer marshalling to avoid adding a new CDN origin).
- **Registration**: `auth-passkey` `register-options`/`register-verify` (JWT-authenticated). First passkey on an account also issues 10 one-time backup codes (SHA-256 hashed, shown once).
- **Sign-in**: `auth-options`/`auth-verify` (unauthenticated — this *is* the login flow). Supports both a **scoped** ceremony (an id was typed, narrows the browser's picker to that account) and a **fully discoverable** one (no id — the picker shows every passkey registered for the site across every account; the credential's own `userHandle` resolves which account server-side, never anything the client claims). Conditional UI (`mediation: 'conditional'`, tied to `autocomplete="webauthn"` fields) runs in parallel so password-manager extensions (Proton Pass, Bitwarden, 1Password) that don't reliably support the modal picker still work via autofill-style suggestions.
- **iOS constraint**: `PushManager`/full WebAuthn UX is materially better inside an installed PWA — see §6 for the same "must be installed" constraint on push notifications.
- **Admin escape hatch**: `admin-reset-passkeys` action revokes every passkey + backup code for a target account (lost every device and the codes), gated by the same `canManageAccount`/`admin-authz.ts` matrix as the manual password-reset flow. R5 is not specially protected here (unlike the rank-assignment matrix) — the existing role hierarchy check already prevents managing an equal-or-higher role.
- **Rate limiting**: `auth-passkey` and `auth-login` share one IP budget (`login_throttle`, keyed purely by IP, not by which function calls it) — a passkey sign-in costs 2 requests (options + verify), and the conditional/autofill listener adds a background options call on every page load. Widen this budget (not the per-function limit) if login attempts start getting throttled after adding another auth-adjacent feature.

#### 2.2 Strict Role Isolation & Session Invalidation (added 2026-09-13)

- **Canonical roles only**: `accounts_role_check` restricts `accounts.role` to exactly `{ super_admin, server_admin, guild_admin, member }` (default `member`). The legacy in-game/virtual ranks `R5`/`R4`/`admin` are **forbidden at the database level** — the client-side and edge-side `normalizeRole()` (in `_shared/admin-authz.ts`) maps any such value to `member`, never to an elevated role.
- **Exact authorization helpers**: `is_super_admin()`, `is_server_admin()` and `gm_can_read_guilds()` now resolve the caller **exclusively** from `public.accounts` (`auth_user_id = auth.uid()` AND `status = 'active'`) with zero role aliasing and zero metadata fallback. All RLS policies that reference them inherit the tightened semantics (e.g. `server_migration_groups` writes now require a true `super_admin`).
- **Session-invalidation epoch (M4)**: `public.accounts.session_version` (integer, default 0) is bumped on every privileged account event — password reset, role change, suspension (`admin-accounts` `bumpSessionVersion()`). `public.gm_session_is_valid()` compares that epoch against the JWT's `app_metadata.session_version` claim, which the shadow-session minting path (`_shared/shadow-session.ts`) stamps on every create/refresh. A pre-bump token therefore fails the gate; enforcement points on the sensitive policies/helpers can be flipped on incrementally without a global re-login at deploy time.
- **Roster RLS self-read (M2)**: `player_absences_select_policy` self-branch resolves through `public.accounts` (`a.uid = player_absences.uid` AND `a.status = 'active'`) instead of the app_metadata `account_id` claim.
- **Write-surface hardening**: direct PostgREST writes to `public.accounts` are henceforth unreachable for any guild-scoped legacy-role session; admin writes (reset-password, update-role, reject-registration) bump the epoch and re-stamp the GoTrue `app_metadata` in the same transaction.

---

### 3. Member Portal Server-Side Identity Pipeline

The Player Portal (`portal.js`) never connects to Postgres directly. All actions pass through `POST /functions/v1/member-portal` using the member's JWT:

```
[ Member Portal Request + JWT ]
            │
            ▼
[ POST /functions/v1/member-portal ]
            │
            ├─► 1. Cryptographic JWT Verification (`auth.getUser(jwt)`)
            ├─► 2. Resolve Account Identity:
            │      SELECT id, role, guild, status, uid FROM public.accounts WHERE auth_user_id = user.id
            ├─► 3. Resolve Player UID:
            │      `gm_get_shadow(accountId)` -> `accounts.uid` -> fallback `accountId`
            └─► 4. Execute Scoped Action (`get-personal-kpis`, `get-active-sessions`, `submit-scores`, `declare-absence`)
```

---

### 4. Database Topology & Access Helpers

#### 4.1 Database Tables (45 `CREATE TABLE` definitions; 42 persistent tables active, all RLS-enabled):
- **Core Tenant / Roster** (20): `guilds` (13 rows, 1 is `DEMO`), `guild_members` (~1,540 rows), `event_status`, `event_participants` (~33k rows — the permanent attendance ledger), `war_opponents`, `war_sessions`, `event_daily_scores`, `event_chest_tiers` (SvS/GvG granular war — added 2026-09-13, see §4.4), `shadowfront_squads` (weekly squad *assignments* — does not reliably retain history once a later session overwrites it, unlike `event_participants`; see the Shadowfront attendance-rate note below), `shadowfront_signups`, `weekly_scores`, `sanctions`, `banned_players`, `guild_config`, `guild_transfers`, `player_name_history`, `player_metrics_history`, `diplomatic_treaties`, `server_migration_groups`, `server_migration_group_servers`.
- **Accounts & Identity** (8): `accounts` (custom bcrypt credential store, source of truth — see §2), `login_throttle` (shared IP rate limit for `auth-login` + `auth-passkey`), `webauthn_challenges`, `account_passkeys`, `account_backup_codes` (Passkeys/WebAuthn, added 2026-09), `discord_account_links`, `discord_link_codes`, `discord_verification_throttle` (Discord account linking + verification rate limiting, added 2026-09).
- **Self-Service Requests** (1): `guild_creation_requests` (public `guild-request` submissions, reviewed by `super_admin`).
- **Player Portal** (2): `player_absences`, `player_push_prefs` (per-player Web Push type opt-outs).
- **Notifications** (1): `push_subscriptions` (Web Push endpoints; `event-reminders` fans out to both this and Discord webhooks).
- **Leader Hall E2EE (Signal Protocol) — front-end removed 2026-09, SQL cleanup pending (7)**: `e2ee_prekey_bundles`, `e2ee_one_time_prekeys`, `e2ee_conversations`, `e2ee_conversation_members`, `e2ee_messages`, `e2ee_blocked_accounts`, `e2ee_message_reactions`. No UI reads them anymore; a dedicated drop migration is the follow-up Lot C.
- **Billing & Support** (2): `gm_payments`, `tickets` (in-app bug-report console).
- **Observability** (1): `system_audit_logs` (service_role-only INSERT).

> **Count note**: the canonical migrations contain 45 `CREATE TABLE` definitions. Two legacy notification tables (`discord_notifications_sent`, `event_reminders_sent`) were dropped by `20260819203500_drop_orphaned_notification_tables.sql`, and `tmp_demo_roster` is a session-scoped `TEMP` staging table used by the demo reset, leaving **42 persistent active tables** (the four SvS/GvG war tables below were added by `20260914090000`). All of them have RLS enabled.

> ⚠️ **Note on `shadowfront_squads` completeness**: a long-tenured player can show more attended Shadowfront weeks (`event_participants`) than surviving squad-assignment rows (`shadowfront_squads`), because the latter doesn't reliably retain every past week once a later session overwrites it. The Stats attendance-rate calculation (`gm-utils.js:computeShadowfrontAttendanceRate`) floors its denominator at the attended count to stay mathematically capped at 100%, but the underlying gap in `shadowfront_squads` itself is unresolved — any *new* feature reading that table should not assume it is a complete historical ledger.

#### 4.2 Centralized SQL Access Helpers (`SECURITY DEFINER`, `STABLE`, `SET search_path TO ''`):
- `public.gm_can_read_guild_data(p_guild text)` — Permissive SELECT filter for tenant tables.
- `public.gm_can_read_guilds()` — Permissive SELECT filter for `guilds`.
- `public.gm_can_read_account(p_account_id text)` — Permissive SELECT filter for `accounts`.
- `public.check_user_guild_write_access(p_guild text)` — INSERT/UPDATE/DELETE authorization check.
- `public.is_subscription_active(p_guild text)` — SaaS subscription write gate.
- `public.gm_can_admin_see_absences(p_guild text)` — Absence visibility qualifier.

#### 4.3 Active Cron Jobs:
1. `fgf-event-reminders`: Runs every minute (`* * * * *`), invokes `SELECT public.gm_invoke_event_reminders();` using Vault-stored secret.
2. `daily-demo-tenant-reset`: Runs daily at 03:00 UTC (`0 3 * * *`), executes `SELECT public.gm_reset_demo_tenant_data();`.
3. `daily-cleanup-stale-locks`: Runs daily at 04:00 UTC (`0 4 * * *`), executes `SELECT public.gm_cleanup_stale_reminder_locks();`.

#### 4.4 SvS / GvG Granular War Management (added 2026-09-13, migration `20260914090000_war_daily_scores_and_chest_tiers.sql`)

Tracks SvS and GvG at per-day granularity — scores (Day 1..6), parametrizable chest tiers, Won/Lost results per day and per-session opponent — replacing the previous monolithic `score_prep` (aggregated Day 1-5) / `score_pvp` (Day 6) columns as the primary entry path.

**New tenanted tables** (all `FORCE ROW LEVEL SECURITY`, policies: `SELECT` via `public.gm_can_read_guild_data(guild)`, `INSERT/UPDATE/DELETE` via `public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild)`):

| Table | Role |
|---|---|
| `war_opponents` | Per-guild opponent catalog — `kind` `'server'\|'guild'`, `name`, optional `server_number`/`guild_ref`; `UNIQUE (guild, kind, name)`. **Deliberately never FK'd to `guilds`**: an adversary created on the fly is a lightweight snapshot, never a tenant (no cross-tenant writes). |
| `war_sessions` | Persistent per-session war metadata — frozen `opponent_snapshot` (jsonb), `day1_result`..`day6_result` (`won`/`lost`), frozen `chest_tiers_snapshot` (jsonb grid), `start_at`; `UNIQUE (guild, event_name, session_id)`. Survives the weekly overwrite of `event_status` (which only holds the *live* session). |
| `event_daily_scores` | Granular per-player per-day scores + `chests_unlocked`; `UNIQUE (guild, event_name, session_id, pseudo, day)`, FK cascade to `guild_members` and `war_sessions`. |
| `event_chest_tiers` | Parametrizable Guild Settings grid — PK `(guild, event_name, day, tier)`, `min_score BIGINT >= 0`, `chests BIGINT >= 1`; atomically replaced by `gm_save_chest_tiers`. |

**Scoring contract (chests)**: deterministic helper `public.gm_chests_for_score(p_tiers jsonb, p_score bigint) RETURNS integer` (`STABLE`, `search_path=''`) returns the chest count of the highest tier with `min_score <= score` over a **per-day tier slice** (the caller filters the grid by `day`). Mirrored 1:1 client-side in `src/core/scoring/chests.ts:resolveChestsForScore()` (+ `defaultChestGrid()` fallback). The grid is **frozen into `war_sessions.chest_tiers_snapshot` at session open** — rebalancing the grid never rewrites historical sessions.

**RPCs** (all `SECURITY DEFINER SET search_path TO ''`, authenticated only): `gm_get_chest_tiers`, `gm_save_chest_tiers` (bounded/ordered validation + audit), `gm_upsert_war_session` (resolve-or-create opponent, upsert session, freeze grid on first create), `gm_get_war_session`, `gm_list_war_sessions`, `gm_upsert_daily_scores` (batch ≤ 200, auto-chests from snapshot), `gm_get_daily_scores`, `gm_delete_war_session`, `gm_list_opponent_candidates` (pick-list: own catalog + distinct `guilds.server_number` for SvS / registered `guilds` for GvG).

**Retro-compatibility guarantee**: no destructive `ALTER`, no backfill. For sessions that opt into the granular grid, `gm_upsert_daily_scores` **derives** `event_participants.score_prep` (sum Day 1-5) and `score_pvp` (Day 6) and sets `score = NULL` (avoiding double-count in `score+score_prep+score_pvp` totals) in the same transaction; `participated = 1` when any day is non-zero. Legacy sessions keep their aggregate columns and the History modal keeps its dual-score layout because `gm_list_event_sessions` now exposes a `granular boolean` (EXISTS on `war_sessions`) consumed by both EventsView and HistoryView to pick the day-grid rendering. Admin editing of a granular session in History routes through the war RPCs, and the legacy SvS/GvG OCR aggregate buttons (`svs_prep`/`svs_pvp`/`gvg_prep`/`gvg_pvp`) are disabled by `syncWarOcrGate` while a granular session is active.

---

### 5. AI Roster OCR Pipeline

```
[ Guild Admin Uploads Screenshots OR a Screen-Recording Video ]
                       │
                       ├─ Video path (client-side, before any upload):
                       │    `src/modules/app/ocr/ocr.controller.ts:extractFramesFromVideo`
                       │    samples the video
                       │    continuously but KEEPS a frame only where the visible
                       │    content changed since the last kept frame (12x12
                       │    luminance-grid diff) — avoids wasting the batch on
                       │    near-duplicates during a slow scroll, avoids missing
                       │    rows during a fast one. Kept frames are downsampled
                       │    to <=25 (`GM.ocrDownsampleEvenly`, spread evenly
                       │    across the whole recording, not just its start) and
                       │    folded in as if they were additional screenshots —
                       │    everything downstream is unchanged.
                       ▼
          [ POST /functions/v1/ocr-guild-members ] (chunks of <=4 images/call)
                       │
                       ├─► Multimodal Gemini Vision Extraction
                       │    Members scans ALSO detect R4/R3/R2/R1 rank from the
                       │    roster's section headers ("Executive Manager" / "Rank
                       │    3/2/1 Members"). A `rankHint`/`endingRank` round trip
                       │    carries the active rank section across sequential
                       │    batches, since a header can scroll out of view
                       │    partway through a recording.
                       └─► Returns Parsed Roster JSON: [{ pseudo, overall_power, uid?, rank? }]
                               │
                               ▼
        [ Client-Side Categorization: `gm-utils.js:categorizeOcrDiff` ]
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
  [ Existing ]      [ New ]      [ Removed ]
  (Power + Rank    (New Recruits, (Missing from OCR)
   Updates)         Rank if detected)
                       │             │
                       ├─ Enter UID  ├─ Proposed Remove by Default
                       │  (No TEMP)  └─ Per-Row Keep/Remove Toggle
                       ├─ Rank is an editable dropdown (defaults to detected
                       │  value; R5 is never assignable here — same
                       │  `isRoleAllowedForBulk` gate the manual bulk rank
                       │  buttons use)
                       ▼
          [ Live Counter: Roster N → M ]
                       │
                       ▼
          [ Commit Roster Changes ]
                       │
                       ├─ IF removals present: Show Confirmation Dialog listing every deleted pseudo
                       └─ Upsert/Delete records (incl. `role` when a rank was assigned) with transactional integrity
```

---

### 6. Web Push Notifications
Anonymous, per-device opt-in (client `src/modules/push/PushService.ts` + service worker `src/sw/service-worker.ts`, compiled to `dist/sw.js` by esbuild; VAPID keys in Supabase secrets). The opt-in control (`window.GM_PUSH.mount(container)`) is mounted in **both** the admin Overview screen and the Portal's Notifications card — a player-facing gap (portal preferences existed with no way to actually subscribe) was found and fixed 2026-08-31; if a future notification surface is added, mount the control there too rather than assuming one mount point covers every audience.
- **Send path**: `event-reminders`' `sendWebPush()` fans out to `push_subscriptions` (filtered by `player_push_prefs` per-type opt-outs) alongside the existing Discord webhook dispatch, on the same cron tick.
- **iOS constraint**: `PushManager` only exists inside an **installed** PWA on iOS Safari (16.4+) — a plain Safari tab shows an "Add to Home Screen" hint instead. Desktop/Android need no install step.
- **CSP dependency**: the uploaded-file `<video>` blob and any future blob-backed media element depend on `media-src` explicitly including `blob:` in `vercel.json` — `default-src 'self'` does **not** cover it by CSP-spec fallback, and this silently blocks the resource identically on every browser (not a codec/compat issue) if ever dropped. Confirmed live via `document.addEventListener('securitypolicyviolation', ...)` when this shipped without it.

### 7. Leader Hall — End-to-End Encrypted Messaging (removed 2026-09)
The Leader Hall feature (1:1 and group Signal-Protocol messaging between guild leadership) has been **removed entirely from the front-end**: `gm-signal-crypto.js`, `gm-leader-hall.js`, `noble-crypto.bundle.js`, the `/src` port and the `#tab-leader-hall` DOM are gone. The server-side `e2ee_*` tables and leader RPCs remain in the database pending a dedicated drop migration (Lot C) — no UI reads them anymore.

---

### 8. Deployment & Infrastructure Topology

- **Production Frontend**: Hosted on Vercel at `https://guildmanagement.vercel.app` (branch `main`).
- **Content Security Policy (CSP)**: Hardened policy with `frame-ancestors 'none'`, `object-src 'none'`, `media-src 'self' blob:` (see §6 — omitting this blocks any blob-backed `<video>`/`<audio>` identically on every browser), and SRI-pinned CDN resources (`https://cdn.jsdelivr.net`, `https://unpkg.com`).
- **CORS Allowlist**: Strictly locked to `https://guildmanagement.vercel.app`, `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:3000`, and authorized `https://*.vercel.app` preview environments.

---

## PART 2 — MODERNIZATION TARGET (`/src` ARCHITECTURE)

`/src` houses the modernized ES Module codebase — **`src/main.ts` has run live in production since the 2026-08-30 build-pipeline fix** (it is a real `<script type="module">` in `index.html`, not a dev/test-only entrypoint as previously documented here). Migration is genuinely incremental and partial: some ports are feature-complete and bridged onto `window.GM.*` (the subscription/donation view fully replaced its legacy `subscription.js`); others are not, and per the incident below, an unfinished port must **never** be bridged onto a `window.GM_*` global a legacy script also owns.
- **Reactive State Store** (`src/core/store/store.ts`): Centralized Pub/Sub state store with subscription disposers.
- **Web Worker Engine** (`src/workers/matchup.worker.ts`): Offloaded combinatorial computation for GvG/SvS dangerosity and draft mercato simulations.
- **BaseComponent Framework** (`src/components/ui/BaseComponent.ts`): Encapsulated UI component lifecycle with automatic listener cleanup.
- **i18n**: `src/core/i18n/i18n.ts` exists but is intentionally **not** the active dictionary — `main.ts` prefers the legacy `i18n.js`'s `GM_I18N.t`, since the `/src` dictionary only covers strings authored so far and would silently blank out every string outside it. Migrating i18n itself is unstarted.
- **Incident, resolved 2026-08-31 / feature removed 2026-09**: `svs-matchup.ts`/`gvg-matchup.ts` existed as 50-line stubs (hardcoded fake server/guild IDs, no real table render) that risked silently shadowing the complete legacy `svs-matchup.js`/`gvg-matchup.js` (700+ lines each) the moment `main.ts` started executing in production, since both write into the same DOM containers. The stubs were deleted first, then the whole Settings tab (Draft Mercato / SvS / GvG matchup) was removed entirely, so `svs-matchup.js`, `gvg-matchup.js`, `cross-rank.js` and `#tab-settings` no longer exist.

### Frontend Resilience & Main-Thread Performance (added 2026-09-13)

- **Network-error taxonomy** (`src/core/api/fetch-errors.ts`): every view loader classifies its failures through `mapFetchError()` into `offline` / `gateway` (502/503/504) / `rate_limited` (429) / `unauthorized` (401 / `jwt_expired` / invalid refresh grant) / `server` / `unknown`. `toastFetchError(err, ctx, retryFn?)` shows a non-blocking, classified toast and — for tab loads — mounts a body-level **Retry** banner wired to the caller's reload function. A 401 routes to the single session-invalidation flow (`handleSessionInvalidation()` in `core/api/supabase.ts`: storage purge of `sb-*`/`supabase.*` keys + `gm:session-expired` browser event → `doLogout()` / re-login), so expired sessions no longer degrade into silent empty tabs.
- **Per-view request lifecycle** (`src/modules/app/router.ts`): `triggerTabDataLoad()` owns one `AbortController` per load batch. Switching tabs aborts the previous batch before it resolves; redundant activations of the same tab while loading are ignored. `fetchGuildMembers()` receives the `AbortSignal` and passes it to the PostgREST builders via `.abortSignal(signal)`, so a tab switch cancels the 4-query roster batch instead of wasting requests.
- **Roster main-thread optimizations** (`src/modules/app/members/`):
  - DOM event delegation bound **once** on `document` (`wireRosterInteractions` → `bindRosterDelegation`) instead of per-node `addEventListener` re-binding on every render.
  - `calculateRallyScore` is memoized once per sort pass (O(n) + O(n log n)) instead of being recomputed inside every comparator invocation.
  - The Tactical Force Matrix sorts **once**: on rally views the memoized ranking *is* the display order; `sortMembers()` accepts the precomputed score map.
  - Max `overall_power` is precomputed in the store (`getMaxOverallPower()`, O(1)) instead of `Math.max(...map())` on every render.
  - Cold tab loads render an `aria-busy` skeleton (`membersSkeletonHtml()`) without clearing cached data on refresh.

> **Operational Invariant**: The Strangler migration is complete — `app.js` and the other legacy root scripts have been removed, and `/src` is now the single source of truth for all runtime behavior. `main.ts` assembles the `window.GM_*` bridge from typed modules; any new feature must live under `/src` and must never re-introduce a root `.js` runtime script or a new `window.GM_*` global (only the existing bridge surface may be extended).
