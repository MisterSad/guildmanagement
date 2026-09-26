# 🏗️ Architecture Specification & System Design — FGF Guild Management Tool

> **Status**: Authoritative Reference • **Standard**: August 2026 Production Specification  
> **Platform**: Multi-Tenant Serverless SaaS • **Single Source of Truth (SSOT)**

---

## PART 1 — CURRENT LIVE ARCHITECTURE (VERIFIED PRODUCTION REALITY)

#
> **Tenant resolution (finding H2).** `getActiveGuild()` returns `string | null` and never invents a tenant. It is the single resolver — four modules used to re-implement its fallback chain, each ending in a hardcoded `'ALPHA'`, so an unresolved guild silently became a real, populated one. `canWriteGuild()` refuses a null tenant for **every** role including `super_admin`, which is what makes `db-guard` block the write and surface `READ_ONLY_MESSAGE` instead of stamping `guild: null`. Per-guild values such as the guild tag live in `guild_config`, never in a table in the client. `tests/alpha_fallback_removed.test.js` fails on any new tenant literal in `src/`.

## 1. High-Level System Topology

**FGF Guild Management Tool** is a serverless, multi-tenant SaaS tactical command and analytics platform built for competitive guilds in *Foundation Galactic Frontier*. The live production system is a single TypeScript/ESM frontend (`/src/main.ts`), backed by Supabase PostgreSQL 17 with Row Level Security (RLS) and Deno TypeScript Edge Functions. Phase 7 replaced most of the `window.GM_*` bridge with typed imports; what remains of it, and why, is in PART 2. The former root monolith `app.js` was removed in the Strangler final cutover. The project root now holds no application script at all — only tooling configs (`playwright.config.js`, `vitest.config.js`) — and `src/sw/service-worker.ts` is now a self-destructing tombstone — the PWA was removed in Phase 2 — still compiled to the root-scoped `dist/sw.js` by esbuild in `scripts/build.js` because that is the only way an already-installed worker can be retired. See §6.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                     CLIENT LAYER (Browser)                              │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ TypeScript / ESM Frontend (`index.html` + `/src/main.ts` module)              │  │
│  │ ├─ Core Utilities & Legacy Bridge: `/src/core/gm-bridge.ts` (window.GM)        │  │
│  │ ├─ Admin Command Center: `/src/modules/app/admin/*` (accounts, requests,       │  │
│  │ │   guilds, migration groups), EventsView/StatsView (`/src`)                   │  │
│  │ ├─ Player Self-Service Portal: PortalView (`/src`)                             │  │
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
│  │ Supabase Deno TypeScript Edge Functions (`supabase/functions/`) — 15 live         │  │
│  │ ├─ Public (`verify_jwt = false`):                                                 │  │
│  │ │   ├─ `auth-login`: Bcrypt dual-read, lockout, IP rate limit, JWT issuer         │  │
│  │ │   ├─ `auth-passkey`: Passkeys/WebAuthn — register, sign in (scoped or fully     │  │
│  │ │   │   discoverable across accounts), backup codes, admin reset escape hatch     │  │
│  │ │   ├─ `player-register`: Self-service member registration                        │  │
│  │ │   ├─ `guild-request`: Public guild self-service request submission (reviewed    │  │
│  │ │   │   manually by a super_admin; provisions nothing on its own)                 │  │
│  │ │   ├─ `event-reminders`: Cron-secret gated notification dispatcher (Vault),      │  │
│  │ │   │   fans out to Discord webhooks (Web Push was removed in Phase 2)            │  │
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
│  │ │       ├─ `guild-data-export`: Guild data export (JWT-gated)                     │  │
│  │ │       ├─ `tickets`: Bug-report ticketing console backend                        │  │
│  │ │       └─ `migration-summary`: Gemini summariser for the Migration Hub wiki      │  │
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
│  │ ├─ 38 persistent tables, all RLS + FORCE RLS, 87 policies                         │  │
│  │ ├─ Security Definer Access Helpers with `SET search_path TO ''`                   │  │
│  │ ├─ Deterministic Event Session Generator: `public.gm_event_session_id()`           │  │
│  │ ├─ Distributed Audit Ledger: `public.system_audit_logs` (service_role only)       │  │
│  │ ├─ Vault-Backed Secrets: `vault.decrypted_secrets`                                │  │
│  │ └─ Automated pg_cron Jobs: Reminders, Demo Reset, Stale Lock Cleanup              │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

