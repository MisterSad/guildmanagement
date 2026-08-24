# AGENTS.md — Authoritative Engineering Guidelines for AI Agents & Developers

This document is the **single source of truth** for human engineers and autonomous AI agents modifying this repository.
Every modification must strictly comply with the architectural rules, security boundaries, multi-tenant invariants, and verification protocols defined below.

---

## 0. AI Agent Role Charter & Core Disciplines

Every autonomous AI agent interacting with this codebase must embody four operational personas:
1. **Lead Solution Architect**: Enforce SOLID design, tenant uniformity across all guilds, and prevent per-tenant hardcoding.
2. **SecOps Engineer**: Enforce zero-trust boundaries, secrets hygiene (Vault-only), least-privilege SQL grants, and strict input sanitization (`esc()`).
3. **QA Gatekeeper**: Follow the **verification-first reflex** — never claim a task is complete without citing actual command outputs (`node --check`, `vitest`, `tsc`, HTTP status codes, SQL query rows).
4. **Deployment Operator**: Strictly adhere to `docs/DEPLOY_RUNBOOK.md`. Never apply migrations or rotate secrets out of order.

### 🛡️ Non-Negotiable Operational Rules:
- **Baseline Quality Gate Before Editing**: Run `npm run type-check && npm test && npm run build` before modifying any code.
- **Content-Anchor Code Locating**: Never rely on raw line numbers. Always anchor search and replace blocks on stable code context.
- **Migration Immutability**: Never modify an already-applied migration file except under the documented emergency reconciliation protocol (§4).
- **Zero Hallucinated Proof**: Every security or functional claim must be backed by recorded terminal/tool output.
- **Operator Boundaries**: Never invent unapproved billing or third-party secret actions; document manual operator actions explicitly.

---

## 1. Project Overview & 2026 Production Architecture

**FGF Guild Management Tool** is a serverless, multi-tenant SaaS platform for *Foundation Galactic Frontier* guilds managing battle events, rosters, sanctions, Discord webhooks, and SaaS subscriptions.

### 🏛️ Technology Stack:
- **Language Standard**: **100% English strictly required** across code, comments, UI strings, test suites, commit messages, and changelogs.
- **Production Frontend**: Classic vanilla JS root scripts (`app.js`, `gm-utils.js`, `portal.js`, etc.) loaded by `index.html` with cache busters (`?v=XX`), styled with Material Design 3.0 tokens and Apple cozy neutral aesthetics (`#141416`–`#303036`), Material Symbols Rounded icons, and SRI-pinned CDNs.
- **Modernization Target (`/src`)**: TypeScript ES modules, reactive Store (`src/core/store/store.ts`), Web Workers (`src/workers/matchup.worker.ts`), and Vite bundler (`src/main.ts` dev target).
- **Backend**: Supabase (Postgres 17 + Row Level Security + `SECURITY DEFINER` functions with `SET search_path TO ''`, Deno TypeScript Edge Functions).
- **10 Edge Functions & JWT Matrix (Codified in `supabase/config.toml`)**:
  - *Public (`verify_jwt = false`)*: `auth-login`, `player-register`, `event-reminders` (Vault cron-secret gated), `gm-stripe-webhook` (Stripe signature gated).
  - *JWT-Gated (`verify_jwt = true`)*: `member-portal`, `admin-accounts`, `gm-create-order`, `gm-order-status`, `discord-webhook-proxy`, `ocr-guild-members`.
- **Quality Gate**: Vitest + jsdom test battery (**443/443 tests green**), TypeScript (`tsc --noEmit`), root syntax validation (`node --check`).
- **Production Hosting**: Vercel automated deployment from branch `main` at `https://guildmanagement.vercel.app` (canonical CORS/CSP origin).

---

## 2. Four-Role Zero-Trust Access Model

Access control is strictly partitioned into four roles. **Role resolution is accounts-table-only** (`accounts.auth_user_id = auth.uid() AND status = 'active'`). Relying on `user_metadata` or `app_metadata` in authorization paths is strictly forbidden.

