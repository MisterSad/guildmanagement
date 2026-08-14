# AGENTS.md — Authoritative Engineering Guidelines for AI Agents & Developers

This document is the **single source of truth** for all human engineers and autonomous AI agents modifying this repository.
Every modification must strictly comply with the architectural rules, security boundaries, multi-tenant invariants, and verification protocols defined below.

---

## 1. Project Overview & 2026 Modern Architecture

**FGF Guild Management Tool** is a serverless, multi-tenant SaaS platform that helps guilds in the game *Foundation Galactic Frontier* manage battle events, member rosters, participation rates, sanctions, Discord webhooks, and SaaS subscriptions.

### 🏛️ Technology Stack & Structure
- **Language & Documentation Standard**: **100% English strictly required** across all code, comments, UI text, test suites, commit messages, and changelogs.
- **Frontend Architecture**: Modernized ES Modules under `/src`, strict TypeScript (`tsc --noEmit`), Vite production bundler (`vite build`), reactive Pub/Sub Store (`src/core/store/store.ts`), Web Workers for heavy computations (`src/workers/matchup.worker.ts`), component-based UI (`src/components/ui/BaseComponent.ts`), Phosphor Icons, Three.js 3D login background scene, installable PWA.
- **Backend Architecture**: Supabase (Postgres 17 + Row Level Security + `SECURITY DEFINER` functions with `SET search_path TO ''`, Deno TypeScript Edge Functions).
- **Canonical Schema**: Database migrations consolidated into 4 master DDL files under `supabase/migrations/`. Sample and dev seed data isolated in `supabase/seeds/dev_seed.sql`. Legacy migration history safely archived in `supabase/migrations_archive/`.
- **Distributed Observability & Structured Logging**: Standardized JSON logging on both Edge Functions (`supabase/functions/_shared/logger.ts`) and browser client (`src/core/logger/logger.ts`) with correlation IDs, execution latency tracking, automatic credential sanitization, and persistent audit logs in `public.system_audit_logs`.
- **CI/CD Pipeline**: GitHub Actions (`.github/workflows/ci.yml`) running static type verification, unit test battery, and production build on every push to `main`.
- **Quality Gate**: Vitest + jsdom test battery (**219/219 tests green**).
- **Production Hosting**: Vercel automated deployment from branch `main` with hardened Content Security Policy (CSP).

---

## 2. The Three-Role Zero-Trust Access Model (CRITICAL)

Access control is strictly partitioned into three roles. **Never blur the boundaries.**

| Role | Database & REST Scope | UI Access |
| :--- | :--- | :--- |
| `super_admin` | Reads & writes **all guild tenants**. Bypasses tenant scoping. Single account (HawkEye). | Full Admin Command Center + Cross-Guild Draft Ranking, Server Matchups, and Live System Logs & Diagnostics console (`#tab-system-logs`). |
| `guild_admin` | Reads & writes **only their own guild tenant** rows (tenants: `ALPHA`, `OMEGA`, `BABE`, `IMK`, `YARR`, `CLAW`, `DEMO`, `SEN`, `NIGHTWRAITH`, `OBSIDIANSTAR`, `ASTRAL_LIBERION`, `BLACKTHUNDER`, `TWILIGHT`). | Command Center for their guild: Members, Active Events, Scores, Sanctions, Guild Settings. |
| `member` | **ZERO direct database access**. Receives `[]` or denial on all tenant tables, `guilds`, and `accounts` (except own row). | **Player Portal only** (`portal.js` / `PortalService`). Communicates exclusively through the `member-portal` Edge Function. |

### 🔒 Security Invariants & Golden Rules
1. **Player Portal Isolation**: The Player Portal never communicates with Postgres tables directly. It exclusively queries the `member-portal` edge function with service_role privileges, which resolves player identity cryptographically from `accounts.auth_user_id` (never trust client-supplied UIDs).
2. **Zero-Trust Edge Functions**: All privileged edge functions (`discord-webhook-proxy`, `ocr-guild-members`, `admin-accounts`) require cryptographic JWT verification via `supabase/functions/_shared/auth.ts` and verify caller roles before execution.
3. **SSRF Protection & URL Validation**: Webhook proxies must strictly enforce whitelist protocols (Discord official webhooks only) and reject arbitrary destination URLs.
4. **Defensive Score Bounding**: Numerical score submissions from players must be bounded (e.g. `parseSafeScore` bounding non-negative scores to `500_000_000`).
5. **No Synchronous UI Flash**: Admin views must never be displayed synchronously from unverified `localStorage`. UI routing must be strictly gated on cryptographic session resolution (`window.GM.sessionInfo()`).

---

## 3. Multi-Tenant SaaS Rules (CRITICAL)

This is a multi-tenant SaaS. **Every feature, migration, RPC, Edge Function, or bugfix must apply to ALL tenants.**
- **NEVER** write per-tenant hardcoding (e.g. `if (guild === 'ALPHA')`).
- **NEVER** patch only the single guild that reported an issue.
- Verify that every modification preserves tenant isolation and functions uniformly across all guilds.

### 📅 Deterministic Event Session IDs (SaaS Scheme)

Every event session carries a deterministic, chronologically sortable `session_id` calculated from the event type and battle date. A restart of an ongoing event reuses the same session to prevent ghost duplicates.