> **⚠️ Payments were removed entirely on 2026-09-26 (Phase 1)**. Deleted from the platform: `gm-create-order`, `gm-order-status`, `gm-stripe-webhook`, and two functions that were **live with no source in this repository** — `gm-revolut-webhook` (ACTIVE, version 13, `verify_jwt = false`, i.e. public) and `webauthn-spike` (a leftover probe). Earlier revisions of this document asserted in a warning box that `gm-revolut-webhook` did **not** exist and should be kept out of deployment matrices; it existed and was serving traffic. Treat this as the standing invariant instead: **every deployed Edge Function must have its source versioned here**, and the deployed set must be reconciled against `supabase/functions/` rather than against prose.

> **Reconciled 2026-09-27: 15 deployed, 15 in the repository, zero drift in either direction.** `auth-discord` is the newest (Discord OAuth, Phase D2). `admin-accounts` is now genuinely `verify_jwt = true`, matching `config.toml` — it had been deployed as `false` while both the config and this document claimed otherwise (finding M1). Re-run the reconciliation with `list_edge_functions` against `ls supabase/functions/`; `tests/supabase_config_functions.test.js` covers the repo-internal half (every directory has a `[functions.*]` block and vice versa), but nothing in CI can see the platform, so this one is a runbook step, not a test.

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
3. **`guild_admin`**: Scoped strictly to own guild tenant (`accounts.guild`). Write operations still pass through `public.is_subscription_active()`, which has been a literal `SELECT true` since `20260824000000_free_app_and_donations.sql` — the app is free and the gate is inert. It survives only because ~44 RLS clauses call it; removing it means rewriting all of them, which is a lot of its own (deferred, Phase 4.14).
4. **`member`**: **Zero direct database table access**. Communicates exclusively through the `member-portal` Edge Function.

> These are the **only** values `accounts.role` may hold — the DB enforces it via the `accounts_role_check` CHECK constraint (column default `member`). The legacy virtual/in-game ranks (`R5`, `R4`) and the historical `admin` alias were **retired on 2026-09-13** and are rejected by the constraint; no helper maps them to elevated access anymore.

#### 2.1 Passkeys / WebAuthn (Alternate Sign-In, added 2026-09)
Any account (admin or portal) can additionally register a Passkey per device instead of typing a password every time. Backed by `@simplewebauthn/server@10.0.1` (server-side crypto only — no `@simplewebauthn/browser` client dependency; `gm-webauthn.js` hand-rolls the base64url/ArrayBuffer marshalling to avoid adding a new CDN origin).
- **Registration**: `auth-passkey` `register-options`/`register-verify` (JWT-authenticated). First passkey on an account also issues 10 one-time backup codes (SHA-256 hashed, shown once).
- **Sign-in**: `auth-options`/`auth-verify` (unauthenticated — this *is* the login flow). Supports both a **scoped** ceremony (an id was typed, narrows the browser's picker to that account) and a **fully discoverable** one (no id — the picker shows every passkey registered for the site across every account; the credential's own `userHandle` resolves which account server-side, never anything the client claims). Conditional UI (`mediation: 'conditional'`, tied to `autocomplete="webauthn"` fields) runs in parallel so password-manager extensions (Proton Pass, Bitwarden, 1Password) that don't reliably support the modal picker still work via autofill-style suggestions.
- **iOS constraint**: the WebAuthn UX used to be materially better inside an installed PWA. The PWA was removed in Phase 2, so the passkey flow now runs in a plain browser tab everywhere; there is no install step and no §6 push constraint to cross-reference any more.
- **Admin escape hatch**: `admin-reset-passkeys` action revokes every passkey + backup code for a target account (lost every device and the codes), gated by the same `canManageAccount`/`admin-authz.ts` matrix as the manual password-reset flow. R5 is not specially protected here (unlike the rank-assignment matrix) — the existing role hierarchy check already prevents managing an equal-or-higher role.
- **Rate limiting**: `auth-passkey` and `auth-login` share one IP budget (`login_throttle`, keyed purely by IP, not by which function calls it) — a passkey sign-in costs 2 requests (options + verify), and the conditional/autofill listener adds a background options call on every page load. Widen this budget (not the per-function limit) if login attempts start getting throttled after adding another auth-adjacent feature.

