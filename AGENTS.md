# AGENTS.md — Development Guidelines for AI Agents

This file is the single source of truth for anyone (human or AI) modifying
this repository. **Read it fully before touching any code.** Every change
must respect the rules below, especially the security model, modern `/src` architecture, and the test battery.

---

## 1. Project Overview & Modern Architecture

**FGF Guild Management Tool** is a serverless, multi-tenant web app that
helps guilds in the game *Foundation Galactic Frontier* manage events,
members, participation, sanctions, Discord notifications, and SaaS subscriptions.

- **Frontend Architecture**: Modernized ES Modules under `/src`, TypeScript (`tsc --noEmit`), Vite bundler (`vite build`), reactive Pub/Sub Store (`src/core/store/store.ts`), Web Worker for heavy calculations (`src/workers/matchup.worker.ts`), component-based UI (`src/components/ui/BaseComponent.ts`), Phosphor Icons, Three.js 3D login scene, installable PWA.
- **Backend**: Supabase (Postgres 17 + RLS + `SECURITY DEFINER` functions, Edge Functions in TypeScript/Deno).
- **Single Source of Truth (SSOT)**: Event session ID building and scoring keys are centralized in `src/core/config/events.ts`.
- **CI/CD Pipeline**: GitHub Actions (`.github/workflows/ci.yml`) automatically running `npm run type-check`, `npm test`, and `npm run build` on every commit and PR.
- **Database Seeds**: Test and sample data isolated in `supabase/seeds/dev_seed.sql` away from DDL schema migrations.
- **Payments**: External merchant API & Stripe (server-side order creation + HMAC-verified webhook). The provider name must never appear in public docs.
- **Tests**: Vitest + jsdom (`npm test` — **200 tests green**).
- **Hosting**: Static build output (`dist/`) on Vercel, auto-deploy on push to `main`.

---

## 2. The Three-Role Access Model (CRITICAL)

There are exactly three account roles. **Never blur the boundaries.**

| Role | Access |
|------|--------|
| `super_admin` | Reads and writes **every guild**. Single account (HawkEye). Also "base admin" of ALPHA. |
| `guild_admin` | Reads and writes **only their own guild** (tenants: ALPHA, OMEGA, BABE, IMK, YARR, CLAW, DEMO, SEN, NIGHTWRAITH, OBSIDIANSTAR, ASTRAL_LIBERION, BLACKTHUNDER, TWILIGHT). |
| `member` | **Player Portal only** (scores, power, timezone, absences, transfers). NO direct database access. |

**A player account must never be able to reach the admin dashboard or read/write any guild data through the REST API.**

### Golden Rules

1. A `member` account gets `[]` (or denial) on **every** tenant table and on `guilds` and `accounts` (except its own row).
2. A `guild_admin` sees only their guild's rows, and only `guilds` rows (all of them — needed for transfers) plus their own `accounts` row.
3. `super_admin` bypasses guild scoping everywhere.
4. The Player Portal (`portal.js` / `PortalService`) must never query tables directly: it only calls the `member-portal` edge function (service_role), which resolves identity from `accounts.auth_user_id` (never from a client-supplied UID).
5. When a player transfers guilds, their account's `guild` column follows them (`transfer_guild_member` / `resolve_guild_transfer`).

### SaaS Rule (CRITICAL — Never develop for a single tenant)

This is a multi-tenant SaaS. **Every feature, migration, fix, edge function or SQL change must apply to ALL tenants**. Never write per-tenant logic, never special-case one guild, never "fix" only the guild that reported an issue. Verify the impact across tenants in the same change.

### Event Session IDs (SaaS Scheme)

Every event session carries a deterministic, chronologically-sortable `session_id` built from the event type and its battle date, so a re-Start of the same event reuses the same session (no ghost duplicates). **`src/core/config/events.ts`, the SQL helper `public.gm_event_session_id(text, date)`, and `window.GM.buildEventSessionId(eventName, date)` MUST stay in sync** — change all three, never one.

- SvS → `SVS-YYYY-Www` (ISO week of the battle date)
- GvG → `GVG-YYYY-Www`
- Glory → `GLORY-YYYY-Www` (weekly, keyed by `week_start`)
- ARMS RACE STAGE A/B → `ARA-`/`ARB-YYYYMMDD`
- Defend Trade Route → `DTR-YYYYMMDD`
- Shadowfront Squad 1/2 → `SF1-`/`SF2-YYYYMMDD`

