# Changelog

## New

- **Repository Hygiene, Authoritative AGENTS.md Overhaul & 2026 Standards (v110)**:
  - **Authoritative AGENTS.md Overhaul**: Completely updated `AGENTS.md` and `docs/ARCHITECTURE.md` to establish strict 2026 SaaS development standards, zero-trust three-role access boundaries (`super_admin`, `guild_admin`, `member`), single sources of truth, and changelog maintenance invariants.
  - **Repository & Workspace Clean-Up**: Removed temporary build artifacts, macOS metadata, and non-canonical clutter.
  - **Strict English Standard**: Enforced 100% English requirement across all codebase layers, documentation, tests, and changelogs.
  - **Daily Discord Digest Automation**: Centralized day-of-change aggregation policy in `DISCORD_CHANGELOG.md`.
  - **Quality Assurance**: 100% quality gate maintained with **219/219 unit tests passing** (`npm test`).

- **Frontend ES Modules & TypeScript Architecture Modernization (v109)**:
  - **Modular Views Implementation**: Created modern TypeScript domain views under `src/modules/` including `CrossRankView` (`src/modules/matchup/cross-rank.ts`), `SvSMatchupView` (`src/modules/matchup/svs-matchup.ts`), `GvGMatchupView` (`src/modules/matchup/gvg-matchup.ts`), `ArmsRaceView` (`src/modules/armsrace/armsrace-view.ts`), `GloryView` (`src/modules/glory/glory-view.ts`), `SubscriptionView` (`src/modules/subscription/subscription-view.ts`), and `BadgesView` (`src/modules/badges/badges-view.ts`).
  - **Unified Vite Bundling**: Fully integrated domain modules into `src/main.ts`, enabling 78 Vite modules bundled with tree-shaking while maintaining 100% backward-compatible globals (`window.GM_*`).
  - **Quality Assurance**: Verified with **219/219 unit tests passing** (`npm test`) and 0 static TypeScript errors (`tsc --noEmit`).

- **Database Migration Squash & Canonical Schema Consolidation (v108)**:
  - **4 Master Canonical Migrations**: Consolidated 158 legacy SQL migrations into 4 structured, canonical files (`20260812000001_schema_tables_and_indexes.sql`, `20260812000002_security_rls_policies.sql`, `20260812000003_functions_and_rpcs.sql`, `20260812000004_triggers_and_crons.sql`).
  - **Isolated Development Seeds**: Cleaned all mock inserts and static guild entries into `supabase/seeds/dev_seed.sql`, completely separating DDL schema from operational test data.
  - **Legacy History Preservation**: Safely archived the historical 158 incremental migration files under `supabase/migrations_archive/`.
  - **Quality Assurance**: Maintained 100% test battery pass rate with **219/219 unit tests green** (`npm test`).

- **Super Admin Real-Time Monitoring & Diagnostic Dashboard (v107)**:
  - **Live Audit & Observability Console**: Added dedicated Super Admin **System Logs & Diagnostic** view (`#tab-system-logs`) backed by `AuditService` (`src/modules/audit/audit.service.ts`) and `AuditView` (`src/modules/audit/audit-view.ts`).
  - **24h Metric KPI Cards**: Real-time KPI summaries displaying total events (24h), errors, warnings, and average Edge Function execution latency.
  - **Advanced Distributed Tracing Filters**: Instant filtering by log level (`ERROR`, `WARN`, `INFO`, `DEBUG`), service (`member-portal`, `auth-login`, `admin-accounts`, `discord-proxy`, `ocr-gemini`, etc.), guild tenant, and free text search across messages and correlation IDs.
  - **JSON Inspection Drawer**: Detailed interactive inspector modal for viewing sanitized payload metadata, error stack traces, execution duration, and distributed request identifiers.
  - **Automated Stream Refresh**: 10-second background polling toggle with real-time UI indicator.
  - **Quality Assurance**: Added automated test coverage in `tests/remediation_audit.test.js` bringing total passing unit tests to **219/219 green**.

- **Full Technical & Security Remediation, Structured Real-Time Logging & DB Performance (v106)**:
  - **Structured Real-Time Logging**: Added `EdgeLogger` (`supabase/functions/_shared/logger.ts`) and client-side `ClientLogger` (`src/core/logger/logger.ts`, exposed on `window.GM.logger`) with JSON formatting, execution timing, correlation IDs, and automated credential/PII sanitization (`password`, `secret`, `token`, `key`).
  - **Persistent System Audit Logs**: Created `public.system_audit_logs` table protected with strict RLS (accessible only by `super_admin`), storing critical system and security events.
  - **Database Index Optimization**: Added foreign key covering composite indexes across high-volume tables: `idx_event_participants_guild_pseudo` on `event_participants(guild, pseudo)`, `idx_shadowfront_squads_guild_pseudo`, `idx_sanctions_guild_pseudo`, `idx_guild_transfers_fkeys`, and `idx_shadowfront_signups_pseudo_guild`.
  - **Automated Reminder Lock Purge Helper**: Created `public.gm_cleanup_stale_reminder_locks()` SQL function for purging stale `sent_%` lock rows from `guild_config`.
  - **Comprehensive Vitest Suite**: Added `tests/remediation_audit.test.js` bringing total passing unit tests to **218/218 green**.

