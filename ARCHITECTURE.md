# 🏗️ Architecture Specification & System Design — FGF Guild Management Tool

> **Status**: Authoritative Reference • **Standard**: August 2026 Production Specification  
> **Platform**: Multi-Tenant Serverless SaaS • **Single Source of Truth (SSOT)**

---

## PART 1 — CURRENT LIVE ARCHITECTURE (VERIFIED PRODUCTION REALITY)

### 1. High-Level System Topology

**FGF Guild Management Tool** is a serverless, multi-tenant SaaS tactical command and analytics platform built for competitive guilds in *Foundation Galactic Frontier*. The live production system combines classic vanilla JS root scripts running in the browser, Supabase PostgreSQL 17 with Row Level Security (RLS), and Deno TypeScript Edge Functions.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENT LAYER (Browser / PWA)                          │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Classic Vanilla JS Runtime Shell (`index.html` + Cache Busters `?v=XX`)           │  │
│  │ ├─ Core Utilities & Business Logic: `gm-utils.js`, `i18n.js`                     │  │
│  │ ├─ Admin Tactical Command Center: `app.js`, `events.js`, `history.js`, `stats.js` │  │
│  │ ├─ Player Self-Service Portal: `portal.js`, `push.js`                             │  │
│  │ ├─ Tactical Matchups & Rankings: `svs-matchup.js`, `gvg-matchup.js`, `cross-rank.js`│
│  │ ├─ Roster OCR Three-Section Review & Cascade Confirm: `app.js`, `gm-utils.js`     │  │
│  │ └─ Design System: Material Design 3.0 Tokens (`tokens.css`) + Apple Cozy Neutral  │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │ HTTPS / WSS / Cryptographic JWT
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   EDGE & SECURITY LAYER                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Supabase Deno TypeScript Edge Functions (`supabase/functions/`)                   │  │
│  │ ├─ Public (`verify_jwt = false`):                                                 │  │
│  │ │   ├─ `auth-login`: Bcrypt dual-read, lockout, IP rate limit, JWT issuer         │  │
│  │ │   ├─ `player-register`: Self-service member registration                        │  │
│  │ │   ├─ `event-reminders`: Cron-secret gated notification dispatcher (Vault)       │  │
│  │ │   └─ `gm-stripe-webhook`: Stripe webhook signature verification                 │  │
│  │ ├─ JWT-Gated (`verify_jwt = true`):                                               │  │
│  │ │   ├─ `member-portal`: Cryptographically resolved player portal backend          │  │
│  │ │   ├─ `admin-accounts`: Centralized admin role provisioner (`admin-authz.ts`)    │  │
│  │ │   ├─ `ocr-guild-members`: Gemini vision multimodal OCR parser                   │  │
│  │ │   ├─ `discord-webhook-proxy`: Whitelisted Discord webhook proxy (SSRF safe)     │  │
│  │ │   ├─ `gm-create-order`: Stripe subscription checkout session initializer        │  │
│  │ │   └─ `gm-order-status`: Order status reader and verification                    │  │
│  │ └─ Shared Modules: `_shared/auth.ts`, `_shared/logger.ts`, `_shared/rate-limit.ts`│  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │ Postgres Wire Protocol / RLS
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   DATABASE LAYER (Postgres 17)                          │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Supabase Postgres 17 (Multi-Tenant Schema with Zero-Trust Row Level Security)       │  │
│  │ ├─ 21 Relational Tables with Full RLS Enforcement                                 │  │
│  │ ├─ Security Definer Access Helpers with `SET search_path TO ''`                   │  │
│  │ ├─ Deterministic Event Session Generator: `public.gm_event_session_id()`           │  │
│  │ ├─ Distributed Audit Ledger: `public.system_audit_logs` (service_role only)       │  │
│  │ ├─ Vault-Backed Secrets: `vault.decrypted_secrets`                                │  │
│  │ └─ Automated pg_cron Jobs: Reminders, Demo Reset, Stale Lock Cleanup              │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

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
1. **`super_admin`**: Single global master account (`HawkEye`). Bypasses tenant RLS qualifiers. Accesses full Command Center, Draft Mercato, Server Matchups, and `#tab-tickets`.
2. **`server_admin`**: Reads and writes all tenant guilds sharing their assigned `server_number`. Uses server-scoped Guild Switcher.
3. **`guild_admin`**: Scoped strictly to own guild tenant (`accounts.guild`). Write operations require active SaaS subscription (`public.is_subscription_active()`).
4. **`member`**: **Zero direct database table access**. Communicates exclusively through the `member-portal` Edge Function.

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

#### 4.1 The 21 Database Tables:
- **Core Tenant Tables**: `guilds`, `guild_members`, `event_status`, `event_participants`, `glory_events`, `sanctions`, `guild_webhooks`, `guild_transfers`, `guild_subscriptions`, `guild_orders`.
- **Player Portal Tables**: `accounts`, `player_daily_challenges`, `player_event_scores`, `player_season_scores`, `player_badges`, `player_absence_requests`, `player_push_subscriptions`.
- **Security & Observability Tables**: `system_audit_logs`, `guild_audit_logs`, `login_throttle`, `event_reminders_log`.

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

---

### 5. AI Roster OCR Pipeline

```
[ Guild Admin Uploads Full Roster Screenshots ]
                       │
                       ▼
          [ POST /functions/v1/ocr-guild-members ]
                       │
                       ├─► Multimodal Gemini Vision Extraction
                       └─► Returns Parsed Raw Roster JSON: [{ pseudo, overall_power, role, uid? }]
                               │
                               ▼
        [ Client-Side Categorization: `gm-utils.js:categorizeOcrDiff` ]
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
  [ Existing ]      [ New ]      [ Removed ]
  (Power Updates)  (New Recruits) (Missing from OCR)
                       │             │
                       ├─ Enter UID  ├─ Proposed Remove by Default
                       │  (No TEMP)  └─ Per-Row Keep/Remove Toggle
                       │
                       ▼
          [ Live Counter: Roster N → M ]
                       │
                       ▼
          [ Commit Roster Changes ]
                       │
                       ├─ IF removals present: Show Confirmation Dialog listing every deleted pseudo
                       └─ Upsert/Delete records with transactional integrity
```

---

### 6. Deployment & Infrastructure Topology

- **Production Frontend**: Hosted on Vercel at `https://guildmanagement.vercel.app` (branch `main`).
- **Content Security Policy (CSP)**: Hardened policy with `frame-ancestors 'none'`, `object-src 'none'`, and SRI-pinned CDN resources (`https://cdn.jsdelivr.net`, `https://unpkg.com`).
- **CORS Allowlist**: Strictly locked to `https://guildmanagement.vercel.app`, `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:3000`, and authorized `https://*.vercel.app` preview environments.

---

## PART 2 — MODERNIZATION TARGET (`/src` ARCHITECTURE)

The `/src` directory houses the modernized ES Module codebase targeted for subsequent incremental migration:
- **Reactive State Store** (`src/core/store/store.ts`): Centralized Pub/Sub state store with subscription disposers.
- **Web Worker Engine** (`src/workers/matchup.worker.ts`): Offloaded combinatorial computation for GvG/SvS dangerosity and draft mercato simulations.
- **BaseComponent Framework** (`src/components/ui/BaseComponent.ts`): Encapsulated UI component lifecycle with automatic listener cleanup.
- **Modern Entrypoint** (`src/main.ts`): Bundled via Vite for dev server and testing environments.

> **Operational Invariant**: Until `/src` components are fully linked and verified in the production entrypoint, **Part 1 remains the authoritative source of truth for live runtime behavior**.