Rules:
- Never cast `session_id` to a timestamp (`session_id::timestamptz`): it is a key, not a date. Derive dates from `event_status.start_at` (battle date), falling back to `updated_at` or `week_start`.
- A guild must never hold two sessions with the same `session_id` for the same event: if the UI or an RPC would mint one, reuse the existing session instead.
- Participation rates count **distinct sessions** per player, never rows (`gm_personal_kpis`, `stats.service.ts`), or duplicate sessions would inflate them.
- Scoring key: each Arms Race **Stage session** counts once; Shadowfront, SvS, GvG count once per week; DTR counts once per session. The TS module `src/core/config/events.ts`, the JS `window.GM.eventScoringKey`, the SQL `public.gm_event_scoring_key`, and the `member-portal` edge function MUST stay in sync.

---

## 3. Database Security Model (CRITICAL)

### 3.1 Access-Control Helpers (Use these, don't inline logic)

- `gm_can_read_guild_data(p_guild)` — SELECT policy qualifier for all tenant tables. `super_admin` → true; `guild_admin` → only own guild; `member`/anon → false.
- `gm_can_read_guilds()` — SELECT policy qualifier for the `guilds` table. `super_admin`/`guild_admin` → true; `member` → false.
- `check_user_guild_write_access(p_guild)` — INSERT/UPDATE/DELETE policy qualifier. `super_admin` → true everywhere; `guild_admin` → own guild; `member`/anon → false.
- `is_subscription_active(p_guild)` — write gating (Unlimited/Lifetime never expire; Premium checks the end date; super_admin exempt).
- `gm_can_admin_see_absences(p_guild)` — admin-only check for `player_absences`.

All of these are `SECURITY DEFINER`, `STABLE`, with `SET search_path TO ''`. Always qualify `public.table` in every query inside these functions.

### 3.2 RLS Rules

- Every tenant table has RLS enabled. `accounts` and `guilds` too.
- Exactly **one** permissive SELECT policy per table is allowed.
- INSERT/UPDATE/DELETE policies must use `check_user_guild_write_access` AND `is_subscription_active`.
- **Never grant EXECUTE to PUBLIC on functions.** Always `revoke all on function public.fn(...) from public, anon, authenticated; grant execute on function public.fn(...) to authenticated;`.

---

## 4. Codebase Architecture & Directory Conventions

See `docs/ARCHITECTURE.md` for the complete file tree.

```
guildmanagement/
├── .github/workflows/ci.yml     # Automated CI Quality Gate (type-check, vitest, build)
├── docs/                        # Architecture & Database Squash documentation
│   ├── ARCHITECTURE.md          # Complete project structure & file index
│   └── database_squash_plan.md  # Step-by-step SQL migration squash guide
├── supabase/
│   ├── functions/               # Deno/TypeScript Edge Functions
│   ├── migrations/              # DDL schema migrations
│   └── seeds/dev_seed.sql       # Test/dev seed data (isolated from migrations)
├── src/                         # Modernized TypeScript Source Code
│   ├── components/ui/           # Reactive UI components (BaseComponent, Toast)
│   ├── core/                    # Infrastructure (API, Auth, Config, i18n, Store)
│   ├── modules/                 # Domain-driven modules (events, shadowfront, stats, portal, etc.)
│   ├── types/                   # TypeScript definitions (database.ts)
│   ├── workers/                 # Web Workers (matchup.worker.ts)
│   └── main.ts                  # Vite ES Module entrypoint & window.GM bridge
├── index.html                   # HTML shell (imports /src/main.ts)
├── package.json                 # Project scripts (dev, build, type-check, test)
├── tsconfig.json                # Strict TypeScript configuration
├── vite.config.ts               # Vite bundler configuration
└── vitest.config.js             # Vitest test runner configuration
```

### Development Commands

```sh
npm run dev         # Start Vite development server with HMR
npm run build       # Build production bundle with Vite into dist/
npm run type-check  # Execute TypeScript static type verification (tsc --noEmit)
npm test            # Run Vitest unit test suite (200/200 tests green)
```

---

## 5. Testing — MANDATORY Battery After EVERY Change

**No change is complete until the full battery passes AND the affected surface is regression-tested.**

### 5.1 Quality Verification Sequence

Before committing any change:
```sh
npm run type-check  # Must pass with 0 errors
npm run build       # Must compile successfully
npm test            # Must pass 200/200 tests green
```

Current suite: **200 tests** across `tests/`. When adding a feature, **add unit tests for it** in the matching test file.

---

## 6. Repository Hygiene & Changelogs

- Only `main` branch exists; never create long-lived branches.
- Do not commit `.agents/`, `android/`, `apple-devices/`, build artifacts (`dist/`).
- **Changelogs are rewritten, not appended**: at every change, update both `CHANGELOG.md` (full history, sections `## New` / `## Fixed`, **English only**) and `DISCORD_CHANGELOG.md` (Discord-paste, English, emoji shortcodes, covering only the last few hours). Every Discord changelog title carries an incrementing number (e.g. `... — v84`).
