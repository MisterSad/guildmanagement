# TECHNICAL ARCHITECTURE, SECURITY, PRIVACY & INTELLECTUAL PROPERTY COMPLIANCE WHITEPAPER

**Document Reference**: `FGF-SEC-IP-COMPLIANCE-2026`  
**Classification**: Compliance & Technical Whitepaper  
**Target Audience**: Game Publisher & Developer Technical/Legal Compliance Teams, Platform Security Auditors, Community Operations  
**Revised**: 2026-10-04 (supersedes the August 2026 edition)  
**Language Standard**: English  

> **Sources.** Every statement below was checked against the repository or the production database on the revision date. The personal-data inventory, retention periods and processors follow [ADR-018](adr/ADR-018-gdpr-data-inventory-retention-and-erasure.md) and the published Privacy Policy (`privacy.html`), which `tests/gdpr_compliance.test.js` keeps in step with the code. Where the two ever disagree, the Privacy Policy and the code win.

> **What changed since the August 2026 edition.** That edition claimed the platform held zero personal data, that IP addresses were never persisted, that deleting a profile cascaded through every record, that payments went through Stripe, that the app was an installable PWA with an offline cache, and that screenshots and recordings never touched storage. None of that is true today, and some of it was never true. The app is free with no payment surface ([ADR-015](adr/ADR-015-permanently-free-no-payment-surface.md)); the PWA and Web Push were removed ([ADR-016](adr/ADR-016-pwa-and-web-push-retirement.md)).

---

## 1. Executive Summary & Scope

### 1.1 Purpose of the Platform
The **FGF Guild Management Platform** is an out-of-game web application that helps guild leaders, officers and players of *Foundation Galactic Frontier* organise rosters, schedule guild events, track attendance and scores, and post announcements to their own Discord servers. It is free for every guild, with no paid tier.

The platform runs **entirely outside** the game client and the game servers. It works in the same capacity as a shared spreadsheet or a community Discord bot.

### 1.2 Foundational Principles
1. **No game modification or interference.** The platform does not interact with the game client, hook game processes, read memory, intercept game network traffic, automate gameplay (no bots or macros), or call private publisher APIs. Its only inputs are what officers and players type, and screenshots or screen recordings they choose to upload.
2. **Data minimisation, not "zero personal data".** The platform processes personal data in the GDPR sense: in-game pseudonyms and player IDs, Discord identifiers where a player links Discord, and a sign-in IP address kept for 24 hours. It collects no civil names, email addresses of players, postal addresses, phone numbers or payment data (§2).
3. **No game assets.** The repository and the deployed bundle contain no game textures, models, audio or binaries. The interface uses open-source fonts and icons, self-hosted (§3).
4. **Database-enforced tenant isolation.** Each guild is a tenant isolated by PostgreSQL Row-Level Security, with roles resolved server-side from the `accounts` table (§5).