#### 2.2 Strict Role Isolation & Session Invalidation (added 2026-09-13)

- **Canonical roles only**: `accounts_role_check` restricts `accounts.role` to exactly `{ super_admin, server_admin, guild_admin, member }` (default `member`). The legacy in-game/virtual ranks `R5`/`R4`/`admin` are **forbidden at the database level** — the client-side and edge-side `normalizeRole()` (in `_shared/admin-authz.ts`) maps any such value to `member`, never to an elevated role.
- **Exact authorization helpers**: `is_super_admin()`, `is_server_admin()` and `gm_can_read_guilds()` now resolve the caller **exclusively** from `public.accounts` (`auth_user_id = auth.uid()` AND `status = 'active'`) with zero role aliasing and zero metadata fallback. All RLS policies that reference them inherit the tightened semantics (e.g. `server_migration_groups` writes now require a true `super_admin`).
- **Session-invalidation epoch (M4)**: `public.accounts.session_version` (integer, default 0) is bumped on every privileged account event — password reset, role change, suspension (`admin-accounts` `bumpSessionVersion()`). `public.gm_session_is_valid()` compares that epoch against the JWT's `app_metadata.session_version` claim, which the shadow-session minting path (`_shared/shadow-session.ts`) stamps on every create/refresh. Enforcement is real as of `20260926250000_real_session_revocation.sql` (**finding C1**): before it, `gm_session_is_valid()` existed and was correct but **no policy invoked it**, so the gate it documented did not exist. It is now folded into the six helper functions the policies actually call — `check_user_guild_write_access`, `gm_can_read_guild_data`, `is_super_admin`, `check_user_guild_access`, `gm_can_read_guilds`, `gm_is_admin_caller` — which together back 77 policy references, so no policy had to be edited. The same comparison runs in `_shared/session-epoch.ts`, consulted by `validateCallerAuth` and by the three functions that validate their own JWT (`admin-accounts`, `member-portal`, `auth-passkey`), because RLS cannot protect an Edge Function that queries with the service key. The check is **absent-tolerant**: a token carrying no `session_version` claim is accepted as legacy, a token carrying a *stale* one is refused. That distinction is load-bearing — 122 of 171 GoTrue users had no such claim, and a strict check would have cut database access for 71% of the user base at deploy.
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

#### 4.1 Database Tables (**38 persistent tables**, counted live 2026-09-27; all have RLS *and* FORCE RLS, across 87 policies):
- **Core Tenant / Roster** (19): `guilds` (**26 rows**, 1 is `DEMO`), `guild_members` (**~3,005 rows**), `event_status`, `event_participants` (**~55,760 rows** — the permanent attendance ledger), `war_opponents`, `war_sessions`, `event_daily_scores`, `event_chest_tiers` (SvS/GvG granular war — added 2026-09-13, see §4.4), `shadowfront_squads` (weekly squad *assignments* — does not reliably retain history once a later session overwrites it, unlike `event_participants`; see the Shadowfront attendance-rate note below), `shadowfront_signups`, `weekly_scores`, `sanctions`, `banned_players`, `guild_config`, `guild_transfers`, `player_name_history`, `player_metrics_history`, `server_migration_groups`, `server_migration_group_servers`. `diplomatic_treaties` was dropped in Phase 3 (0 rows, no UI).

> **These figures were counted against production on 2026-09-27, not estimated.** The previous set (13 / ~1,540 / ~33k) understated the live system by roughly a factor of two and had been carried forward unchecked. Re-measure rather than adjust: `SELECT count(*)` on the three tables.
- **Accounts & Identity** (8): `accounts` (custom bcrypt credential store, source of truth — see §2), `login_throttle` (shared IP rate limit for `auth-login` + `auth-passkey`), `webauthn_challenges`, `account_passkeys`, `account_backup_codes` (Passkeys/WebAuthn, added 2026-09), `discord_account_links`, `discord_link_codes`, `discord_verification_throttle` (Discord account linking + verification rate limiting, added 2026-09).
- **Self-Service Requests** (1): `guild_creation_requests` (public `guild-request` submissions, reviewed by `super_admin`).
- **Player Portal** (1): `player_absences`. `player_push_prefs` was dropped with Web Push in Phase 2.
- **Notifications** (0): none. `push_subscriptions` was dropped in Phase 2 — Discord is the only notification channel.
- **Leader Hall E2EE (Signal Protocol) — removed entirely (0)**: the seven `e2ee_*` tables are dropped. Verified against `pg_class`, not assumed from a migration file.
- **Support** (1): `tickets` (in-app bug-report console). `gm_payments` was dropped in Phase 1 with the rest of the payment surface.
- **Observability** (1): `system_audit_logs` (service_role-only INSERT).

