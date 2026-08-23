# Changelog

## New

- **Members OCR Mode & Update-Only Metric Scanners (v126.0)**:
  - **Dedicated Members OCR Scanner**: Introduced "1. Members OCR" as the primary membership management tool in the toolbar and OCR modal. It exclusively manages member recruitment, UID assignments, and departure removals via the full three-section review flow.
  - **Update-Only Tactical Metric Scanners**: Converted the 7 tactical metric scanners (Power, Fleet, Tech, Flagship, Champs, Crew, Glory) to update-only mode. Metric scanners now only update existing roster members and never create new members or propose removals.
  - **"Not in Roster" Unmatched Member Flagging**: In metric scanner mode, players detected in screenshots who do not match any existing roster member are grouped into a dedicated "Not in Roster" section (unchecked, disabled, badged "Use Members OCR to add").
  - **Cold-Start Roster Initialization**: Updated the empty roster cold-start CTA across the roster and military matrix views to trigger Members OCR directly (`data-metric="members"`, i18n key `empty_members_roster_cta` updated to `'Members OCR'`).
  - **Edge Function & Fallback Extraction**: Added `"members"` extraction instructions to `ocr-guild-members` Edge Function and client direct-Gemini fallback path to extract player pseudo, UID, and overall power.
  - **Quality Gate**: **400/400 Vitest unit tests green** (+3 new unit tests in `tests/ocr_diff.test.js`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

## Fixed

- **Production CORS Response Origin Echo Outage & Per-Request Closure Pattern (v125.3)**:
  - **Per-Request JSON Response Closure (`makeJson`)**: Eliminated silent fallback to `http://localhost:5173` across all 8 CORS-bearing Edge Functions (`admin-accounts`, `member-portal`, `auth-login`, `player-register`, `gm-create-order`, `gm-order-status`, `discord-webhook-proxy`, `ocr-guild-members`) and `event-reminders` by adopting a per-request `makeJson(req)` factory that automatically captures and echoes the incoming request origin on all responses.
  - **Eliminated 3-Arg Helper Discrepancies**: Cleaned all 3-arg `json(body, status, req)` call sites, ensuring uniform closure usage without global or mutable module state.
  - **Edge Functions CORS Containment Suite**: Added `tests/cors_response.test.js` validating that every CORS-bearing function defines `makeJson(req)`, invokes `const json = makeJson(req)` inside its serve handler, contains zero 3-arg `json()` calls, and accurately echoes valid production and preview origins while rejecting untrusted domains.
  - **Runbook Post-Deploy CORS Verification**: Added mandatory function-code response origin echo curl verification step to `docs/DEPLOY_RUNBOOK.md` to prevent preflight-only testing blind spots.
  - **Quality Gate**: **397/397 Vitest unit tests green** (+12 new unit tests in `tests/cors_response.test.js`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

## Fixed

- **Production Deployment Corrections & Live Bug Fixes (v125.2)**:
  - **Edge-Function JWT Verification Matrix (`67bdf74`)**: Codified explicit `verify_jwt` configurations for all 10 Edge Functions in `supabase/config.toml` (4 public: `auth-login`, `player-register`, `event-reminders`, `gm-stripe-webhook`; 6 JWT-gated: `member-portal`, `admin-accounts`, `gm-create-order`, `gm-order-status`, `discord-webhook-proxy`, `ocr-guild-members`).
  - **Member Portal UID Fallback Fix (`67bdf74`)**: Enhanced `getIdentity` in `supabase/functions/member-portal/index.ts` to query `accounts.uid` and resolve `playerUid` via `row?.player_uid || acc.uid || accountId`, preventing member lookup failures when shadow records lack explicit player UIDs.
  - **`gm_personal_kpis` Column Reference Repair (`67bdf74`)**: Corrected SQL typo in migration `20260823060000_security_rpc_lockdown.sql` where undeclared variable `v_fleet_rating` caused runtime execution failures during personal KPI queries; replaced with record accessor `v_member.fleet_rating`.
  - **Client IP Resolution Behind Cloudflare Proxy (`834ad98`)**: Prioritized `cf-connecting-ip` in `supabase/functions/_shared/rate-limit.ts` to ensure consistent IP throttling and prevent proxy egress IP rotation on cloud edge networks.
  - **Post-Deploy Quality Gate**: **385/385 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

## Documentation

- **Authoritative Engineering Guidelines & Architecture Overhaul (v125.2)**:
  - **AGENTS.md Overhaul**: Established AI Agent Role Charter (Lead Solution Architect, SecOps Engineer, QA Gatekeeper, Deployment Operator), synchronized 9 live guild tenants (`ALPHA`, `BABE`, `CLAW`, `DEMO`, `FED`, `IMK`, `OMEGA`, `SEN`, `YARR`), and codified security regression blacklist.
  - **Root ARCHITECTURE.md Rewrite**: Clearly separated Part 1 (Current Live Production Architecture) from Part 2 (Modernization Target `/src`), and converted `docs/ARCHITECTURE.md` to a redirect stub.
  - **New Architecture Decision Records (ADRs)**: Added `ADR-007` (Accounts-Only Role Resolution), `ADR-008` (Database Migration Protocol v2), and `ADR-009` (Secrets Vault-Only Policy); updated `ADR-001` (marked superseded by `ADR-006`) and `ADR-002` (sequence-suffixed session IDs).
  - **Production Deployment Runbook**: Created `docs/DEPLOY_RUNBOOK.md` documenting repeatable pre-flight inventory queries, migration execution order, Vault secret rotation, and S1-S6/F1-F6 verification matrices.

## Fixed

- **Login Outage Hotfix, Root Script Syntax Guards & CORS Production Origin Correction (v125.1)**:
  - **Login Script SyntaxError Fix**: Resolved JavaScript syntax error at `app.js:2942` caused by an unconcatenated quote in the removed-members checkbox template from v125.0, restoring script execution and login form submit handler.
  - **Automated Root-Script Syntax Test Suite**: Added `tests/root_syntax.test.js` running `node --check` against all root JavaScript files in the repository to guarantee unparseable classic scripts fail automated test runs.
  - **CI & Build Pipeline Syntax Guards**: Injected explicit `node --check` validation loop into GitHub Actions (`.github/workflows/ci.yml`) and build script (`scripts/build.js`) before assets are packaged to `dist/`.
  - **CORS Production Origin Correction**: Replaced stale `fgf-guild-management.vercel.app` origin with canonical `https://guildmanagement.vercel.app` in `supabase/functions/_shared/cors.ts`.
  - **Cache Buster Bump**: Incremented `app.js?v=72` → `app.js?v=73` in `index.html` to guarantee instant cache invalidation for users.
  - **Quality Gate**: **385/385 Vitest unit tests green** (+24 new syntax guard tests in `tests/root_syntax.test.js`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

## New

- **OCR Three-Section Roster Review & Cold-Start CTA (v125.0)**:
  - **Three-Section Roster Validation UI**: Partitioned OCR review modal into three dedicated sections (Existing Members, New Members, and Removed Members) with sticky headers, live counters, and automatic section filtering.
  - **New Member UID Entry & Pre-Flight Validation**: Added explicit UID input for new players with instant numeric validation, intra-batch duplicate detection, and `check_uid_exists_globally` RPC collision prevention, eliminating unwanted auto TEMP-UIDs.
  - **Removed Member Detection with Override**: Automatically detected absent roster members from full-roster screenshots with "Remove" proposed by default, per-row Keep overrides, soft partial-screenshot warning (>50% removals), and cascade confirmation gate.
  - **Live Before/After Roster Counters**: Added live delta counter chip (`Roster: X → Y`) in summary badge bar reflecting real-time checkbox selections and removals.
  - **Empty-Roster Cold-Start CTA**: Added prominent "Roster OCR" primary CTA in empty roster view and military matrix, allowing one-click initialization of entire guild rosters from screenshot.
  - **Player Metrics History Snapshot Bridge**: Implemented `window.GM.upsertPlayerMetrics` to record `player_metrics_history` snapshots on both UPDATE and INSERT roster OCR operations.
  - **Dead Code Cleanup**: Purged unused OCR API key saving listeners and demo image loaders from client code.
  - **Quality Gate**: **361/361 Vitest unit tests green** (+28 new unit tests in `tests/ocr_diff.test.js`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Canonical Replay Ordering Fix & Full Observability Migration (v124.3)**:
  - **Relocated Unique Indexes to Master DDL**: Moved 4 unique index definitions (`idx_ep_tenant_session_unique`, `idx_ep_tenant_no_session_unique`, `idx_accounts_lower_id`, `event_status_guild_event_key`) to master DDL `20260812000001_schema_tables_and_indexes.sql` to resolve early-chain `ON CONFLICT` target resolution during demo tenant resets in migrations `20260818030000`, `20260818081500`, and `20260819203500`.
  - **RLS Function Ordering & Signature Fix**: Relocated Access Control Helper functions to `20260812000002_security_rls_policies.sql` before policy definitions, and added `DROP FUNCTION IF EXISTS public.gm_check_login` to `20260823070000_auth_hardening.sql` for clean return table signature upgrades.
  - **Executed 100% Verified Canonical Migration Replay**: Replayed all 25 canonical migration files on disposable PostgreSQL 17 container (`fgf-replay`) with `-v ON_ERROR_STOP=1`, verifying 8 target RPCs, 4 unique indexes, and 60 demo tenant seed members.
  - **Standardized Edge Function Observability**: Migrated all 38 raw `console.*` calls in `supabase/functions/event-reminders/index.ts` to `EdgeLogger` instance methods (`logger.info`, `logger.warn`, `logger.error`) with PII/secret masking and request correlation IDs.
  - **Quality Gate**: **333/333 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Security & Architecture Remediation Round 2 — Zero-Gap Closure (v124.2)**:
  - **Canonical Database Reconciliation (GAP 1)**: Ported all 13 archive-only `SECURITY DEFINER` RPCs (`gm_register_player`, `gm_set_join_code`, `gm_get_join_code`, `gm_approve_player_account`, `gm_reject_player_account`, `gm_get_shadow`, `gm_attach_shadow`, `gm_get_player_absences`, `gm_upsert_player_absence`, `gm_delete_player_absence`, `gm_update_player_timezone`, `gm_get_push_prefs`, `gm_set_push_prefs`) into canonical migration chain with `SET search_path TO ''`, strict schema-qualified references, and least-privilege `service_role` grants.
  - **Tenant-Isolated Partial Unique Indexes (GAP 1)**: Added partial unique indexes `idx_ep_tenant_session_unique` (`WHERE session_id IS NOT NULL`) and `idx_ep_tenant_no_session_unique` (`WHERE session_id IS NULL`) on `event_participants`, plus `idx_accounts_lower_id` on `accounts(LOWER(id))`.
  - **CORS Origin Validation Hardening (GAP 4)**: Anchored origin matching regexes in `_shared/cors.ts` to strictly validate `https://*.vercel.app` and `https://*.guildmgmt.app` domains, eliminating substring bypass vectors and adding `Vary: Origin` response headers.
  - **Edge Function Payload & Image Caps (GAP 4)**: Enforced maximum 5 images (`too_many_images`) and 8 MB payload limits (`payload_too_large`) in `ocr-guild-members`, and added `redirect: "error"` on outbound Discord webhook dispatches.
  - **Cross-Isolate IP Rate Limiting & Anti-DoS Lockout (GAP 3)**: Created table `public.login_throttle` for distributed sliding-window IP rate limiting (30 attempts / 5 min on login, 60 / 5 min on admin and portal entrypoints), and rebalanced account lockout with exponential backoff (15/30/45/60 min).
  - **Subresource Integrity (SRI) & CSP Eval Removal (GAP 2)**: Removed `'unsafe-eval'` from production Content Security Policy in `vercel.json`, and pinned exact versioned URLs with SHA-384 cryptographic integrity hashes for CDN scripts in `index.html`.
  - **Authentication Session Cleanup (GAP 5)**: Removed dead `gm_token` read in `app.js` and ensured `gm_server_restriction` is thoroughly cleared on `doLogout()`.
  - **Standardized Observability (GAP 5)**: Replaced residual `console.*` logging across payment paths (`gm-create-order`, `gm-order-status`, `gm-stripe-webhook`) with centralized `EdgeLogger`.
  - **Quality Gate**: **333/333 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Zero-Regression Full-Spectrum Security & Architecture Remediation (v124.1)**:
  - **Admin Accounts Zero-Trust Authorization Matrix (W1)**: Created pure TypeScript authorization matrix (`supabase/functions/_shared/admin-authz.ts`) enforcing strict hierarchical role assignment (`maxAssignableRole`) and tenant boundary validation (`isGuildInScope`), purged client-forgeable `user_metadata` fallback vectors from `admin-accounts`, and enforced server-side cryptographically secure password generation on resets.
  - **Elimination of `user_metadata` Role Fallback Vulnerability (W2)**: Replaced SQL access helpers (`is_super_admin`, `is_server_admin`, `gm_can_read_guilds`) to authenticate purely against `public.accounts` keyed on `auth.uid()` (`status = 'active'`), and hardened client `sessionInfo()` in `gm-utils.js` to reject JWTs missing cryptographically signed `app_metadata.app_role`.
  - **Subscription Payment Atomicity, Schema Normalization & RPC Hardening (W3 + W7)**: Added `plan_key` to `public.guilds`, backfilled legacy subscription plan formats, hardened `public.gm_apply_subscription_payment` with pessimistic `FOR UPDATE` row lock, and revoked execution permissions from `public`, `anon`, and `authenticated` (granted to `service_role` only).
  - **Member Portal Resilience, Scope Hardening & Score Sanitization (W5)**: Resolved `member` context before invoking guild average calculations in `get-personal-kpis` to prevent runtime crashes, wrapped top-level Edge Function dispatch in CORS-safe try/catch returning generic error codes, stripped unverified client score flags (`excused`, `appointed`), and enforced strict bounding on numeric military power updates.
  - **Security Definer RPC Authorization Lockdown & Audit Isolation (W6)**: Audited and classified all RPCs across the stack, injected internal authorization checks into 11 `SECURITY DEFINER` stored procedures (`gm_upsert_player_metrics`, `gm_reset_account_password`, `gm_admin_upsert`, `gm_get_player_metrics_history`, `gm_personal_kpis`, `request_guild_transfer`, `gm_transfer_guild_member`, `transfer_guild_member`, `check_user_guild_access`, `check_uid_exists_globally`, `gm_find_player_by_uid`), purged all hardcoded tenant fallbacks (`COALESCE(..., 'ALPHA')`), gated player search to admin roles, and restricted audit log inserts to `service_role` only.
  - **Cron Secret Supabase Vault Migration, Timing-Safe Auth & Log Hygiene (W4)**: Migrated `pg_cron` execution secret out of git into `vault.decrypted_secrets` via wrapper `public.gm_invoke_event_reminders()`, implemented constant-time comparison (`safeEqual`) in `event-reminders`, sanitized Discord webhook URLs in log messages, and moved Gemini OCR API authentication from URL query parameters to the `x-goog-api-key` header.
  - **Canonical Migration Reconciliation & Idempotence (W8)**: Standardized canonical DDL migrations with `CREATE EXTENSION IF NOT EXISTS`, idempotent `DROP POLICY IF EXISTS` definitions, and PostgREST schema cache reload notifications (`NOTIFY pgrst, 'reload schema'`).
  - **Content Security Policy, Permissions-Policy & Subresource Integrity (W9)**: Hardened production CSP headers in `vercel.json` with `object-src 'none'`, `frame-ancestors 'none'`, `worker-src 'self' blob:`, comprehensive `connect-src` allowlist, restricted `Permissions-Policy`, and added `crossorigin="anonymous"` to CDN tags in `index.html`.
  - **Authentication Hardening, Bcrypt Dual-Read Migration & Lockout Defense (W10)**: Added `password_hash`, `failed_login_count`, `locked_until`, and `last_login_at` to `public.accounts`, updated `gm_check_login` with lazy bcrypt hashing migration, and implemented automatic 15-minute account lockout after 5 consecutive failed login attempts.
  - **Centralized Dynamic CORS Allowlist & Build Output Hygiene (W11)**: Created `_shared/cors.ts` dynamic CORS allowlist across all 10 Edge Functions, and sanitized `scripts/build.js` to exclude internal config files (`package.json`, `vercel.json`, `tsconfig.json`) from public `dist/`.
  - **WCAG Viewport Accessibility & Deep Storage Logout Cleanup (W12)**: Made viewport meta tag WCAG-compliant by removing `user-scalable=no`, and enhanced client `logout()` to thoroughly clear all session tokens and auth storage keys from `sessionStorage` and `localStorage`.
  - **Quality Gate**: **319/319 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

  - **Repository Tree Cleanup & Hardening**: Consolidated documentation and technical audit reports into `docs/` (`docs/audit_report_2026-08-14.md`), decluttering root and reinforcing `.gitignore` against test artifacts and transient caches.
  - **Master Architecture Blueprint (`ARCHITECTURE.md` & `docs/ARCHITECTURE.md`)**: Codified the authoritative 2026 system architecture covering multi-tenant serverless topology (Vercel + Supabase Postgres 17 + Deno TypeScript Edge Functions), reactive Pub/Sub Store, Web Worker background parallelism, BaseComponent lifecycle model, Material Design 3.0 + Apple Cozy Neutral tokens, zero-trust 4-role access model, and full directory tree index.
  - **Authoritative Engineering Guidelines (`AGENTS.md`)**: Elevated root `AGENTS.md` to be the strict single source of truth for all AI agents and human developers, setting mandatory rules for 100% English, memory leak prevention, tripartite deterministic session ID sync, RLS security definer protocols, quality gates, and git release standards.
  - **Quality Gate**: **294/294 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Terms of Service and General Conditions of Sale (TOS/GCS) Dedicated Full Page (v123.9)**:
  - **Universal Footer Navigation**: Added accessible "Terms & Conditions" links across all footers (Login view, Player Portal view, Sidebar navigation, Drawer menu, and Subscription self-service panel) pointing directly to the dedicated standalone page `terms.html`.
  - **Dedicated Full Standalone Page (`terms.html`)**: Built an uncropped, responsive full-page legal document with clean typography (Plus Jakarta Sans, Inter, Phosphor Icons), top navigation bar with a "Return to Platform" button, metadata chips, and complete statutory disclosures:
    - **Platform Operator & Statutory Disclosures**: Registered *Micro-Entrepreneur* sole proprietorship (André Vieira), French LCEN law compliance, Article 293 B CGI VAT exemption notice, and hosting providers (Vercel, Supabase AWS EU, Stripe PCI-DSS Level 1).
    - **100% Asynchronous Companion Architecture**: Out-of-game companion SaaS utility operating strictly externally without game client hooks or network sniffing.
    - **Intellectual Property & Non-Affiliation**: Formal non-affiliation disclaimer with FunPlus International AG and Skydance Interactive, with 100% open-source / proprietary UI tokens.
    - **Commercial Terms & Non-Recurring Access Passes**: Fixed-term prepaid digital access passes with strict prohibition of automatic renewals, and express waiver of the right of withdrawal under French Consumer Code Article L. 221-28 13°.
    - **Privacy by Design & GDPR Governance**: Zero PII guarantee, pseudonymized in-game metrics, ephemeral in-memory OCR with 0 persistence, and automated cascade data deletion (`ON DELETE CASCADE`).
    - **Jurisdiction & Consumer Mediation**: EU consumer ombudsman mediation and exclusive jurisdiction of the Court of Appeal of Paris, France.
  - **Quality Gate**: **294/294 Vitest unit tests green**, **8/8 Playwright E2E tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Player Portal Activity & Submission Audit Log Console (v123.8)**:
  - **100% Player Portal Mutation Instrumentation**: Added automated, structured audit logging directly into `supabase/functions/member-portal/index.ts` across all player mutations:
    - **Score Submissions**: Logs event name, session ID, prep/pvp scores, and total score.
    - **Combat Power & Military Metrics**: Logs overall power, tech, champion, crew, flagship, fleet rating, and glory scores with old vs new diffs.
    - **Glory Score Updates**: Logs weekly Glory score submissions with previous value comparisons.
    - **Absence Declarations & Cancellations**: Logs date ranges, absence type (full/reduced), and player reasons.
    - **Guild Transfer Requests**: Logs source guild, target guild, and server number.
    - **Timezone & Push Preferences**: Logs UTC offset adjustments and notification preferences.
  - **High-Performance PostgreSQL Schema & Indexes**: Added dedicated columns `pseudo`, `uid`, `server_number`, and `action_type` to `public.system_audit_logs` with B-tree indexes (`idx_audit_logs_guild_created`, `idx_audit_logs_pseudo`, `idx_audit_logs_uid`, `idx_audit_logs_action_type`, `idx_audit_logs_created_at`), allowing instant search and tenant filtering.
  - **Super Admin Audit Console UI**: Revamped `#tab-system-logs` with live multi-criteria search (by Pseudo, UID, Server, Guild, Action), Guild dropdown, Action Type dropdown, 24h summary KPI cards (Total Submissions, Scores Submitted, Power/Metrics Updates, Active Players), and an interactive Inspect Modal with formatted diffs and raw JSON metadata copying.
  - **Strict Security & Access Control**: Guaranteed Super Admin access via `public.is_super_admin()` RLS policy, and created `public.gm_log_player_audit` `SECURITY DEFINER` procedure with strict search path isolation.
  - **Quality Gate**: **288/288 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Comprehensive Platform Stabilization, Zero-Trust Hardening & PostgreSQL 17 Optimization (v123.7)**:
  - **100% PostgreSQL 17 `search_path` Hardening**: Enforced strict `SET search_path TO ''` across all `SECURITY DEFINER` stored procedures (`gm_apply_subscription_payment`, `gm_guild_benchmark`, `gm_gvg_guild_matchup`, `gm_gvg_player_matchup`, `gm_svs_server_matchup`, `gm_transfer_guild_member`, `request_guild_transfer`, `transfer_guild_member`, `check_uid_exists_globally`, `check_user_guild_access`, `get_push_config`), completely neutralizing schema-hijacking vectors.
  - **Duplicate Function Overload Purge**: Cleaned up obsolete overloaded RPC signatures from the Postgres catalogue, ensuring single-canonical deterministic routing.
  - **Automated Stale-Lock Garbage Collection**: Scheduled daily `pg_cron` job `daily-cleanup-stale-locks` (04:00 UTC) executing `public.gm_cleanup_stale_reminder_locks()` (purged 380 legacy rows from `guild_config`).
  - **Member Portal Strict Tenant Scoping**: Enhanced `getPlayer` query in `supabase/functions/member-portal/index.ts` to strictly enforce `.eq("guild", identity.guild)`, sealing cross-tenant edge cases.
  - **Network Timeout Resilience**: Added explicit 8-second timeouts (`AbortSignal.timeout(8000)`) on all external Discord webhook fetch operations in both `event-reminders` and `discord-webhook-proxy`.
  - **Client-Side Least-Privilege & CSP Hardening**: Corrected JWT parse fallback in `gm-utils.js` (`sessionInfo`) to return `null` instead of `guild_admin`, and removed deprecated AI endpoints from `vercel.json` CSP `connect-src`.
  - **Orphaned Database Table Cleanup**: Dropped legacy unused prototype tables (`public.discord_notifications_sent` and `public.event_reminders_sent`), streamlined tenant table references in `gm-utils.js`, and updated `gm_reset_demo_tenant_data()` with 100% schema alignment.
  - **Quality Gate**: **285/285 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

  - **Calamity Befalls Schedule Correction**: Fixed the anomalous Tuesday Round 3 reminder in `supabase/functions/event-reminders/index.ts` from 05:20 UTC (target 05:30) to 05:50 UTC (target 06:00 UTC), restoring the uniform 3-hour round cadence across all 16 rounds.
  - **Universal Discord Webhook Fallbacks**: Implemented `resolveGuildWebhook()` ensuring all reminder pipelines (Arms Race, Defend Trade Route, Shadowfront, GvG, SvS, and Calamity) automatically fall back to `discord_webhook_url` when specific event webhooks are left empty.
  - **GvG Daily Tasks Idempotency & Stale-Lock Hardening**: Hardened GvG Daily Task lock keys with explicit time slot suffixes (`sent_gvg_daily_tasks_day_${curDay}_${slotDate}_00:01`) and tightened the execution window from 10m to 5m, eliminating duplicate dispatch races caused by stale-lock cleanup.
  - **Universal Atomic Lock Upserting**: Converted all `.insert()` lock operations to PostgreSQL `.upsert()` with refreshed `updated_at` timestamps across all reminder routines, preventing unique constraint error drops.
  - **Quality Gate**: **284/284 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and edge function deployed to production Supabase.

  - **Official Publisher Compliance Document**: Authored a comprehensive 8-section technical whitepaper (`docs/COMPLIANCE_AND_SECURITY_WHITEPAPER.md`) and high-fidelity PDF (`FGF_Guild_Management_Technical_Security_IP_Compliance_Whitepaper.pdf`) formatted for the Game Publisher, legal auditors, and platform compliance teams.
  - **Zero-PII & Privacy-by-Design Governance**: Detailed exhaustive verification demonstrating that zero real-world names, emails, phone numbers, physical addresses, or financial data are processed or stored, operating strictly with pseudonymized in-game nicknames and public numeric metrics under GDPR/CCPA standards.
  - **Zero Copyrighted Game Asset Guarantee**: Proved complete absence of proprietary game textures, sprites, 3D models, audio, or game binaries, detailing the 100% open-source UI design system (Material Design 3.0, Material Symbols Rounded, Three.js WebGL procedural background, Google Fonts).
  - **Ephemeral In-Memory OCR Pipeline**: Documented the screenshot processing architecture ensuring uploaded images are parsed in RAM by Gemini Vision API and destroyed immediately after text extraction without any persistent disk storage.
  - **Automated PDF Generation Pipeline**: Created `scripts/generate-compliance-pdf.js` using Playwright headless Chromium for vector-perfect, styled PDF compilation with custom print layouts, dynamic headers/footers, and page numbers.
  - **Quality Gate**: **284/284 Vitest unit tests green**, 0 TypeScript compiler errors, and clean production build.


- **GvG Daily Task Breakdown Reminders Rescheduled to 00:01 UTC & UI Refinement (v123.4)**:
  - **Daily Schedule Update (00:01 UTC Mon-Sat)**: Updated the automated scheduled notification engine in `supabase/functions/event-reminders/index.ts` from 11:00 UTC to 00:01 UTC, aligning with daily game reset.
  - **Synchronized Webhook Embeds**: Updated Discord webhook message content and footer timestamps in `supabase/functions/_shared/gvg-tasks.ts` and `src/core/config/gvg-tasks.ts` to `00:01 UTC`.
  - **Clean UI Option Label**: Updated `notify_gvg_daily_tasks_desc` across `i18n.js`, `src/core/i18n/i18n.ts`, and `index.html` to display a clean `Daily Tasks breakdown` label without displaying the time in the settings tile, while preserving the manual "Send Today's GvG Tasks Now" instant dispatch button.
  - **Quality Gate**: **283/283 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Same-Guild Member Rename Detection on Duplicate Player ID Addition (v123.3)**:
  - **Same-Guild UID Routing**: Detected when an admin attempts to add a member using a Player ID (UID) that already exists in the **same guild** under an older or alternate name.
  - **Intuitive Rename Prompt**: Replaced the inter-guild transfer request modal with a dedicated "Player Already in Guild" dialog offering a direct "Update Player Name" action displaying both current name, new name, server, rank, power, and name change history.
  - **Direct Roster Update & History Logging**: Automatically updates the player's in-game pseudo across `guild_members` (with full `ON UPDATE CASCADE` to scores, attendance, sanctions, and absences), records the change into `player_name_history`, and snapshots military metrics.
  - **Preserved Inter-Guild Transfer Workflow**: Fully preserved the inter-guild transfer request workflow when a Player ID is detected in a different guild.
  - **Quality Gate**: **282/282 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Mobile OCR UI/UX Redesign & Instant Search Filter across all 12 Scanners (v123.2)**:
  - **Responsive Mobile Card Layout**: Transformed the dense desktop 4-column data table into responsive, touch-friendly 2-level cards on mobile screens (`< 640px`):
    - **Header Row**: Large, full-width player username input (100% width, bold, unclipped) with checkbox and status badge.
    - **Detail Row**: Metric icon and label with high-visibility score input and previous value comparison.
    - **Zero Truncation**: Completely eliminated name truncation for long usernames, Cyrillic names, and repeated prefixes (e.g. `Trader99104` vs `Trader99205`).
  - **Instant Live Search Filter**: Added a real-time search filter input (`#ocr-filter-search`) above the extracted roster table, allowing guild officers to quickly find, audit, and verify specific players or prefixes in seconds across large batches (150+ members).
  - **Full-Screen Mobile Optimization**: Expanded the OCR modal dialog to full viewport height/width on mobile screens with safe-area spacing and sticky action buttons for seamless thumb navigation.
  - **Universal OCR Engine Support**: Automatically active across all 12 OCR scanner modes (Power, Fleet, Tech, Flagship, Champs, Crew, Glory, SvS Prep/PvP, GvG Prep/PvP, Shadowfront, DTR, Arms Race).
  - **Quality Gate**: **277/277 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Demo Accounts Credential Initialization & Player Portal Access Fix (v123.1)**:
  - **Encrypted Password Provisioning**: Configured `gm_reset_demo_tenant_data()` in database migrations and Python generator to initialize both `DemoAdmin` and `DemoPlayer` with deterministic encrypted credentials (`demo1234`) using `pgp_sym_encrypt` and the vault encryption key `gm_accounts_key`.
  - **Demo Player Member Linking**: Linked `DemoPlayer` account to a valid fictional DEMO guild member roster UID (`90000002` - Valkyrie), allowing seamless authentication and instant access to the Player Portal (`portal.js` and `member-portal` Edge Function).
  - **Master RPC Migration Hardening**: Synchronized `gm_check_login`, `gm_admin_upsert`, and `gm_reset_account_password` in `20260812000003_functions_and_rpcs.sql` with the cryptographic password verification schema.
  - **Quality Gate**: **275/275 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Dynamic DEMO Tenant Reset & Daily Automated pg_cron Schedule (v123.0)**:
  - **Dynamic Fictional Dataset Generator (`public.gm_reset_demo_tenant_data`)**: Created an idempotent PostgreSQL stored procedure that dynamically generates 5 weeks of realistic, up-to-date fictional data relative to `CURRENT_DATE`:
    - **Complete Military Metrics**: Populated 60 fictional members (R1 to R5) with full 7 tactical metrics (Overall Combat Power, Technology Power, Champions Power, Crew Power, Flagship Power, Fleet Rating, and Glory Score).
    - **Dynamic Historical Metrics**: Multi-week historical snapshots in `player_metrics_history` and `weekly_scores` ensuring player progression curves and guild average benchmarks are always rich, realistic, and up-to-date.
    - **Deterministic Event Sessions**: Generated SvS, GvG (with dual Prep and PvP scoring), Glory, Defend Trade Route, Arms Race (Stages A & B), and Shadowfront sessions with attendance, excuses, and late strike flags.
    - **Operational Features**: Seeded sample disciplinary sanctions, player absences, Shadowfront squad compositions and player signups, and name change history.
  - **Automated Daily Reset Cron**: Scheduled a daily `pg_cron` job (`daily-demo-tenant-reset`) at 03:00 UTC to automatically sanitize and restore the DEMO tenant, eliminating any test modifications or altered roster data from public demo users.
  - **Synchronized Dev Seeds & Python Generator**: Updated `supabase/seeds/dev_seed.sql` and `scripts/generate_demo_data.py` to match the enhanced 7-score schema and dynamic weekly generation.
  - **Quality Gate**: **274/274 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.


- **Self-Service Subscription Pricing & Plan Calibration for Gemini AI OCR (v122.1)**:
  - **Calibrated SaaS Plan Pricing**: Updated self-service Stripe subscription tiers in `subscription.js` to reflect full Gemini AI Vision OCR capabilities and maintain optimal SaaS margins:
    - **1 Month**: `€9.99` (one-time payment, €9.99/mo).
    - **3 Months**: `€24.99` (one-time payment, save ~17%, €8.33/mo).
    - **6 Months**: `€44.99` (one-time payment, save ~25%, €7.50/mo).
    - **12 Months**: `€74.99` (one-time payment, save ~37% - best value, €6.25/mo).
  - **Full-Stack Stripe Synchronization**: Synchronized client plan definitions in `subscription.js`, backend checkout session amounts in `supabase/functions/_shared/stripe.ts` (999, 2499, 4499, and 7499 cents), and bumped asset versioning in `index.html`.
  - **Quality Gate**: **268/268 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **9 Dedicated AI OCR Event Scanners for Command Center Events (v122.0)**:
  - **Dedicated Event OCR Toolbars**: Integrated 9 dedicated OCR scanner triggers directly into their respective event sub-tabs within the Events Command Center:
    - **SvS Tab**: *SvS Day 1 to 5 OCR* (Preparation score) & *SvS Day 6 OCR* (PvP Battle score).
    - **GvG Tab**: *GvG Day 1 to 5 OCR* (Preparation score) & *GvG Day 6 OCR* (PvP Battle score).
    - **Shadowfront Tab**: *Shadowfront S1 OCR* & *Shadowfront S2 OCR* (Squad 1 and Squad 2).
    - **Defend Trade Route (DTR) Tab**: *DTR OCR* (Score > 0 -> Participated; Score == 0 -> Appointed + Participated).
    - **Arms Race Tab**: *Arms Race SA OCR* & *Arms Race SB OCR* (Stage A and Stage B).
  - **Tenant Tag Filtering & Participation Automation**:
    - SvS and GvG OCRs strictly isolate and target players matching the tenant's configured guild tag, extracting prep/PvP scores and automatically validating the `Participated` toggle.
    - Shadowfront S1/S2 OCR analyzes screenshots against active squad assignments: Main squad members receive `Participated = 1`; Reserve members automatically receive `Sub Present = true` and `Participated = 1`.
    - DTR OCR evaluates presence and score: positive scores validate `Participated = 1`; zero scores validate `Appointed = true` and `Participated = 1`.
    - Arms Race SA/SB OCR detects present members and validates stage participation.
  - **Zero-Regression Full-Stack Synchronization**:
    - Synchronized Gemini Vision Edge Function prompt instructions in `supabase/functions/ocr-guild-members/index.ts`.
    - Extended client-side OCR engine (`OCR_METRICS_META`, `setOcrMetric`, `callGeminiOcrBatchApi`, `renderOcrResults`, and `commitOcrUpdates` in `app.js`).
    - Event tabs automatically reload data and update statistics in real time upon commit.
  - **Quality Gate**: **268/268 Vitest unit tests green** (added test suite for 9 Event OCR schemas and participation evaluation), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Player Portal Streamlined Chart Interface & Redundancy Removal (v121.4)**:
  - **Removed Redundant Bottom List**: Removed the duplicate session breakdown list (`.portal-chart-list`) below progression charts in `portal.js`, concentrating all visual intelligence inside the canvas graph.
  - **Uncluttered Presentation**: The charts cleanly present individual player scores (`33.4M`, `71.1M`), in-graph dashed guild benchmark curves (`Avg 35.1M`), and standardized `DD/MM/YY` timeline dates with zero visual clutter.
  - **Quality Gate**: **263/263 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Player Portal Clean DD/MM/YY (JJ/MM/AA) Date Formatting on Horizontal Chart Axes (v121.3)**:
  - **Standardized Date Formatting**: Implemented `formatPortalDateDDMMAA` in `portal.js` converting ISO date strings, compact session identifiers (`ARA-20260815`), and ISO week codes (`SVS-2026-W33`) into clean `DD/MM/YY` format (e.g. `15/08/26`, `10/08/26`).
  - **Horizontal Chart Axis Alignment**: Applied `DD/MM/YY` labels cleanly on the canvas X-axis of SvS, GvG, and Glory charts, eliminating ISO week codes and truncated strings.
  - **History Breakdown Synchronization**: Rendered the same compact `DD/MM/YY` date format in the session score breakdown rows beneath each progression chart.
  - **Quality Gate**: **263/263 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Player Portal Pixel-Perfect Military Tile Alignment & Cohesive Grid Hierarchy (v121.2)**:
  - **Pixel-Perfect Military Tile Layout**: Introduced `.portal-military-grid` (7-column layout on desktop) and structured `.portal-military-tile` with exact fixed heights across Header (`32px`), Combat Power Value (`28px`), and Footer Benchmark (`20px`).
  - **Identical Vertical Alignment**: All 7 military tiles (Fleet, Tech, Flagship, Champs, Crew, Glory, and Power) now display their titles, delta pills, numbers, and `Guild Avg` rows at the exact same horizontal baselines.
  - **Cohesive Participation Tiles**: Standardized internal elements of the 4 participation tiles with structured heights for titles, rates, attendance subtexts, and badge chips.
  - **Quality Gate**: **263/263 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Player Portal Full Material Design 3 Overhaul & Chart Dashed Benchmark Lines (v121.1)**:
  - **Dashed In-Graph Guild Average Lines**: Replaced vertical Y-axis raw numbers with a clean, uncluttered continuous dashed reference line (`#ffe088`, 2.2px line width, `strokeDasharray: [8, 6]`) across the canvas with a floating M3 amber pill badge (`Avg XX.XM`), eliminating axis overlap and visual noise.
  - **Single Horizontal Line for 4 Participation Tiles**: Updated `.portal-participation-grid` to strictly `repeat(4, 1fr)`, ensuring Arms Race A, Arms Race B, Defend Trade Route, and Shadowfront tiles all sit on a single horizontal row on desktop.
  - **Live Guild Benchmarks in Breakdown Cards**: Deployed and integrated `member-portal` backend with robust fallback merging across all dashboard actions so that every military breakdown card displays its exact formatted Guild Average (`Guild Avg: 1.8M`).
  - **Full Material Design 3 Design System**: Standardized all surfaces, container tiers, rounded corners (`16px`, `12px`, `full`), elevation tokens, segmented buttons, and typography on official Google M3 tokens (`tokens.css` + `components.css`).
  - **Quality Gate**: **263/263 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Player Portal Guild Average Progression Curves & Complete UX/UI Overhaul (v121.0)**:
  - **Dual-Series Progression Charts**: Added a secondary **Guild Average Benchmark curve** (rendered as a warm amber dashed line with average score indicators) alongside the player's primary solid emerald score curve across SvS, GvG, and Glory event charts in `portal.js`.
  - **Live Performance Delta Badges**: Every session breakdown below the progression charts displays the player's score, guild average score, and a relative performance badge (e.g. `+26.3% vs Avg` in emerald or `-8.2% vs Avg` in amber).
  - **Guild Military Benchmarks**: Extended the Military Force Breakdown with 7 component tiles (Fleet Rating, Technology Power, Flagship Power, Champions Power, Crew Power, Glory Score, Overall Combat Power), each displaying the player's stat, the guild average benchmark, and real-time comparative percentage differences.
  - **Backend RPC Aggregation**: Enhanced `supabase/functions/member-portal/index.ts` (`get-history` and `get-active-sessions`) to compute guild-wide weekly and session averages (`guild_avg_score`, `guild_max_score`, and military `guild_averages`) securely without exposing individual teammate data to member accounts.
  - **Complete Modern UI/UX Redesign**: Redesigned the Player Portal following Material Design 3.0 and Apple Cozy Neutral design tokens (warm graphite `#121214`–`#1a1a1f`, frosted glass, high-contrast typography, interactive status badges, seamless mobile navigation).
  - **Quality Gate**: **263/263 Vitest unit tests green** (added test suites for session averages and military benchmark calculations), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Technology Power Weight Boost to 6.0x (v120.7)**:
  - **Calibrated Technology Multiplier**: Increased Technology Research Power weight in `calculateCombatDensity` and `calculateRallyScore` in `gm-utils.js` to **$\times 6.0$** (was 4.0x), elevating the tactical influence of high research levels on the composite Rally Combat Score.
  - **Hierarchy Preservation**: USAFE remains benchmark #1 (`100/100`), Kelisco rises to `99/100` (`629.5M`), and HawkEye firmly retains Rank 7 (`87/100`, well above ODIN's `80/100`).
  - **Quality Gate**: **261/261 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Clean Minimalist Rally Grade /100 Column (v120.6)**:
  - **Streamlined Display**: Refactored the `⚡ Rally Score` table cell in `app.js` to render exclusively the sleek tactical grade chip (`⚡ XX/100`), removing secondary power numbers for a cleaner, high-contrast layout.
  - **Tooltip Retention**: The exact absolute combat score remains fully accessible via the chip's hover tooltip (e.g. `Rally Grade: 98/100 (592.1M)`).
  - **Quality Gate**: **261/261 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Rally Grade out of 100 System & Visual Chip Display (v120.5)**:
  - **Relative /100 Tactical Grade Rating**: Added `calculateRallyGrade(member, maxScore)` in `gm-utils.js` normalizing the guild's leading strike force to `100/100` and rating all other guild members proportionally (e.g. `98/100`, `94/100`, `87/100`).
  - **Tactical Chip Display**: Rendered a dedicated `⚡ XX/100` tactical grade chip in the `⚡ Rally Score` column of the matrix table with secondary absolute combat power displayed directly beneath.
  - **Quality Gate**: **261/261 Vitest unit tests green** (added test suite for `calculateRallyGrade`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Magnitude-Normalized Tactical Combat Scale Calibration (v120.4)**:
  - **Magnitude Realism Calibration**: Calibrated the multipliers in `calculateCombatDensity` and `calculateRallyScore` in `gm-utils.js` to account for differing natural orders of magnitude across military metrics:
    - **Strongest Fleet Rating ($\times 80.0$)**: Normalized 1.5M–2.5M march ratings to deliver spearhead combat contribution (~160M–184M).
    - **Flagship Power ($\times 18.0$)**: Normalized 8M–10.4M capital flagship values to deliver core rally buff weight (~150M–190M).
    - **Crew Power ($\times 8.0$)**: Normalized 2.5M–4.5M tactical officer ratings (~20M–36M).
    - **Technology Power ($\times 4.0$)**: Normalized 9M–18.7M permanent tech trees (~36M–75M).
    - **Base Total Power ($\times 1.0$)**: Direct base force weight (~80M–120M).
    - **Champion Power ($\times 0.8$)**: Arena hero collection weight (~14M–21M).
    - **Sunday Glory Score ($\times 0.05$)**: Re-calibrated weekly event score (50M–500M) as a bonus (~3M–25M) instead of completely overpowering base military stats.
  - **True Tactical Hierarchy**: USAFE accurately ranks #1, Kelisco ranks #2, and HawkEye ranks #7 (decisively above ODIN #11).
  - **Quality Gate**: **260/260 Vitest unit tests green** (including real full guild roster ranking verification), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Absolute Rally Combat Power Ranking & Dual Display (v120.3)**:
  - **Absolute Strike Force Ranking**: Transitioned Tactical Force Matrix default sorting and Top 16 Rally Leader appointments to **Absolute Rally Combat Power** (`calculateRallyScore`), preventing percentage density ratios from inverting raw military strength.
  - **Whale & Combat Powerhouse Realism**: Players with massive Flagships, high-tier 1st marches, and deep military tech trees are decisively ranked at the top of the command roster (`Leader #1-#16`).
  - **Dual Tactical Metric Display**: The `⚡ Rally Score` column prominently renders the player's formatted absolute combat score (e.g. `485.2M`) with secondary inline density purity indicator `(94.2%)`.
  - **Quality Gate**: **259/259 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Defensive 0-Defaulting for Missing Tactical Metrics (v120.2)**:
  - **Safe Score Metric Parsing**: Implemented `parseSafeMetric` helper in `gm-utils.js` to ensure any missing, unrecorded, null, empty string, or undefined military score defaults strictly to `0`.
  - **Graceful Partial Scoring**: Players with partially submitted or unrecorded metrics are scored safely and accurately across `calculateCombatDensity`, `calculateRallyScore`, `calculateResidualPower`, and `calculateCombativity` without runtime exceptions or calculation distortion.
  - **Quality Gate**: **258/258 Vitest unit tests green** (added explicit test coverage for partial metric objects), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Fleet Power Multiplier Upward Calibration to 3.5x (v120.1)**:
  - **Calibrated Fleet Multiplier**: Increased Strongest Fleet Rating weight in `calculateCombatDensity` and `calculateRallyScore` to **$\times 3.5$** (was 2.5x), strengthening the tactical importance of 1st march ratings in rally composition.
  - **Complete Hierarchy**: $\text{Power} (\times 1.0) > \text{Flagship} (\times 4.0) > \text{Fleet} (\times 3.5) > \text{Tech} (\times 2.25) > \text{Crew} (\times 1.5) > \text{Glory} (\times 1.0) > \text{Champs} (\times 0.8)$.
  - **Quality Gate**: **257/257 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Champion Power Multiplier Fine-Tuning to 0.8x (v120.0)**:
  - **Calibrated Champions Multiplier**: Adjusted Champion Power weight in `calculateCombatDensity` and `calculateRallyScore` to **$\times 0.8$** (was 1.0x) to balance hero collection stats against officer synergies and direct fleet ratings.
  - **Complete Hierarchy**: $\text{Power} (\times 1.0) > \text{Flagship} (\times 4.0) > \text{Fleet} (\times 2.5) > \text{Tech} (\times 2.25) > \text{Crew} (\times 1.5) > \text{Glory} (\times 1.0) > \text{Champs} (\times 0.8)$.
  - **Quality Gate**: **257/257 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Technology Research Multiplier Boost to 2.25x (v119.9)**:
  - **Calibrated Tech Multiplier**: Adjusted Technology Power weight in `calculateCombatDensity` and `calculateRallyScore` to **$\times 2.25$** (was 2.0x), providing enhanced weighting for research and tech tree advances.
  - **Complete Hierarchy**: $\text{Power} (\times 1.0) > \text{Flagship} (\times 4.0) > \text{Fleet} (\times 2.5) > \text{Tech} (\times 2.25) > \text{Crew} (\times 1.5) > \text{Champs} (\times 1.0) > \text{Glory} (\times 1.0)$.
  - **Quality Gate**: **257/257 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Tactical Rally Multiplier Calibration: Flagship x4, Champs x1, Glory x1 (v119.8)**:
  - **Calibrated Tactical Multipliers**: Updated `calculateCombatDensity` and `calculateRallyScore` in `gm-utils.js`:
    - **Flagship Power**: Multiplier updated to **$\times 4.0$** (reflecting pivotal flagship capital stats and rally auras).
    - **Champion Power**: Multiplier updated to **$\times 1.0$** (full 1:1 hero contribution).
    - **Glory Score**: Multiplier updated to **$\times 1.0$** (full 1:1 Sunday PvP battle activity contribution).
    - **Complete Hierarchy**: $\text{Power} (\times 1.0) > \text{Flagship} (\times 4.0) > \text{Fleet} (\times 2.5) > \text{Tech} (\times 2.0) > \text{Crew} (\times 1.5) > \text{Champs} (\times 1.0) > \text{Glory} (\times 1.0)$.
  - **Quality Gate**: **257/257 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Tactical Force Matrix Strict Descending Combat Density Ordering (v119.7)**:
  - **Strict Descending Density Sort**: Configured `sortMembers` and matrix rendering to strictly order players by descending Combat Density score (`calculateCombatDensity`), with deterministic multi-level tie breakers on Power, Flagship, and Fleet.
  - **Synchronized Density Hierarchy**: Ranks 1 to 16 in the Density descending leaderboard are assigned as Rally Leaders #1 through #16, ensuring 100% visual consistency between Density values and row ordering.
  - **Quality Gate**: **257/257 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Tactical Force Matrix Dedicated Rally Column & Top 16 Leaders Assignment (v119.6)**:
  - **Dedicated Rally Role Column**: Added a prominent `🎯 Rally` column immediately after the `Player` column in the Tactical Force Matrix table.
  - **16 Rally Leaders vs Rally Joiners Assignment**:
    - **Top 16 Tactical Commanders**: Automatically assigned as **`Rally Leader #1`** through **`Rally Leader #16`** based on their comprehensive Rally Readiness Score.
    - **Tiered Leader Badging**: Top 4 leaders receive Gold Crown badges (`👑 Leader #1-#4`), ranks 5–8 receive Purple Star badges (`Leader #5-#8`), and ranks 9–16 receive Blue Target badges (`Leader #9-#16`).
    - **Rally Joiners**: All remaining guild roster members are labeled as **`Rally Joiner`** with a clean tactical chip (`<i class="ph ph-users"></i> Rally Joiner`).
  - **Rally Role Meta Helper**: Added `window.GM.getRallyRoleMeta(rank, score)` in `gm-utils.js`.
  - **Quality Gate**: **257/257 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Tactical Rally Readiness Multiplier Calibration (v119.5)**:
  - **Calibrated Multipliers**: Adjusted tactical combat density and rally scoring multipliers in `gm-utils.js`:
    - **Tech Power Multiplier**: Calibrated to **$\times 2.0$** (reflecting pivotal research tree impact on fleet defense and attack).
    - **Fleet Rating Multiplier**: Calibrated to **$\times 2.5$** (proportional 1st march rating contribution).
    - **Full Hierarchy**: $\text{Power} (\times 1.0) > \text{Flagship} (\times 3.0) > \text{Fleet} (\times 2.5) > \text{Tech} (\times 2.0) > \text{Crew} (\times 1.5) > \text{Champs} (\times 0.4) > \text{Glory} (\times 0.03)$.
  - **Quality Gate**: **256/256 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Tactical Force Matrix Automatic Density & Rally Leaderboard Sorting (v119.4)**:
  - **Tactical Rally Leadership Hierarchy**: Redesigned combat density and rally readiness algorithms (`calculateCombatDensity`, `calculateRallyScore`, `calculateWarScore`) strictly following the hierarchy: **Power > Flagship > Fleet > Tech > Crew > Champs > Glory**.
  - **Automatic Rally Leader Sorting**: The Tactical Force Matrix now sorts members automatically by Rally Readiness Density (`density_desc`), allowing guild leaders and admins to identify optimal rally captains at a single glance.
  - **Visual Rally Captain Badges**: Top 3 tactical captains automatically display prominent badges (`👑 Rally 1`, `Rally 2`, `Rally 3`) directly on the matrix roster table.
  - **Quality Gate**: **256/256 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Tactical Force Matrix Dynamic Sunday Glory Synchronization (v119.3)**:
  - **Automatic Latest Glory Reconciliation**: In the Tactical Force Matrix and member military metrics, the Glory column now seamlessly integrates the latest recorded Sunday score for each player from `event_participants` where `event_name = 'Glory'`.
  - **Zero-Stale Metrics Guarantee**: When loading guild members (`fetchGuildMembers`), the system retrieves the most recent weekly Glory score per player across historical weeks, updating `m.glory_score` and guild totals in real time even when mid-week before Sunday's new logs.
  - **Synchronous Glory RPC & Database Migration**: Updated `public.gm_upsert_player_glory` to simultaneously write to `event_participants`, update `guild_members.glory_score`, and snapshot into `player_metrics_history`. Backfilled all historical Glory records into active member rows (`20260817220000_sync_glory_score_to_guild_members.sql`).
  - **Quality Gate**: **255/255 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Multi-Guild Tag Administration & Server-Wide OCR Leaderboard Filtering (v119.2)**:
  - **In-Game Guild Tag Administration**: Added `#guild-tag-setting` in Guild Configuration & Settings, allowing guild admins to specify their in-game tag (e.g. `[PR1M]` for `ALPHA`, `[OMG]` for `OMEGA`, `[BABE]`, `[IMK]`, `[CLAW]`), stored in `guild_config`.
  - **Intra-Guild vs Multi-Guild Server Leaderboard Scanners**:
    - **Intra-Guild Scanners** (`Power`, `Tech Power`, `Glory`): Screenshots contain exclusively guild members; all detected players are recognized as members or new recruits.
    - **Multi-Guild Server Leaderboard Scanners** (`Strongest Fleet`, `Strongest Flagship`, `Champion Power`, `Crew Power`): Screenshots contain multi-guild players from across the entire server.
  - **Dynamic OCR Modal Guild Tag Filter**: Prominently displays the active Guild Tag filter banner in the OCR modal with real-time editing and pre-fill from guild settings.
  - **AI OCR Tag Stripping & Smart Checkbox Protection**:
    - Gemini vision system automatically recognizes guild tag prefixes, returning clean usernames.
    - `cleanPlayerPseudo` strips bracketed tags (`[PR1M]`, `[ALPHA]`, etc.) before roster matching.
    - Players matching guild members are checked by default with `Update` or `Reconciled` status.
    - Non-guild server players are flagged as `<span class="gm-chip">⚠️ Other Guild</span>` and **unchecked by default**, preventing unintentional member creations while scanning 100-player server rankings.
  - **Quality Gate**: **254/254 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **7-Metric AI OCR Scanners Engine & Dynamic Metric Synchronization (v119.1)**:
  - **7 Dedicated Metric OCR Scanners**: Replaced single power OCR with 7 specialized AI OCR tools for *Foundation Galactic Frontier*:
    1. 🌐 **1. Power OCR**: Overall Total Power (`overall_power`).
    2. ⚔️ **2. Fleet OCR**: Strongest Fleet Rating / First March (`fleet_rating`).
    3. 🔬 **3. Tech OCR**: Technology Power (`tech_power`).
    4. 🚀 **4. Flagship OCR**: Flagship combat power (`flagship_power`).
    5. 👑 **5. Champs OCR**: Champion / Hero total power (`champion_power`).
    6. 👥 **6. Crew OCR**: Crew / Officer total power (`crew_power`).
    7. 🏆 **7. Glory OCR**: Weekly PvP Glory points (`glory_score`).
  - **Interactive OCR Metric Switcher**: Added a 7-tab segmented bar (`#ocr-metric-tabs`) inside the OCR modal allowing seamless switching between metrics without leaving the modal.
  - **Context-Aware Gemini AI Prompts**: Edge Function `ocr-guild-members` dynamically adapts its Gemini vision instruction set based on `metricType`, converting OCR leaderboards and score strings into clean integers.
  - **Targeted Metric Reconciliation & Progression Snapshots**: Validating OCR results updates the targeted metric column in `guild_members` and automatically invokes `gm_upsert_player_metrics` to record progress in `player_metrics_history`.
  - **Quality Gate**: **250/250 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **7-Score Tactical Military Metrics, Combat Density & Player Force Breakdown Engine (v119.0)**:
  - **7 Native Military Metrics Integration**: Extended player schema across all tenants and the Player Portal with the 7 core numeric metrics of *Foundation Galactic Frontier*:
    - 🌐 **Overall Total Power**: Macro account strength.
    - ⚔️ **Strongest Fleet Rating**: First march strike rating and rally leader qualification.
    - 🔬 **Technology Power**: Research advancement and alliance passives.
    - 🚀 **Flagship Power**: Flagship weapon and hull combat strength.
    - 👑 **Champions Total Power**: Hero investment and battle leadership.
    - 👥 **Crew Total Power**: Foundation officers (Salvor Hardin, Raych Seldon, Phara, Poly...).
    - 🏆 **Glory Score**: Lifetime PvP and battle activity.
  - **Derived Mathematical KPIs & Instant Ratios**:
    - **Combat Density Ratio (%)**: Percentage of permanent combat power vs total account power.
    - **Volatile Troop Power**: Isolates disposable ship power from permanent tech/hero investments.
    - **Combativity Ratio (x)**: Glory-to-Power aggressiveness and wartime ROI.
    - **Composite War Score**: Multi-criteria weighted formula for objective battle roster selection.
  - **Zero-Trust Player Portal Experience**:
    - **Military Force Breakdown**: 6 real-time stat cards with Density and Combativity pills in "My Progress".
    - **Multi-Metric Military Editor**: 1-click update in "My Info" with live KPI recalculation on input and defensive bounds up to 1,000,000,000 (1B).
  - **Admin Command Center Upgrades**:
    - **Tactical Member Sorting**: Instant sorting by Fleet Rating, Tech Power, Flagship, Champions, Crew, Glory, Density, and War Score.
    - **Micro Combat Badges**: Color-coded tactical badges on member cards in the guild roster.
    - **Full Military Modal**: 7-score edit fields in the admin member modal.
  - **PostgreSQL & Edge Functions**:
    - Canonical migration `20260817203000_player_scores_and_metrics_tracking.sql` with `player_metrics_history` table, RLS, and `gm_upsert_player_metrics` / `gm_get_player_metrics_history` RPCs.
    - Updated `member-portal` edge function with `update-metrics` and `get-metrics-history`.
  - **Quality Gate**: **249/249 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Inter-Server Migration Scouting & Normalized 0–100 Combat Scoring Engine (v118.0)**:
  - **Unified 0–100 Normalized Scoring Hierarchy**: Standardized all ranking metrics on an intuitive 0 to 100% scale for instant evaluation across servers:
    - **Draft Master Score (0–100%)**: Global composite index synthesizing attendance, combat capability, and Glory dedication.
    - **Day 6 PvP Combat Rating (0–100%)**: Battle performance rating combining SvS & GvG battle presence and doubled ($2\times$) Day 6 combat scores against benchmark targets.
    - **Glory Performance Rating (0–100%)**: Normalized Glory score factoring weekly presence rate and cumulative Glory points volume.
    - **Shadowfront Attendance (0–100%)**: Priority 20v20 guild coordination attendance rate (30% dominant weight in Draft index).
    - **SvS & GvG Presence (0–100%)**: Foundation attendance rates across multi-day campaigns (15% each in Draft index).
  - **Target Server Isolation & Migration Scouting**: Added dynamic migration server dropdown selector (e.g. Server `#1058`, `#1064`) allowing Super Admins and Guild Leaders to isolate prospective candidates from specific target servers in seconds.
  - **Scouting Focus Quick Presets**: Added 1-click filter chips (`All Candidates`, `⚔️ Day 6 PvP (≥40%)`, `👻 Shadowfront (≥50%)`, `🏆 Glory (≥40%)`, `👑 Elite (≥75%)`).
  - **PostgreSQL Canonical Migration (`20260817190000_draft_scouting_and_combat_scoring.sql`)**: Overhauled `public.gm_cross_guild_ranking()` with `SECURITY DEFINER` access controls, 95th-percentile benchmark normalization, and scouting tiers (`ELITE`, `WARRIOR`, `PILLAR`, `RECRUIT`).
  - **Compact Responsive UI**: Optimized `.gm-draft-table` padding and column widths, ensuring all columns fit without cropping on standard screens.
  - **Quality Gate**: Verified with **240/240 Vitest unit tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Google Material Design 3 (M3) Extended Color Ecosystem, Material Symbols & Elevated Podium Overhaul (v117.0)**:
  - **Official Google M3 Tonal Palettes**: Completely enriched `tokens.css` with Google Workspace / Android 14+ CAM16/HCT tonal palettes, dedicating a distinct, recognizable Google color for every game event:
    - 🔵 **GvG (Guild vs Guild)** $\rightarrow$ **Google Cobalt Blue** (`#a8c7fa` / `#062e6f`)
    - 🟡 **SvS (Server vs Server)** $\rightarrow$ **Google Amber / Gold** (`#ffe088` / `#3b2d00`)
    - 🟢 **Glory (Weekly Roster)** $\rightarrow$ **Google Emerald Green** (`#6dd58c` / `#0a3818`)
    - 🟠 **Arms Race (ARA / ARB)** $\rightarrow$ **Google Coral / Orange** (`#ffb787` / `#4e2600`)
    - 🟣 **Shadowfront (Squad 1 / 2)** $\rightarrow$ **Google Deep Purple / Indigo** (`#d0bcff` / `#381e72`)
    - 🔷 **Defend Trade Route (DTR)** $\rightarrow$ **Google Cyan / Teal** (`#78d9ec` / `#00363d`)
    - 🔴 **Sanctions & Bans** $\rightarrow$ **Google Crimson Red** (`#f2b8b5` / `#601410`)
    - 🪻 **Super Admin & Diagnostics** $\rightarrow$ **Google Magenta / Violet** (`#e8b4f8` / `#43114d`)
  - **Comprehensive Material Symbols Rounded Integration**: Upgraded navigation items, tabs, topbar, bottom nav, drawer, and buttons across `shell.js` and `index.html` with official Google *Material Symbols Rounded* (`swords`, `rocket_launch`, `trophy`, `bolt`, `radar`, `local_shipping`, `group`, `gavel`, `leaderboard`, `settings`, `terminal`), supporting dynamic fill states (`FILL: 1`) on active tabs.
  - **Modernized M3 Player Rankings Podium**: Overhauled `.gm-podium-stage` in `stats.js` and `components.css`:
    - **#1 MVP (Gold)**: Level 3 Elevation, Google Amber tonal container, glowing gold avatar ring, animated floating M3 crown (`crown`), golden tabular score pill.
    - **#2 (Silver)**: Level 2 Elevation, Titanium tonal container, silver metallic rank badge (`military_tech`).
    - **#3 (Bronze)**: Level 1 Elevation, Copper/Bronze tonal container (`workspace_premium`).
    - **Micro-Interactions**: M3 circular avatars with centered rank badges (1, 2, 3) and smooth cubic-bezier hover elevation shifts (`transform: translateY(-6px)` with Level 4 elevation).
  - **Quality Gate**: Verified with **235/235 Vitest unit tests green**, **7/7 Playwright e2e tests green**, 0 TypeScript errors, and clean Vite build.

- **Material Design 3.0 (M3) & Apple-Inspired Cozy Neutral Design System Overhaul (v116.0)**:
  - **Comprehensive Material 3 Tokens Hierarchy**: Completely refactored `tokens.css` to introduce the official Google Material Design 3 surface containers (`--md-sys-color-surface`, `surface-container-lowest` to `surface-container-highest`), elevation tokens (Levels 0 through 5), corner radii (`--md-sys-shape-corner-*`), and Apple-inspired cozy graphite/titanium palettes with backward-compatible aliases for legacy variables.
  - **Refined Variable Typography & Material Symbols**: Integrated Google Fonts *Plus Jakarta Sans* and *Inter* variable type scales paired with *Material Symbols Rounded* (`wght: 350`, `FILL: 0/1`, `opsz: 24`), delivering crisp, elegant icons with dynamic fill states for active items.
  - **Modernized & User-Friendly Login Experience**:
    - **M3 / Apple Segmented Pill Switcher**: Added seamless `[ 🔐 Sign In | ✍️ Register Player ]` pill control on the login view for intuitive, tabbed navigation between credentials entry and player onboarding.
    - **Unified Authentication Gateway**: Streamlined single point of entry for Guild Leaders, Super Admins, and Players with automatic cryptographic routing to Command Center or Player Portal.
    - **Interactive Password Visibility**: Enhanced visibility toggles supporting both Material Symbols and Phosphor glyphs.
    - **Elevated Frosted Glass Container**: Redesigned login card with `backdrop-filter: blur(28px)`, subtle hairline specular highlights, and cozy warm graphite canvas.
  - **Architecture & Developer Guidelines Alignment**: Updated `AGENTS.md` with strict Material Design 3 + Apple Cozy Neutral UI standards, guaranteeing 100% English code/docs and zero-regression on DOM selectors and auth flows.
  - **100% Quality Gate Passed**: Verified complete test battery with **235/235 Vitest tests green**, **7/7 Playwright browser tests green**, 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Automated GvG Daily Task Reminders & Points Breakdown Notifications (v115.3)**:
  - **Scheduled Notification Engine (11:00 UTC Mon-Sat)**: Implemented automated daily scheduled task breakdowns in `supabase/functions/event-reminders/index.ts` triggering every Monday through Saturday at 11:00 UTC for all active GvG campaigns.
  - **Pg_cron Automation & Security Authentication**: Created migration `20260817114500_update_event_reminders_cron_secret.sql` configuring `pg_cron` with automated minute-by-minute execution and direct `CRON_SECRET` authorization.
  - **Edge Function Runtime Hardening**: Eliminated duplicate block-scoped variable declarations (`guildTag`) in `event-reminders/index.ts` that caused Deno `BOOT_ERROR`, added multi-layer authorization (`CRON_SECRET`, Service Role Key, and JWT `validateCallerAuth`), and converted Web Push to resilient lazy imports.
  - **On-Demand Dispatch Button**: Added interactive "Send Today's GvG Tasks Now" button in the Guild Settings modal (`index.html`, `app.js`, `i18n.js`, `src/core/i18n/i18n.ts`) allowing Guild Leaders to instantly trigger or test daily task breakdowns on Discord anytime.
  - **Comprehensive Daily Points Breakdown**: Created shared configuration modules (`src/core/config/gvg-tasks.ts` and `supabase/functions/_shared/gvg-tasks.ts`) defining exact point scoring values for all 6 days:
    - ⚡ **Day 1 (Monday)**: Speedups & Trade (+48/min, +1,000 trade), Rallies (Deliverer Ark +18k, Tribute Vessels +18k, Sacred Tribute +6k), Ascendancy Minions (Lvl 1-60 from +3k to +6k), Packs (+4/credit).
    - 👑 **Day 2 (Tuesday)**: Champions & Power (+6k Leg / +300 Epic frag, +3/power, Training Manual +600, Venturous Memory +2.4k), Weapons (Prism +4k, Energy Core +18, Epic/Leg frags +2.4k/+12k), Commissions (Common to Leg +6k to +9.75k), Commerce Guild (Assist +20, Donation +50).
    - 🔬 **Day 3 (Wednesday)**: Tech Speedups (+48/min), Tech items (Computational +400, Beacon +800, Echo Module +80, Echoes of Deep Space +16k), Ruins (Leg Excavation +30k, Plunder +50k), Map Search (+360k).
    - 🛸 **Day 4 (Thursday)**: Flagship upgrades (+3/power, Blueprints +6k, Prismatic Core +2.4k), Commissions (+6k to +9.75k), Packs (+4/credit).
    - 🌟 **Day 5 (Friday)**: All-Out Preparation: Speedups, Champions, Flagship, Rallies (+18k), Tech items (+400 to +16k), Weapons & Exploration (Map Search +360k, Plunder +50k), Commissions & Packs.
    - ⚔️ **Day 6 (Saturday)**: Total War: War Prism (+10 per 100 dmg, +1M last hit), Ascendancy Shrine (+60k), War Fortresses (+50k per 2m), Shipbuilding (+48/min), Commerce Glory (+3/glory), and PvP Fleet Combat (Defeating/Losing Craft T1-T7 from +1.5k to +180k).
  - **Discord Rich Embed Generator**: Standardized Discord embeds featuring day-specific color themes, structured emoji fields, formatted point values, automatic role pings, timestamp, and web push notifications.
  - **Guild Leader Configuration & Opt-In/Opt-Out**: Added persistent `notify_gvg_daily_tasks` toggle in the Guild Settings modal (`index.html`, `app.js`, `gm-utils.js`), with full translation support in `i18n.js` and `src/core/i18n/i18n.ts`.
  - **Quality Assurance**: Added unit test battery in `tests/gvg-tasks.test.js` bringing total passing test suite to **235/235 tests green** (`npm test`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Glory Score Persistence, Ghost NULL Session Prevention & Cross-Tenant Data Harmonization (v114)**:
  - **Ghost NULL Session Prevention**: Eliminated raw un-sessioned pre-insertions in `glory.js` on view load, resolving the issue where opening the Glory tab generated ghost rows (`session_id IS NULL`) that collided with deterministic SaaS sessions (`GLORY-YYYY-Www`).
  - **Deduplication & Score Integrity**: Hardened score parsing across `glory.js`, `history.js`, and `overview.js` to strictly prioritize non-null values during deduplication, preventing entered scores from resetting to zero upon navigating between tabs.
  - **Hardened RPC Security & Auto-Cleanup**: Updated `public.gm_upsert_player_glory` with write access verification, active subscription validation, and automatic deletion of legacy un-sessioned rows upon every score update.
  - **Cross-Tenant Database Migration**: Created `20260817060000_fix_glory_ghost_null_sessions.sql` to cleanly backfill deterministic session IDs and purge un-sessioned duplicate entries across all guild tenants (`ALPHA`, `OMEGA`, `BABE`, `IMK`, `YARR`, `CLAW`, `DEMO`, `SEN`, `NIGHTWRAITH`, `OBSIDIANSTAR`, `ASTRAL_LIBERION`, `BLACKTHUNDER`, `TWILIGHT`).
  - **Quality Assurance**: Added dedicated unit test battery in `tests/glory.test.js` maintaining **226/226 unit tests green** (`npm test`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Modernized 2026 Executive Stats Hub & Analytics Engine (v113)**:
  - **3-Domain Streamlined Architecture**: Reorganized the statistics module into a high-visibility, executive experience:
    - 🩺 **Guild Health & Overview**: Comprehensive power macro metrics, active roster ratios, power tier distribution, and 8-week historical trend.
    - ⚠️ **Proactive Inactivity & MVP Detection**: Side-by-side actionable cards highlighting top contributors and flagging at-risk members with 0 attendance over the last 2+ weeks (including last seen dates and power).
    - 🏆 **Unified Player Rankings**: Composite weighted score formula, 3D podium stage, sub-filters for SvS, GvG, pure attendance rate, and real-time live member search.
    - ⚔️ **6-Event Activity Breakdown**: Detailed per-event tracking across SvS, GvG, Shadowfront, Arms Race, DTR, and Glory.
  - **Dynamic Timeframe Management**: Support for 1-week, 2-week, 4-week, 8-week, and All-Time analysis with automatic future week exclusion.
  - **Quality Assurance**: Maintained 100% quality gate compliance with **222/222 unit tests green** (`npm test`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Four-Role Zero-Trust Access Model, Server Admin Role & Dynamic Role Assignment (v112)**:
  - **New `server_admin` Role Level**: Introduced server-scoped administration allowing federation and server leaders to manage all guilds sharing the same `server_number` across rosters, active events, scores, sanctions, and Discord webhooks without granting global `super_admin` access.
  - **Dynamic Role Promotion & Assignment**: Added real-time role selector on account cards in the Super Admin dashboard, allowing Super Admins to promote any existing `guild_admin` to `server_admin` (or reassign roles) with immediate database, GoTrue JWT metadata, and UI synchronization.
  - **New Admin Account Role Selection**: Super Admin account creation form now supports selecting between `Guild Admin (R4)` and `Server Admin (Server Leader)` at creation time.
  - **Edge Function `update-role` Action**: Added dedicated `update-role` mutation in `supabase/functions/admin-accounts/index.ts` with strict Super Admin verification, automated server number resolution, and synchronized GoTrue `app_metadata.app_role` updates.
  - **Canonical Database Migrations**: Added `server_number` column to `public.accounts`, implemented `public.is_server_admin()` helper function, updated `public.gm_admin_list()` to return `server_number`, and enhanced `public.gm_can_read_guilds()`, `public.gm_can_read_guild_data()`, `public.gm_can_read_account()`, and `public.check_user_guild_write_access()` to enforce strict server-number scoping while eliminating legacy single-tenant fallbacks.
  - **Dynamic Server-Scoped Guild Switcher**: Updated `shell.js` topbar to automatically filter and display only guilds matching the `server_admin`'s assigned `server_number` with seamless switching.
  - **DOM & HTML Hygiene**: Cleaned up `index.html` structure by moving `#ocr-modal-overlay` out of the script tag block into the proper modal section.
  - **Architectural Memory**: Documented the four-role model in `docs/adr/ADR-006-four-role-access-model-with-server-admin.md` and updated `AGENTS.md`.
  - **Quality Assurance**: Added full test coverage in `tests/roles.test.js` and `tests/security_hardening.test.js`, maintaining **222/222 unit tests green** (`npm test`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

- **Antigravity 2.0 AI Engineering Infrastructure, MCP Memory & Architecture Decision Records (v111)**:
  - **Persistent MCP Knowledge Graph Memory**: Configured `@modelcontextprotocol/server-memory` to enable long-term cross-session memory, entity relationship mapping, and anti-regression tracking.
  - **Specialized Workspace Skills**: Added 5 dedicated Antigravity skills in `.agents/skills/` (`fgf-saas-architect`, `fgf-rls-security`, `fgf-quality-gate`, `fgf-changelog-discord`, `fgf-memory-keeper`) enforcing multi-tenant invariants, Zero-Trust RLS, and automated quality gates.
  - **Architecture Decision Records (ADRs)**: Created `docs/adr/` capturing foundational decisions (Three-Role Zero-Trust Model, Deterministic Event Sessions, Multi-Tenant Invariants, Master Schema Consolidation, Continuous Memory Protocol).
  - **Specialized Subagents**: Defined and registered `fgf-architect`, `fgf-security-auditor`, and `fgf-qa-tester` subagents for autonomous, role-segregated engineering tasks.
  - **Quality Assurance**: Verified 100% quality gate compliance with **220/220 unit tests green** (`npm test`), 0 TypeScript errors (`tsc --noEmit`), and clean production build.

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

- **Legacy Test Session Database Cleanup & Future Weeks Isolation (v110.5)**:
  - **Database Test Artifact Purge**: Removed 16 legacy single-row dummy/test sessions from early development testing for tenant `ALPHA`, reducing total session denominator from an inflated 28 down to the 14 authentic guild battles.
  - **Strict Future-Week RPC Filtering**: Added `ep.week_start <= (date_trunc('week', CURRENT_DATE)::date)` into `public.gm_personal_kpis` SQL function, guaranteeing future scheduled events do not artificially depress attendance rates prior to their battle week.
  - **Scoring Key Type Resolution**: Added `public.gm_event_scoring_key(text, text, date)` SQL overload for native Postgres `date` inputs.

- **Battle Events Participation Hardening & SQL RPC Parity (v110.4)**:
  - **SQL RPC Parity (`gm_personal_kpis`)**: Updated `public.gm_personal_kpis` to use `public.gm_event_scoring_key` and exclude weekly Glory records, guaranteeing 100% mathematical consistency between the Player Portal and the Admin Command Center.
  - **Single Source of Truth Scoring Key Alignment**: Synchronized deterministic scoring keys across `src/core/config/events.ts`, `src/modules/stats/stats.service.ts`, `gm-utils.js`, `public.gm_event_scoring_key`, and `member-portal`.
  - **Comprehensive Vitest Suite**: Added 6-event scoring key and participation test coverage in `tests/stats.test.js` bringing total passing unit tests to **220/220 green**.

- **Shadowfront Historical Participation Rate Calculation & Session Alignment (v110.3)**:
  - **Unstarted Draft Filtering in Member Pool**: Updated `shadowfront.js` historical participation aggregation to ignore unstarted or abandoned pre-start draft sessions from `shadowfront_squads`, ensuring only sessions recorded in `event_participants` count towards player attendance denominators.
  - **Database Migration & Tenant Session Reconciliation**: Reconciled historical pre-start squad rows (`SF1-20260805` / `SF2-20260808`) to their official played session IDs (`SF1-20260807` / `SF2-20260807`) for guild `CLAW`, restoring 100% (2/2) participation rates for active commanders.
  - **Quality Assurance**: Maintained 100% test battery pass rate with **219/219 unit tests green** (`npm test`).

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
