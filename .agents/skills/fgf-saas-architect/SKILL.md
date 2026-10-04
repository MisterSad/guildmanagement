---
name: fgf-saas-architect
description: >-
  Architectural invariants for the FGF Guild Management platform — tenancy, layering, state,
  event session IDs. Use when modifying event sessions, multi-tenant schemas, shared state,
  module boundaries, or adding a domain module.
---

# FGF SaaS Architect

The platform is a **free**, multi-tenant app. Measured on production on 2026-10-04: 36 guilds, ~3,867 members, ~56,063 participation rows, 39 tables, 86 policies; 14 Edge Functions deployed, 14 in the repo. These numbers drift every week: re-measure before relying on one. Vanilla TypeScript, no UI framework, Vite, hosted on Vercel; Supabase Postgres 17 and Deno Edge Functions, which run on Supabase. There is no paid tier — see ADR-015 before writing anything about plans or prices.

## 1. Tenant uniformity

Every feature, table, migration, RPC and fix applies **identically to every tenant**. Never write `if (guild === 'ALPHA')`, and never enumerate the tenants in code or in a document — a hardcoded list is stale the moment a guild is created, and creating one is self-service. Ask the database.

An unresolved tenant must **fail visibly**, never fall back. `getActiveGuild()` returns `null`, and `canWriteGuild()` refuses — including for a `super_admin`, whose broad rights would otherwise turn a resolution failure into a write into the wrong guild (finding H2).

## 2. Layering

`core/` must never import from `modules/`. Since M4c nothing on `window` papers over that rule: the core toast renders itself (`core/dom/toast.ts`), and `core/utils/date` and `core/dom/ui` import i18n directly.

A module that imports nothing may live in `core/` — that is what allowed the state store to move there. If a `core/` module needs something from `modules/`, the dependency is pointing the wrong way; move the shared thing down, do not add a bridge.

## 3. State

**`src/core/state/app-state.ts` is the single write path** for cross-cutting state: active tenant, guild list, roster selection, collapsed role groups. Write with `patchAppState()`. Never assign `window.currentGuild` (or any other state global) directly — it is invisible to `tsc` and to every behavioural test, and it simply wins. `tests/app_state_single_writer.test.js` scans for it.

Since M4c the state is a plain module singleton: there is no `window` mirror any more (`window.currentGuild`, `window.GM_COLLAPSED_ROLES`... are gone), so a read never writes and nothing can refill it from a stale global.

The old pub/sub store (`src/core/store/store.ts`) was dead — `subscribe()` was never called — and is deleted. Do not reintroduce a second state mechanism.

## 4. Module boundaries and the bridge

Views call each other by **typed import**, which turns a rename from "a tab silently stops loading" into a compile error. The `window.GM_*` bridge is gone (M4c): the app installs exactly one global, the frozen `window.GM_E2E` (five entry points for the e2e suite, set in `src/main.ts`), and `tests/gm_bridge_contract.test.js` pins it so nothing else can be added to `window`.

Tab views are lazy chunks reached through `src/modules/app/lazy-views.ts` (`get()` / `peek()`), and the admin side is one chunk reached only through `loadAdmin()` in `src/modules/app/admin-loader.ts`. Never import a view or an admin module statically from the entry graph; `tests/code_splitting.test.js` fails if you do.

If two modules need each other, import.

## 5. Deterministic event session IDs

Keep the two canonical definitions in exact sync:

- TypeScript: `src/core/config/events.ts` → `buildEventSessionId`
- Postgres: `public.gm_event_session_id(text, date)`

| Event | Format |
|---|---|
| SvS | `SVS-YYYY-Www` (ISO week of battle date) |
| GvG | `GVG-YYYY-Www` |
| Glory | `GLORY-YYYY-Www` (keyed by `week_start`) |
| Arms Race A / B | `ARA-YYYYMMDD` / `ARB-YYYYMMDD` |
| DTR | `DTR-YYYYMMDD` |
| Shadowfront | `SF-YYYYMMDD` |

## 6. Views

A view that opens a Realtime channel **must** implement `destroy()` and be registered in the router's `TEARDOWN_BY_TAB`. Without it the socket outlives the tab, and a handler listening on `event: '*'` that reloads everything amplifies to O(n²) across concurrent admins.

Bound every history query. `.limit(100000)` is not a bound — it is a delay before silent truncation, on a table growing every week.

## 7. Business rules live in `guild_config`

Per-tenant values (event coefficients, guild tags, thresholds) belong in `guild_config`, not in a TypeScript default that will drift from the seed. Where a default already exists in both, the database wins and the TS copy is the bug.

## 8. Language

All code, comments, types, UI strings, docs and tests are in **English**. Conversation with the owner is in French.