> **Count note**: count tables from `pg_class`, never from the number of `CREATE TABLE` statements in the migration chain — the chain also contains the drops, so the two diverge every time something is removed, which is how this document came to claim 42. As of 2026-09-27 there are **38**, every one with RLS and FORCE RLS enabled. Phases 1–3 dropped `gm_payments`, `diplomatic_treaties`, the seven `e2ee_*` tables and the two Web Push tables; `tmp_demo_roster` is a session-scoped `TEMP` staging table and never appears in the count.

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

### 6. Notifications — Discord only (Web Push and the PWA removed, Phase 2)
Discord is the **only** notification channel. `event-reminders` dispatches to each guild's own webhooks on its cron tick; there is no second fan-out.

Web Push and the PWA were removed entirely: `src/modules/push/PushService.ts`, `src/core/pwa/pwa.ts`, `src/sw/push-payload.ts`, `manifest.webmanifest` and the five install-only PNG icons (612 KB) are gone, as are the `push_subscriptions` and `player_push_prefs` tables and the `save_push_subscription`, `gm_get_push_prefs` and `gm_set_push_prefs` RPCs. The service worker never had a `fetch` handler and never touched Cache Storage, so it provided no offline capability and no caching — only installability, which nothing needed.

- **`src/sw/service-worker.ts` still exists, and must keep shipping.** It is a self-destructing tombstone whose only job is `registration.unregister()`. Deleting a service worker's source does not uninstall it: a worker already installed on a member's device runs forever, independently of the page that registered it, and goes away only when the browser can fetch a **new** `/sw.js` from that exact URL and watch it unregister. The source, the esbuild block in `scripts/build.js` and the dev plugin in `vite.config.ts` must be removed together, and only after the tombstone has been live for a full release cycle. Check before touching it:
  ```
  curl -sS https://guildmanagement.vercel.app/sw.js | grep -c unregister
  ```
  `0` means the tombstone is not deployed yet. `tests/phase2_pwa_retirement.test.js` enforces the all-or-nothing rule and that `/sw.js` is served revalidating — cache it and the kill switch never arrives.
- **Offline copy**: `src/core/net/network-status.ts` says changes will **not** be saved. It used to promise "Local changes will sync when online", which was false — there is no write queue and no background sync anywhere in the app, so offline writes are simply lost.
- **CSP dependency**: the uploaded-file `<video>` blob and any future blob-backed media element depend on `media-src` explicitly including `blob:` in `vercel.json` — `default-src 'self'` does **not** cover it by CSP-spec fallback, and this silently blocks the resource identically on every browser (not a codec/compat issue) if ever dropped. Confirmed live via `document.addEventListener('securitypolicyviolation', ...)` when this shipped without it.

### 7. Leader Hall — End-to-End Encrypted Messaging (removed 2026-09)
The Leader Hall feature (1:1 and group Signal-Protocol messaging between guild leadership) has been **removed entirely from the front-end**: `gm-signal-crypto.js`, `gm-leader-hall.js`, `noble-crypto.bundle.js`, the `/src` port and the `#tab-leader-hall` DOM are gone. The server-side `e2ee_*` tables and the `gm_is_leader_caller` RPC have since been dropped too (Phase 3), so nothing of the feature remains in either layer.

---

### 8. Deployment & Infrastructure Topology