**The following three definitions MUST stay in exact synchronization:**
1. `src/core/config/events.ts` (`buildEventSessionId`)
2. `public.gm_event_session_id(text, date)` (Postgres SQL)
3. `window.GM.buildEventSessionId(eventName, date)` (Client bridge)

#### Session ID Formats:
- **SvS** → `SVS-YYYY-Www` (ISO week of the battle date)
- **GvG** → `GVG-YYYY-Www` (ISO week of the battle date)
- **Glory** → `GLORY-YYYY-Www` (weekly, keyed by `week_start`)
- **Arms Race Stage A / B** → `ARA-YYYYMMDD` / `ARB-YYYYMMDD`
- **Defend Trade Route (DTR)** → `DTR-YYYYMMDD`
- **Shadowfront Squad 1 / 2** → `SF-YYYYMMDD`

#### Rules for Event Sessions:
- **Never cast `session_id` to a timestamp** (`session_id::timestamptz` is forbidden). Derive dates from `event_status.start_at`, falling back to `week_start` or `updated_at`.
- A guild must never hold two sessions with the same `session_id` for the same event.
- Participation rates count **distinct sessions** per player, never raw rows (`gm_personal_kpis`, `StatsService`).
- **Scoring Keys**: Each Arms Race stage session counts once; Shadowfront, SvS, GvG count once per week; DTR counts once per session. `src/core/config/events.ts`, `window.GM.eventScoringKey`, `public.gm_event_scoring_key`, and `member-portal` MUST remain synchronized.

---

## 4. Database & Security Definer Protocol

### 4.1 Access-Control Helpers
Always use the centralized `SECURITY DEFINER`, `STABLE` access helpers with explicit `SET search_path TO ''` and fully-qualified `public.table_name` references:
- `public.gm_can_read_guild_data(p_guild text)` — SELECT policy qualifier for tenant tables.
- `public.gm_can_read_guilds()` — SELECT policy qualifier for `guilds`.
- `public.gm_can_read_account(p_account_id text)` — SELECT policy qualifier for `accounts`.
- `public.check_user_guild_write_access(p_guild text)` — INSERT/UPDATE/DELETE qualifier.
- `public.is_subscription_active(p_guild text)` — SaaS subscription write-gating.
- `public.gm_can_admin_see_absences(p_guild text)` — Admin absence viewing qualifier.

### 4.2 Row Level Security (RLS) Rules
- Every table in `public` schema has RLS enabled.
- Exactly **one** permissive SELECT policy per table.
- Write policies (INSERT/UPDATE/DELETE) must combine `check_user_guild_write_access` AND `is_subscription_active`.
- **Never grant EXECUTE to PUBLIC on internal RPCs**. Always revoke public permissions:
  ```sql
  REVOKE ALL ON FUNCTION public.fn(...) FROM public, anon;
  GRANT EXECUTE ON FUNCTION public.fn(...) TO authenticated;
  ```

---

## 5. Changelog & Documentation Invariants (MANDATORY)

Every modification to the codebase must update the changelogs according to these exact rules:

1. **`CHANGELOG.md` (Cumulative Project History)**:
   - Must be **incrementally appended** for each new release/version.
   - Preserves the full chronological history of all versions.
   - Structured under `## New`, `## Fixed`, and `## Performance`.
   - **Strictly English only**.

2. **`DISCORD_CHANGELOG.md` (Daily User-Centric Discord Digest)**:
   - Must be **rewritten** on each release to group all modifications made during the current day (Day J).
   - **Target Audience & Tone**: Written directly for **end users / players / guild leaders** so they clearly understand what each improvement brings to them.
   - **Solo Creator Voice**: Must strictly use **"I" (first person singular)** instead of "WE", written in a natural, friendly, human tone as an independent solo creator.
   - **Strict Version Naming Format**:
     - `CHANG_V<Major>` for major platform releases and overhauls (e.g. `CHANG_V1`, `CHANG_V2`).
     - `CHANG_V<Major>.<Minor>` for minor updates, fixes, and additions (e.g. `CHANG_V1.1`, `CHANG_V1.2`, `CHANG_V2.1`).
   - Formatted in clean Discord-friendly Markdown with emojis (`🚀`, `🔒`, `⚡`, `🧪`, `🛡️`, `⚔️`).
   - Title format: `📢 **FGF Guild Management Tool Update — CHANG_V<X>[.<Y>]**`.
   - Ready for instant copy-pasting to the official Discord announcements channel.
   - **Strictly English only**.

---

## 6. Development Workflow & Quality Gate

Before committing any code change, executing a pull request, or closing a task, the complete verification sequence must pass:

```sh
# 1. Static TypeScript Verification (0 errors required)
npm run type-check

# 2. Automated Vitest Unit Suite (219/219 tests green required)
npm test

# 3. Production Bundle Compilation (Clean build into dist/ required)
npm run build
```

### Git & Repository Hygiene:
- Only branch `main` exists; never create long-lived branches.
- Never commit `.DS_Store`, `node_modules/`, build outputs (`dist/`), or test artifacts (`test-results/`).
- Commit messages must follow conventional commits format (e.g., `feat(module): description (vXXX)`).
