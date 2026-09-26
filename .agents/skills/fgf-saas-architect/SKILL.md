---
name: fgf-saas-architect
description: >-
  Architectural invariants for the FGF Guild Management platform — tenancy, layering, state,
  event session IDs. Use when modifying event sessions, multi-tenant schemas, shared state,
  module boundaries, or adding a domain module.
---

# FGF SaaS Architect

The platform is a **free**, multi-tenant app: 26 guilds, ~3,005 members, ~55,760 participation rows. Vanilla TypeScript, no UI framework, Vite, Supabase Postgres 17, Deno Edge Functions on Vercel. There is no paid tier — see ADR-015 before writing anything about plans or prices.

## 1. Tenant uniformity

Every feature, table, migration, RPC and fix applies **identically to every tenant**. Never write `if (guild === 'ALPHA')`, and never enumerate the tenants in code or in a document — a hardcoded list is stale the moment a guild is created, and creating one is self-service. Ask the database.

An unresolved tenant must **fail visibly**, never fall back. `getActiveGuild()` returns `null`, and `canWriteGuild()` refuses — including for a `super_admin`, whose broad rights would otherwise turn a resolution failure into a write into the wrong guild (finding H2).

## 2. Layering

`core/` must never import from `modules/`. This is the constraint behind the two `window` globals that deliberately survive: `core/dom/toast.ts` *is* the implementation `GM_APP.showToast` points at, so importing the app's renderer there would invert the direction and recurse.

A module that imports nothing may live in `core/` — that is what allowed the state store to move there. If a `core/` module needs something from `modules/`, the dependency is pointing the wrong way; move the shared thing down, do not add a bridge.

## 3. State

**`src/core/state/app-state.ts` is the single write path** for cross-cutting state: active tenant, guild list, roster selection, collapsed role groups. Write with `patchAppState()`. Never assign `window.currentGuild` (or any other state global) directly — it is invisible to `tsc` and to every behavioural test, and it simply wins. `tests/app_state_single_writer.test.js` scans for it.

Two properties the store must keep, both of which it once broke:

- **A read does not write.** `getAppState()` must not create the `window` mirror as a side effect.
- **Hydration is absence-aware.** Deleting a global clears the field; it must not be refilled from the stale in-memory value.

The old pub/sub store (`src/core/store/store.ts`) was dead — `subscribe()` was never called — and is deleted. Do not reintroduce a second state mechanism.

## 4. Module boundaries and the bridge

Views call each other by **typed import**. Phase 7 converted the router and every inter-view call, which is what turns a rename from "a tab silently stops loading" into a compile error. Three `GM_*` names survive deliberately (`GM_APP`, `GM_I`, `GM_COLLAPSED_ROLES`) and `tests/gm_bridge_contract.test.js` pins that list so it cannot grow.

Do not add a new `window.GM_*` namespace. If two modules need each other, import.

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