```
+-----------------------------------------------------------------------------------------+
|                                    PLATFORM BOUNDARIES                                  |
|                                                                                         |
|   +--------------------------+        NO INTERACTION         +----------------------+   |
|   |    Game Client / App     | < - - - - - - - - - - - - - > | FGF Guild Management |   |
|   |  - Proprietary Assets    |      (No Memory Hooks,        |  - Open-Source UI    |   |
|   |  - Game Server APIs      |       No Packet Sniffing,     |  - Supabase / Vercel |   |
|   |  - Player Login/Auth     |       No Botting/Macros)      |  - Postgres RLS      |   |
|   +--------------------------+                               +----------------------+   |
|                                                                                         |
|   Data ingestion:                                                                       |
|   1. Manual input by guild officers and players                                         |
|   2. OCR of screenshots (not stored) and screen recordings (staged, then deleted)       |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Personal Data & Privacy by Design

The operator is established in France, so the GDPR applies, whether or not the service is paid. The full notice is the Privacy Policy (`privacy.html`); its inventory is described there as exhaustive.

### 2.1 Data Inventory

| Data Category | Processed? | Detail |
| :--- | :---: | :--- |
| **In-game identity** | ✅ Yes | Pseudonym, in-game player ID (UID), and pseudonym-change history (kept 12 months) so statistics stay attributable after a rename. These are online identifiers under GDPR Art. 4(1). |
| **Game activity** | ✅ Yes | Attendance, scores, power and rating values, declared absences, squad assignments, sanctions and bans, entered by officers or transcribed from uploads. |
| **Account data** | ✅ Yes | Account identifier, role, guild and server, authentication material stored as a bcrypt hash. A reversibly encrypted password copy from an earlier version remains only for accounts that have not signed in since 2026-10-03 and is deleted at their next sign-in. |
| **Discord identifiers** | ✅ If linked | Discord user ID and username. Discord sign-in requests the `identify` scope only: no email, no server list. Answering a call to arms in a guild's Discord also records the Discord user ID with the answer (kept 7 days). |
| **IP addresses** | ⚠️ 24 hours | The sign-in IP address is stored in `public.login_throttle` to rate-limit sign-in attempts, and purged by the hourly `login-throttle-retention` job, which deletes rows older than 24 hours (migration `20260913120000_perf_and_resilience_fixes.sql`). It is used for no analytics, profiling or geolocation. |
| **Free text** | ✅ Yes | Support tickets, Migration Hub wiki pages and comments. |
| **Technical diagnostics** | ✅ On error | Error reports to Sentry (EU region): error, code path, active guild; credentials and tokens are stripped first. |
| **Player email addresses** | ❌ No | No player email is collected. Each account has a sign-in identity at the authentication provider whose address is synthetic, derived one-way from the account identifier (`gm_<sha256>@no-reply.guildmgmt.app`). |
| **Civil names, postal address, phone, date of birth, ID documents** | ❌ No | Never requested. |
| **Payment data** | ❌ No | The app is free; there is no checkout, subscription or donation path (ADR-015). |
| **Game account credentials** | ❌ No | The platform never asks for game, Apple or Google credentials. |
| **Location / special categories** | ❌ No | No geolocation; no Art. 9 or Art. 10 data. |

### 2.2 Retention
Periods are enforced by scheduled database jobs (`cron.job`), principally `gm_apply_data_retention()` daily at 04:30 UTC (ADR-018):
- sign-in IP addresses and attempt counters: 24 hours, purged hourly;
- sign-in codes, one-time tickets, linking codes, cached OCR text: until expiry, purged hourly;
- Discord call-to-arms answers: 7 days;
- unactioned guild creation requests: 14 days; the Discord handle on a closed request: erased after 90 days;
- administrative audit log and pseudonym history: 12 months;
- rosters, events and statistics: as long as the guild uses the service; an empty guild is removed by a daily job.

### 2.3 Erasure
Erasure is an operator action on request, implemented by `gm_erase_player(guild, uid)` and `gm_erase_account(account_id)` (`SECURITY DEFINER`, not callable by `anon`; account erasure is `super_admin` only). Player erasure **anonymises** rather than deletes: the pseudonym is replaced everywhere by a token derived from a random salt that is never stored, UID and timezone are cleared, absences, pseudonym history and transfer requests are deleted. The roster row survives as an unattributable placeholder so participation records and guild totals stay valid. Ban records are deliberately kept in full, as disclosed in the Privacy Policy (Art. 17(3) GDPR). The earlier claim of "instant cascade deletion" of a profile was false: participation records have no foreign key to accounts.

### 2.4 No Tracking
No cookies, no analytics, no advertising SDKs, no tracking pixels. Browser storage holds only session and display state, which is strictly necessary, so no consent banner is required (ADR-018). The third parties the browser may reach are fixed by the CSP `connect-src` in `vercel.json`: the Supabase project and Sentry ingest.

### 2.5 Processors
Supabase (database, authentication, storage, server functions; database on EU infrastructure), Vercel (hosting), Google Gemini API (OCR and Migration Hub summaries), Discord (sign-in, notifications to a guild's own channels), Sentry (EU, diagnostics), Render (Discord verification worker). Transfers outside the EU rely on the Commission's standard contractual clauses and, where certified, the EU–US Data Privacy Framework.

---

## 3. Intellectual Property, Asset & Trademark Safeguards

### 3.1 No Game Assets
The repository and the deployed bundle contain **no** game textures, hero or ship art, icons taken from the game, 3D models, audio, game code or shaders.

### 3.2 Interface Provenance

| Component | Source | License |
| :--- | :--- | :--- |
| Design tokens | Original token set (`tokens.css`, `theme.css`) on Material Design 3 conventions | Original work |
| Typography | Inter, Plus Jakarta Sans, JetBrains Mono, self-hosted from `fonts/` | SIL Open Font License 1.1 |
| Icons | Phosphor Icons (`@phosphor-icons/web`), a subset font served locally | MIT |
| Charts | Hand-written canvas/SVG rendering (`src/modules/portal/components/PortalChart.ts`) | Original work |
| Game assets | None | — |

The CSP allows fonts, scripts and styles from the app's own origin only (`font-src 'self' data:`, `script-src 'self'`, `style-src 'self'`): there is no external font or script CDN, and no `'unsafe-inline'` — the app carries no inline script or style attribute (since 2026-10-04).

### 3.3 OCR Processing
Officers can upload screenshots or a screen recording of in-game lists so they do not retype them. The OCR runs in the `ocr-guild-members` Edge Function with Google Gemini.

1. **Screenshots** travel in the request body over TLS, are read by Gemini for the duration of the request, and are **not stored**. What is kept is the transcribed text and a SHA-256 fingerprint of the image in `public.ocr_cache`, so an identical resubmission is not sent to Gemini again; the cache expires and is purged.
2. **Screen recordings** are too large for a request body, so the browser first uploads them to the private Supabase Storage bucket `ocr-videos` (64 MiB limit; MP4, MOV or WebM; at most 300 s). Storage RLS lets only administrators of that guild upload, read or delete them (migration `20261001194004_ocr_videos_bucket.sql`). The function reads the video with the caller's own token, sends it to the Gemini File API, and, whether or not the transcription succeeds, deletes the Gemini file and the stored object; staged recordings of that guild older than one hour are removed at its next scan. Google deletes the file at the end of processing or, failing that, within 48 hours.
3. **Review before write.** The transcription is shown to the officer as a diff against the roster (joins, departures, renames, power changes). Nothing is written until the officer confirms, and a roster import is all-or-nothing (`gm_commit_ocr_roster`).

```
[Guild admin device]
   | screenshots (TLS, request body)        | screen recording
   |                                        v
   |                       [Private bucket ocr-videos, guild-scoped RLS]
   v                                        |
