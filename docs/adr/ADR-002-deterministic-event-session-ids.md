# ADR-002: Deterministic Event Session IDs & ISO Week Synchronization

## Status
**Accepted** (2026-08-12)

## Context
Event sessions (SvS, GvG, Glory, Arms Race, DTR, Shadowfront) previously suffered from non-deterministic session IDs (e.g. random UUIDs or local timestamps), leading to ghost sessions upon restarts and inconsistent KPI calculations across web client, SQL functions, and edge functions.

## Decision
Establish deterministic, chronologically sortable `session_id` generation rules synchronized across three canonical implementations:
1. TypeScript SSOT: `src/core/config/events.ts` (`buildEventSessionId`)
2. Postgres SQL SSOT: `public.gm_event_session_id(text, date)`
3. Window Bridge: `window.GM.buildEventSessionId(eventName, date)`

### Formats
- **SvS** -> `SVS-YYYY-Www` (ISO week of battle date)
- **GvG** -> `GVG-YYYY-Www` (ISO week of battle date)
- **Glory** -> `GLORY-YYYY-Www` (weekly ISO week from `week_start`)
- **Arms Race Stage A / B** -> `ARA-YYYYMMDD` / `ARB-YYYYMMDD`
- **Defend Trade Route (DTR)** -> `DTR-YYYYMMDD`
- **Shadowfront Squad 1 / 2** -> `SF-YYYYMMDD`

## Invariants to Preserve
- Never cast `session_id` to timestamp (e.g. `session_id::timestamptz` is forbidden).
- Participation rates in `gm_personal_kpis` and `StatsService` must count **distinct sessions** per player, not raw row counts.
- Scoring keys across `src/core/config/events.ts`, `window.GM.eventScoringKey`, `public.gm_event_scoring_key`, and `member-portal` must remain strictly identical.