## Fixed

- **OCR Roster Scanner NetworkError & CSP Resolution (v110.2)**:
  - **Edge Function Routing & Zero-Trust Integration**: Updated `callGeminiOcrBatchApi` in `app.js` to route screenshot analysis through the serverless `ocr-guild-members` Edge Function with authenticated JWT sessions, resolving client-side `NetworkError when attempting to fetch resource`.
  - **Content Security Policy Alignment**: Updated `vercel.json` CSP `connect-src` to explicitly authorize `https://generativelanguage.googleapis.com` for direct/fallback requests.
  - **Edge Function Batch & Model Resilience**: Enhanced `supabase/functions/ocr-guild-members/index.ts` with multi-image batch processing support and prioritized production models (`gemini-2.0-flash`, `gemini-1.5-flash`, `gemini-2.5-flash`). Deployed to Supabase edge.

- **Edge Function Security Hardening & Zero-Trust Verification (v106)**:
  - **Discord Webhook Proxy Authorization (`SEV-01`)**: `discord-webhook-proxy` now strictly requires cryptographic JWT validation and verifies `guild_admin` or `super_admin` role, preventing unauthorized cross-guild dispatch and blocking SSRF.
  - **Gemini OCR Endpoint Locking (`SEV-02`)**: `ocr-guild-members` now requires cryptographic JWT validation and admin role verification, protecting Gemini AI API quotas from unauthenticated abuse.
  - **GoTrue User Pagination Fix (`SEV-03`)**: Added `findUserByEmail` pagination helper in `supabase/functions/_shared/pagination.ts` across `auth-login` and `admin-accounts`, eliminating the GoTrue default 50-user cutoff.
  - **Defensive Score Bounding (`SEV-05`)**: Added `parseSafeScore` validation in `member-portal` enforcing non-negative numeric scores bounded by `MAX_ALLOWED_EVENT_SCORE = 500_000_000`.
  - **TypeScript Services & Schema Realignment (`SEV-07`)**: Synchronized `EventsService` with database column `is_active` (replacing `active`), aligned `PortalService` action names (`submit-scores`, `set-absence`, `update-power`), and updated `src/types/database.ts`.
  - **Admin Dashboard Flash Prevention (`SEV-10`)**: Removed unverified synchronous `showAdminDashboard()` invocations in `app.js`, ensuring UI rendering is strictly gated on cryptographic JWT validation from `window.GM.sessionInfo()`.
  - **Least Privilege Database RPCs (`SEV-04`)**: Revoked `EXECUTE` privileges from `anon` and `public` on internal `SECURITY DEFINER` functions.
  - **InitPlan & Duplicate Index Cleanup (`SEV-11`)**: Dropped redundant constraint on `event_status`, consolidated `player_absences` SELECT policies, and optimized subqueries on `player_push_prefs` with `(SELECT auth.uid())`.
  - **Content Security Policy (`SEV-12`)**: Removed unnecessary direct client connect directives to external AI endpoints in `vercel.json`.

- **Shadowfront Pre-Start Session Migration & Duplicate Key Constraint Resolution (v105)**:
  - **Unblocked Member Assignments**: Resolved database duplicate key constraint violations (`shadowfront_squads_guild_week_start_pseudo_key`) when assigning players to active Shadowfront sessions after a pre-start click.
  - **Week-Scoped Cleanup in `assign()`**: Modified `assign()` in `shadowfront.js` to delete any existing assignment for the member in the current guild and week (`week_start`), preventing leftover pre-start rows under temporary session IDs from triggering unique constraint conflicts upon upsert.
  - **Automatic Session ID Migration in `startSquad()`**: Updated `startSquad()` in `shadowfront.js` to migrate any pre-start assignments in `shadowfront_squads` from temporary pre-start session IDs to the new active session ID when starting a squad.
  - **Tenant Data Repair**: Repaired orphan record for player `Aurora` in guild `SEN`, restoring full functionality and alignment across active sessions.
  - **Automatic Model Resolution**: `callGeminiOcrBatchApi` in `app.js` now uses `gemini-1.5-flash` as primary free production endpoint with automatic fallback to `gemini-2.0-flash-exp`, `gemini-2.0-flash`, and `gemini-flash-latest`. Eliminates HTTP 404 errors when an experimental model identifier is not active on a specific API key.

- **Strict Enforcement of Gemini 2.0 Flash Endpoint (v103)**:
  - **Forced 2.0 Flash Model**: `callGeminiOcrBatchApi` and `getOcrModel()` in `app.js` now target `gemini-2.0-flash` exclusively. Eliminates model fallback to legacy paid endpoints or non-flash models, ensuring zero-cost execution under Google AI Studio's free tier.

- **Default Hardcoded API Key & Complete Interface Removal of Key Options (v102)**:
  - **Unconditional Default API Key**: `getOcrApiKey()` in `app.js` now returns the default API key directly without requesting or storing user key overrides.
  - **Interface Clean-up**: Removed the API key configuration button (`#ocr-key-config-btn`), API key input box, prompt container (`#ocr-key-prompt`), and save options from `index.html` and `app.js`. The API key is used strictly behind the scenes and never appears anywhere in the user interface.