- **Production Frontend**: Hosted on Vercel at `https://guildmanagement.vercel.app` (branch `main`).
- **Content Security Policy (CSP)**: Hardened policy with `frame-ancestors 'none'`, `object-src 'none'`, `media-src 'self' blob:` (see §6 — omitting this blocks any blob-backed `<video>`/`<audio>` identically on every browser), Sentry APM ingest (`*.ingest.sentry.io`), and **zero external CDN scripts** (`cdn.jsdelivr.net` and `unpkg.com` eliminated; `@phosphor-icons/web` packaged locally).
- **CORS Allowlist**: Strictly locked to `https://guildmanagement.vercel.app`, `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:3000`, and authorized `https://*.vercel.app` preview environments.

---

### 9. Production Security & Quality Hardening (September 2026)

- **FORCE ROW LEVEL SECURITY across 100% of public tables** ([ADR-010](./docs/adr/ADR-010-force-row-level-security-all-public-tables.md)): Multi-tenant isolation is enforced even against table owners and superusers via `FORCE ROW LEVEL SECURITY` on all 26 active public tables and any new tables (`ocr_cache`).
- **Client Error Reporting & Sentry APM** ([ADR-011](./docs/adr/ADR-011-client-error-reporting-and-sentry-apm.md)): `ClientLogger` routes crash telemetry through the rate-limited `public.gm_report_client_error` RPC (`search_path = ''`). Production runtime crashes are captured by `@sentry/browser` with strict PII and token scrubbers.
- **SHA-256 OCR Deduplication Cache** ([ADR-012](./docs/adr/ADR-012-sha256-ocr-deduplication-cache.md)): Gemini Vision roster analysis computes a canonical SHA-256 fingerprint over image buffers and scan metadata, serving cache hits in <50ms with `cached: true` and persisting entries in `public.ocr_cache` with a 7-day TTL.
- **WCAG 2.2 Level AA Modal Accessibility** ([ADR-013](./docs/adr/ADR-013-wcag-2-2-aa-dialog-accessibility-and-focus-trap.md)): `Dialog.ts` applies dynamic semantic roles (`alertdialog` for `tone: 'danger'`, `dialog` otherwise), traps keyboard focus bidirectionally, sets `aria-hidden="true"` on `#app` during modal display, and restores focus to `previouslyFocused` on dismissal.
- **Root Scripts Hygiene & Discord Webhook Resilience** ([ADR-014](./docs/adr/ADR-014-root-scripts-hygiene-and-discord-webhook-resilience.md)): `scripts/build.js` strictly excludes test configs (`playwright.config.js`, `vitest.config.js`) from `dist/`, legacy maintenance scripts are archived in `scripts/archive/`, and `discord-webhook-proxy` enforces 30 req/min IP rate limiting and natively propagates Discord HTTP 429 `Retry-After` delays.

---

## PART 2 — MODERNIZATION TARGET (`/src` ARCHITECTURE)

`/src` is now the whole codebase. `src/main.ts` is the single `<script type="module">` in `index.html`, the root monolith is gone, and Phase 7 dismantled most of the `window.GM_*` bridge: the router and the views resolve each other by **typed import**, so renaming a loader is a compile error rather than a tab that silently stops loading. Three names survive on `window` deliberately — `GM_APP` and `GM_I` because `core/` must not import `modules/` (the toast implementation `GM_APP.showToast` points at lives in `core/dom/toast.ts`, so importing the app's renderer there would invert the layering), and `GM_COLLAPSED_ROLES` because it is a mirrored state global rather than a method bridge. `tests/gm_bridge_contract.test.js` pins that list so it cannot quietly grow.
- **App state** (`src/core/state/app-state.ts`): the single write path for cross-cutting state (active tenant, guild list, roster selection). It still mirrors onto `window` for the bridge and for the tests that seed state by assignment, but reads are pure and hydration is absence-aware. The old Pub/Sub `src/core/store/store.ts` was dead — `subscribe()` was never called — and was deleted in Phase 3.
- **Web Worker Engine** (`src/workers/matchup.worker.ts`): Offloaded combinatorial computation for GvG/SvS dangerosity and draft mercato simulations.
- **BaseComponent Framework** (`src/components/ui/BaseComponent.ts`): Encapsulated UI component lifecycle with automatic listener cleanup.
- **i18n**: Fully served by `/src/core/i18n/i18n.ts` (Strangler cutover), bridging the complete dictionary to `window.GM_I18N` and `window.GM.t`.
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