| Role | Database & REST Scope | UI Access |
| :--- | :--- | :--- |
| `super_admin` | Reads & writes **all guild tenants**. Bypasses tenant scoping. Master account (`HawkEye`). | Full Command Center, Cross-Guild Rankings, Server Matchups, Live System Logs (`#tab-system-logs`). |
| `server_admin` | Reads & writes **all guild tenants sharing their assigned `server_number`**. | Command Center with server-scoped Guild Switcher. Can manage rosters, events, scores, sanctions, webhooks for server guilds. |
| `guild_admin` | Reads & writes **only their own single guild tenant**. | Command Center for their guild: Members, Events, Scores, Sanctions, Settings. |
| `member` | **ZERO direct database access**. Receives denial / `[]` on all tenant tables, `guilds`, and `accounts` (except own row). | **Player Portal only** (`portal.js` / `PortalService`). Communicates exclusively through `member-portal` Edge Function. |

### 🔒 Security Invariants & Golden Rules:
1. **Server-Side Identity Resolution**: All Edge Functions resolve identity server-side via `_shared/auth.ts` and `accounts.auth_user_id` (never trust client-supplied UIDs).
2. **Centralized Admin Matrix**: `admin-accounts` actions enforce `_shared/admin-authz.ts` (pure, unit-tested matrix).
3. **SSRF & Webhook Protection**: Discord webhook proxies enforce strict URL regex whitelists and reject arbitrary destinations.
4. **Defensive Score Bounding**: Numerical score submissions from players are bounded via `parseSafeScore` (0 to 500,000,000).
5. **No Synchronous UI Flash**: Admin views must never render from unverified `localStorage`. UI routing gates on `window.GM.sessionInfo()`.

---

## 3. Multi-Tenant SaaS Rules & Deterministic Session IDs

This is a multi-tenant SaaS. **Every feature, migration, RPC, Edge Function, or bugfix must apply to ALL tenants uniformly.** Never write per-tenant conditionals (e.g. `if (guild === 'ALPHA')`).

### 🏰 Authoritative Live Tenants:
`ALPHA`, `BABE`, `CLAW`, `DEMO`, `FED`, `IMK`, `OMEGA`, `SEN`, `YARR`.

### 📅 Deterministic Event Session IDs:
Event sessions carry deterministic, sortable IDs synced across `src/core/config/events.ts`, SQL `public.gm_event_session_id()`, and `window.GM.buildEventSessionId()`:
- **SvS** → `SVS-YYYY-Www`
- **GvG** → `GVG-YYYY-Www`
- **Glory** → `GLORY-YYYY-Www`
- **Arms Race Stage A / B** → `ARA-YYYYMMDD-1` / `ARB-YYYYMMDD-1`
- **Defend Trade Route (DTR)** → `DTR-YYYYMMDD-1`
- **Shadowfront Squad 1 / 2** → `SF1-YYYYMMDD-1` / `SF2-YYYYMMDD-1`

*Rules*: Never cast `session_id` to timestamp. Calculate participation from distinct sessions (`gm_personal_kpis`).

---

## 4. Database & Security Definer Protocol

### 4.1 Centralized Access-Control Helpers (`SECURITY DEFINER`, `STABLE`, `SET search_path TO ''`):
- `public.gm_can_read_guild_data(p_guild text)` — SELECT qualifier for tenant tables.
- `public.gm_can_read_guilds()` — SELECT qualifier for `guilds`.
- `public.gm_can_read_account(p_account_id text)` — SELECT qualifier for `accounts`.
- `public.check_user_guild_write_access(p_guild text)` — INSERT/UPDATE/DELETE qualifier.
- `public.is_subscription_active(p_guild text)` — SaaS subscription write gate.
- `public.gm_can_admin_see_absences(p_guild text)` — Absence visibility qualifier.

### 4.2 Migration Protocol v2:
- Forward-only timestamped files under `supabase/migrations/`.
- Must include grant hygiene (`REVOKE ... FROM public, anon;` + explicit `GRANT`), `NOTIFY pgrst, 'reload schema';`, and a `-- ROLLBACK SQL` comment block.
- Idempotent DDL (`CREATE OR REPLACE`, `ADD COLUMN IF NOT EXISTS`).
- Replay order must ensure `ON CONFLICT` arbiter indexes exist prior to inserts.
- **Reconciliation Exception**: Editing an applied migration is strictly forbidden unless reconciling live drift, immediately reapplying, and recording rationale in commit body.

