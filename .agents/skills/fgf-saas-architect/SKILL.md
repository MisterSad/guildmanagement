---
name: fgf-saas-architect
description: >-
  Expert guidelines for designing, refactoring, and scaling features in the FGF Guild Management SaaS platform.
  Use whenever modifying event sessions, multi-tenant schemas, client stores, Web Workers, or domain modules.
---

# FGF SaaS Architect Skill (2026 Standards)

## Core Architectural Invariants
1. **Multi-Tenant SaaS Purity**:
   - Every feature, table, migration, RPC, Edge Function, or bugfix must apply uniformly to ALL tenants (`ALPHA`, `OMEGA`, `BABE`, `IMK`, `YARR`, `CLAW`, `DEMO`, `SEN`, `NIGHTWRAITH`, `OBSIDIANSTAR`, `ASTRAL_LIBERION`, `BLACKTHUNDER`, `TWILIGHT`).
   - Never write per-tenant conditional logic (e.g. `if (guild === 'ALPHA')`).

2. **Deterministic Event Session IDs Synchronization**:
   Always maintain exact synchronization across the three canonical definitions:
   - TypeScript SSOT: `src/core/config/events.ts` (`buildEventSessionId`)
   - Postgres SSOT: `public.gm_event_session_id(text, date)`
   - Window Bridge: `window.GM.buildEventSessionId(eventName, date)`

   **Session Formats**:
   - **SvS** -> `SVS-YYYY-Www` (ISO week of battle date)
   - **GvG** -> `GVG-YYYY-Www` (ISO week of battle date)
   - **Glory** -> `GLORY-YYYY-Www` (weekly, keyed by `week_start`)
   - **Arms Race Stage A / B** -> `ARA-YYYYMMDD` / `ARB-YYYYMMDD`
   - **Defend Trade Route (DTR)** -> `DTR-YYYYMMDD`
   - **Shadowfront Squad 1 / 2** -> `SF-YYYYMMDD`

3. **Frontend Reactivity & State Management**:
   - UI views must extend `src/components/ui/BaseComponent.ts`.
   - Store state in `src/core/store/store.ts` using pub/sub subscriptions. Always clean up listeners in `disconnectedCallback()` / component disposal.
   - Offload heavy calculations (GvG / SvS simulations, draft ranking sorting) to `src/workers/matchup.worker.ts`.

4. **100% English Language Standard**:
   - All code, comments, TypeScript types, UI strings, documentation, and tests must be in English.