[ocr-guild-members Edge Function] <---------+  (read with the caller's token)
   |
   v
[Google Gemini]  screenshots: request only | recordings: File API, deleted after
   |
   v
[Officer reviews the diff] --> [PostgreSQL: pseudonyms and values only]
   then: Gemini file deleted, stored recording deleted
```

### 3.4 Non-Affiliation
The README and the Terms state that this is an unofficial, community-developed project, not affiliated with or endorsed by the publisher of *Foundation Galactic Frontier*, and that all game names and trademarks belong to their owners.

---

## 4. Technical Stack

```
+------------------------------------------------------------------------------------+
|                               TECHNICAL ARCHITECTURE                               |
|                                                                                    |
|  CLIENT (browser, Vercel)                                                          |
|  +------------------------------------------------------------------------------+  |
|  | TypeScript ES modules, no UI framework | Vite 8 | lazy-loaded view chunks      |  |
|  | single state module (app-state.ts) | Web Worker | no PWA, no offline cache     |  |
|  +------------------------------------------------------------------------------+  |
|                                        |  HTTPS, Supabase JWT                      |
|                                        v                                           |
|  EDGE FUNCTIONS (Deno, Supabase) — 14, deployed from CI only                       |
|  +------------------------------------------------------------------------------+  |
|  | auth-login, auth-discord, player-register, guild-request, event-reminders,   |  |
|  | discord-bot-interactions, discord-profile-verification, member-portal,       |  |
|  | admin-accounts, ocr-guild-members, discord-webhook-proxy, guild-data-export, |  |
|  | tickets, migration-summary                                                   |  |
|  +------------------------------------------------------------------------------+  |
|                                        |                                           |
|                                        v                                           |
|  DATABASE (PostgreSQL 17, Supabase)                                                |
|  +------------------------------------------------------------------------------+  |
|  | RLS + FORCE RLS on every public table | SECURITY DEFINER helpers,            |  |
|  | search_path = '' | system_audit_logs | pg_cron retention jobs                |  |
|  +------------------------------------------------------------------------------+  |
+------------------------------------------------------------------------------------+
```

### 4.1 Frontend
- Strict TypeScript compiled by Vite; no UI framework. Each tab view is loaded on first use and the admin side is a separate chunk, so a player never downloads admin code.
- Cross-cutting state lives in one module (`src/core/state/app-state.ts`). The app installs a single global, the frozen `window.GM_E2E` used by the end-to-end tests.
- **No PWA, no push, no offline mode** (ADR-016). The only service worker left is a tombstone that unregisters itself from devices that installed the old app.

### 4.2 Backend & Database
- PostgreSQL 17 on Supabase; Deno Edge Functions on Supabase. 14 functions in `supabase/functions/`, all deployed, none deployed without source (ADR-017). Deploys run from CI after every check is green.
- The migration history is replayed from scratch on an empty PostgreSQL 17 in CI and compared with a fingerprint of the production schema (`scripts/replay-migrations.sh`, `supabase/migrations/README.md`).

### 4.3 Logging & Audit
- Edge Functions log through `EdgeLogger` (structured JSON, correlation IDs, key- and pattern-based redaction of credentials and tokens); the browser reports errors through a rate-limited RPC and Sentry with PII scrubbing.
- Administrative actions write to `public.system_audit_logs` (insert reserved to the service role), kept 12 months.

---

## 5. Security Model

### 5.1 Four Roles
Roles are stored in `public.accounts.role`, restricted by a CHECK constraint to four values, and resolved from `auth.uid()` on every request — never from client-supplied data.

| Role | Scope | Enforcement |
| :--- | :--- | :--- |
| **`super_admin`** | All guilds; account provisioning, audit log, bug-ticket console. | `accounts` row resolved from the JWT. |
| **`server_admin`** | Guilds whose `server_number` matches their own. | RLS helpers compare `guilds.server_number`. |
| **`guild_admin`** | Their own guild only. | `gm_can_read_guild_data(guild)`, `check_user_guild_write_access(guild)`. |
| **`member`** | No direct table access; the Player Portal only. | Every RLS read helper returns false for a member; the portal goes through the `member-portal` Edge Function. |

### 5.2 Row-Level Security
Every public table has RLS **and** FORCE RLS. Policies call `SECURITY DEFINER` helpers with `SET search_path = ''`, and the helpers also refuse a session whose epoch was revoked (password reset, role change, suspension). Grants are given per column where a table holds credential material.

Write access is decided by `public.check_user_guild_write_access(guild)` alone. The former `public.is_subscription_active(p_guild)` was an inert stub (a literal `SELECT true`) that 45 write policies still called; it gated nothing and was removed from them and dropped on 2026-10-04.

### 5.3 Player Portal Isolation
A player signs in with Discord and joins a guild with a join code and their UID, approved by an officer. Direct table queries from a member return nothing. The portal calls `member-portal`, which requires a platform-verified JWT, resolves the account from it (active status and current session epoch required), and derives the player's UID server-side; client-supplied identities are ignored.

### 5.4 Edge Function Protections
- **Authentication**: `verify_jwt` is set per function in `supabase/config.toml`. Seven functions take no Supabase JWT because no session exists yet or the caller is not a user (sign-in, registration, guild requests, the cron-triggered reminder dispatcher, the Discord interactions endpoint verified by Ed25519 signature, the verification worker authenticated by a shared secret); the other seven require one.
- **Input validation**: request bodies are validated with Zod schemas; scores are bounded to 0–9,999,999,999 (`MAX_ALLOWED_EVENT_SCORE`).
- **Rate limits** fail closed (sign-in, portal, OCR video budget).
- **Webhooks**: Discord webhook URLs are stored server-side in `guild_config` and never supplied by the client at send time; `discord-webhook-proxy` accepts only Discord hosts over HTTPS.
- **Secrets** live in Supabase Vault or function environment variables, never in the repository.

---

## 6. Quality Assurance

Every push runs the CI pipeline in `.github/workflows/ci.yml`; deployment jobs run only after all checks pass.

1. `npm run type-check` — zero TypeScript errors.
2. `npm test` — the Vitest suite, with a coverage floor.
3. `npm run build` — production bundle, with an entry-size budget.
4. `npx playwright test` — end-to-end tests against the real built bundle in `dist/`, including axe-core accessibility checks; the only check that catches CSP violations and missing assets.
5. `deno check` and `deno test` on the Edge Functions, against an in-memory Supabase.
6. Migration replay on PostgreSQL 17, schema fingerprint comparison, and SQL tests that exercise RLS, grants and RPCs as each role.

On 2026-10-04 the suite stood at 2,508 Vitest tests and 61 Playwright tests (CHANGELOG, phase M5); the number grows with every change, so read the CI run rather than this line.

---

## 7. Publisher Compliance Matrix

| Compliance Area | Requirement | Platform Implementation | Status |
| :--- | :--- | :--- | :---: |
| **Personal data** | Lawful, minimal processing (GDPR). | Pseudonyms, player IDs, Discord IDs if linked, 24-hour sign-in IPs; published inventory, retention jobs, erasure functions (ADR-018). No player emails, payment or location data. | ✅ Documented |
| **Game modification** | No memory injection, packet tampering or client hooks. | External web application with no interaction with the game client. | ✅ |
| **Automation / bots** | No automated gameplay. | Manual management and voluntary score entry; the Discord bot acts in Discord only. | ✅ |
| **Copyrighted assets** | No proprietary textures, models, audio or binaries. | Open-source fonts (OFL) and icons (MIT), original tokens and charts. | ✅ |
| **Screenshots & recordings** | Not archived or monetised. | Screenshots not stored; recordings staged in a private guild-scoped bucket and deleted after transcription; text and image fingerprints cached briefly. | ✅ |
| **Access security** | Data protection and tenant isolation. | Postgres RLS + FORCE RLS on every table, four roles resolved server-side, session revocation. | ✅ |
| **Network safety** | Safe webhook relaying. | Server-side webhook URLs, Discord hosts only. | ✅ |
| **Game economy** | No currency manipulation or account trading. | No virtual goods, no trading, no game-server writes; no payments of any kind. | ✅ |
| **Legal status** | Clear non-affiliation. | Non-affiliation statement in the README and the Terms. | ✅ |

---

## 8. Attestation & Contact

### 8.1 Developer Attestation
The **FGF Guild Management Platform** is an independent community tool. It supports guild coordination without touching the game client or servers, uses no publisher assets, and processes the limited personal data described in §2 under a published Privacy Policy.

### 8.2 Contact
- **Controller and maintainer**: André Vieira, fgfwiki@gmail.com (the single contact address in the Privacy Policy).
- **Responsible disclosure**: security or compliance concerns sent to that address are handled with priority.

---
*End of Whitepaper — Document Reference: FGF-SEC-IP-COMPLIANCE-2026*