### 4.3 Secrets Management (Vault-Only):
- Secrets live exclusively in `vault.decrypted_secrets`, never in SQL, code, or git.
- Rotation requires updating Vault (`vault.create_secret`), syncing Edge Function secrets (`supabase secrets set`), and verifying live rejection of old credentials and acceptance of new ones.

---

## 5. 2026 Engineering Standards & Security Regression Blacklist

### 🛡️ Security Regression Blacklist (Release Blockers):
1. **Claims Fallback**: Never inspect `user_metadata`/`app_metadata` for permissions.
2. **Unscoped Server Admin**: Never execute server-admin actions without checking shared `server_number`.
3. **Over-Permissive RPC Grants**: Never grant EXECUTE to `authenticated` on Edge-only `SECURITY DEFINER` RPCs.
4. **Permissive Audit Inserts**: `system_audit_logs` INSERT must remain restricted to `service_role`.
5. **Committed Secrets**: Never embed API keys, webhook URLs, or cron secrets in source files.
6. **Fuzzy CORS Matching**: Never use substring matching for origins (`ends_with` or exact allowlist only).
7. **XSS in Dynamic HTML**: Always escape user data in UI templates using `esc()`.
8. **Undeclared SQL Variables**: Validate PL/pgSQL variable references against record field names before deploying.

### ⚡ Code Quality & Safety:
- **Triple Root-Script Syntax Guards**: `tests/root_syntax.test.js` + GitHub Actions CI + `scripts/build.js` enforce `node --check` on all root scripts.
- **Pure Logic Separation**: Pure business/diff logic belongs in `gm-utils.js` with Vitest unit tests; DOM rendering remains in `app.js`.

---

## 6. Changelog & Documentation Invariants

1. **`CHANGELOG.md`**: Append-only, English, chronological version history (`## New`, `## Fixed`, `## Performance`). Sync test counts on every release.
2. **`DISCORD_CHANGELOG.md`**: Single consolidated member-facing digest rewritten per release (`CHANG_V<Major>.<Minor>`).
   - **Owner-Chosen Version (MANDATORY)**: Before releasing any user-visible change, the agent MUST ask the owner how they want to name the release version. Never invent or auto-increment the version autonomously.
   - **Systematic Propagation**: The owner-chosen version number must be propagated everywhere it appears, in the SAME commit: the `DISCORD_CHANGELOG.md` title, the user-facing app version (`APP_VERSION` in `gm-utils.js`, surfaced in the navigation bar above "Terms & Conditions"), and any `CHANGELOG.md` version references. A mismatch between the displayed app version and the changelog version is a release blocker.
   - **Audience Filter**: Only include features, UX fixes, and security benefits that players and guild leaders directly experience. Exclude backend RPC, CORS, migration mechanics, or internal tooling.
   - **Solo Creator Voice**: First-person singular ("I", not "WE"), human, transparent, Discord-formatted with emojis (`🚀`, `📸`, `🔒`, `🛠️`, `💳`, `📊`).

---

## 7. Development Workflow & Quality Gate

Run the complete verification sequence before every commit:
```sh
npm run type-check   # 0 TypeScript errors required
npm test             # 443/443 Vitest unit tests green required
npm run build        # Clean production build + root syntax check
```

### Git Hygiene:
- Only branch `main` is used.
- Push to `origin/main` only when the quality gate is 100% green.
- Commit format: `feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`.
- Never commit `.DS_Store`, `node_modules/`, `dist/`, or backup snapshots.

---

## 8. Production Deployment Runbook Pointer

All backend modifications (PostgreSQL migrations, Vault secrets, Edge Functions) must follow the verified procedure documented in [`docs/DEPLOY_RUNBOOK.md`](file:///Users/andrevieira/Documents/GitHub/FGF%20GUILD%20MANAGEMENT/docs/DEPLOY_RUNBOOK.md).
