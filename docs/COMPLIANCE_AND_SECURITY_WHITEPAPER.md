# TECHNICAL ARCHITECTURE, ZERO-TRUST SECURITY, PRIVACY & INTELLECTUAL PROPERTY COMPLIANCE WHITEPAPER

**Document Reference**: `FGF-SEC-IP-COMPLIANCE-2026`  
**Classification**: Official Compliance & Technical Audit Whitepaper  
**Target Audience**: Game Publisher & Developer Technical/Legal Compliance Teams, Platform Security Auditors, Community Operations  
**Date**: August 2026  
**Language Standard**: 100% English  

---

## 1. Executive Summary & Scope

### 1.1 Purpose of the Platform
The **FGF Guild Management Platform** is an out-of-game, web-based software-as-a-service (SaaS) companion tool designed exclusively to assist guild leaders, officers, and community members in organizing internal player rosters, scheduling guild battle events, tracking voluntary aggregate scores, and orchestrating community announcements via Discord webhooks.

The platform operates **100% externally and asynchronously** from the video game client and its operational game servers. It functions in the same capacity as a collaborative spreadsheet or community dashboard, providing guild officers with scheduling tools and statistical rollups.

### 1.2 Fundamental Compliance Principles
To ensure absolute compliance with the Game Publisher’s Terms of Service, End User License Agreement (EULA), Intellectual Property rights, and international data privacy regulations (such as GDPR, CCPA, and COPPA), the platform is built upon four foundational pillars:

1. **Zero Game Modification & Non-Interference**: The platform does not interact with the game client, does not hook into game processes, does not inspect memory, does not sniff or intercept game network packets, does not automate gameplay actions (no botting/macros), and does not interface with proprietary/private publisher APIs.
2. **Zero Personally Identifiable Information (Zero-PII)**: The platform neither collects, stores, nor processes any real-world personal data. It operates strictly using public in-game pseudonyms and arbitrary numerical metrics.
3. **100% Independent Graphic Assets & Intellectual Property Respect**: The platform does not distribute, host, or bundle any copyrighted game textures, proprietary sprites, 3D models, audio tracks, or game binaries. All visual interfaces utilize open-source design systems (Material Design 3.0, Material Symbols Rounded, Google Fonts) and custom procedural WebGL backgrounds.
4. **Enterprise-Grade Zero-Trust Security**: Multi-tenant database isolation enforced at the PostgreSQL 17 engine kernel level via Row-Level Security (RLS), cryptographically signed JWT sessions, cryptographic `SECURITY DEFINER` access controls, SSRF-hardened proxies, and automated CI/CD verification.

```
+-----------------------------------------------------------------------------------------+
|                                    PLATFORM BOUNDARIES                                  |
|                                                                                         |
|   +--------------------------+        ZERO INTERACTION       +----------------------+   |
|   |    Game Client / App     | < - - - - - - - - - - - - - > | FGF Guild Management |   |
|   |  - Proprietary Assets    |      (No Memory Hooks,        |  - Open-Source UI    |   |
|   |  - Game Server APIs      |       No Packet Sniffing,     |  - Supabase Cloud    |   |
|   |  - Player Login/Auth     |       No Botting/Macros)      |  - Zero-Trust RLS    |   |
|   +--------------------------+                               +----------------------+   |
|                                                                                         |
|   Data Ingestion Method:                                                                |
|   1. Manual User Form Input (Voluntary score entry by guild officers/players)           |
|   2. Ephemeral In-Memory OCR of user screenshots (Text extracted, image destroyed)      |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Zero-PII & Privacy-by-Design Governance

The platform was architected from inception under strict **Privacy by Design** (PbD) and **Data Minimization** principles in full compliance with the European General Data Protection Regulation (GDPR - Regulation EU 2016/679), the California Consumer Privacy Act (CCPA), and international privacy frameworks.

### 2.1 Absence of Personal Identifiers
The database contains **zero real-world personal data**. Below is an explicit matrix detailing the strict exclusion of PII:

| Data Category | Collected? | Implementation & Isolation Method |
| :--- | :---: | :--- |
| **Real Names / Surnames** | ❌ **NO** | Only public in-game pseudonyms chosen by players are stored (e.g. `"StarLord99"`). |
| **Email Addresses** | ❌ **NO** | Application tables never store real emails. Member accounts use internal synthetic tokens or pseudonymized login handles. Supabase Auth identity is completely segregated. |
| **Physical Addresses / GPS** | ❌ **NO** | Zero location data or geolocation coordinates are requested or stored. |
| **Phone Numbers** | ❌ **NO** | No SMS or telephony integrations exist. |
| **Financial / Payment Cards** | ❌ **NO** | Payment processing (guild SaaS subscriptions) is fully delegated to Stripe Checkout. Zero card numbers or billing addresses touch our servers. |
| **Biometric / Health Data** | ❌ **NO** | Entirely inapplicable to the platform. |
| **Game Account Passwords** | ❌ **NO** | The platform never requests, accepts, or stores game account credentials, Apple IDs, or Google Play logins. |
| **IP Addresses** | ❌ **NO** | IP addresses are not persisted in business tables. Ephemeral infrastructure routing logs are managed by cloud providers with automated rotation. |
| **Timezone Data** | ⚠️ **Offset Only** | Only a non-identifying numerical hour offset (e.g. `+2` or `-5`) is stored to compute guild battle start countdowns in local guild rosters. |

### 2.2 Data Ingestion & Pseudonymization Architecture
Every stored entity represents a gaming metric rather than a person:
- **`guild_members.pseudo`**: The player's public alias within their guild.
- **`guild_members.uid`**: Public numeric player ID visible on in-game profile leaderboards, used strictly as an immutable database key for roster integrity.
- **`guild_members.overall_power` / `fleet_rating` / `glory_score`**: Public, non-sensitive integer values reflecting in-game statistics.
- **`event_participants`**: Record of attendance (`participated: 1/0`, `score: integer`) during scheduled guild events.

### 2.3 Right to Erasure & Data Minimization
- **Instant Cascade Deletion**: All child records (`event_participants`, `weekly_scores`, `shadowfront_squads`, `sanctions`) maintain strict foreign keys with `ON DELETE CASCADE`. If an officer or player requests removal of a profile, deleting the record instantaneously and irreversibly purges all historical session records from the database.
- **Zero Third-Party Advertising & Tracking**: The frontend application contains **zero advertising SDKs**, zero marketing trackers (e.g. Facebook Pixel, Google Ads, TikTok SDK), and zero cross-site behavioral telemetry.

---

## 3. Intellectual Property (IP), Asset & Trademark Safeguards

A paramount engineering requirement of the FGF Guild Management Platform is absolute respect for the Game Publisher’s intellectual property, copyrighted assets, trademarks, and trade dress.

### 3.1 100% Zero Copyrighted Game Asset Policy
The codebase and deployment bundles are strictly audited to guarantee that **no copyrighted game files or publisher materials are stored, bundled, or served**:
- **0 Game Textures or Bitmaps**: No ship textures, hero portraits, item icons, or UI graphics from the video game exist in the repository or static storage.
- **0 3D Models / Meshes**: No proprietary 3D assets or animation rigs are used.
- **0 Audio / Soundtracks**: No in-game sound effects or background music are hosted.
- **0 Game Code / Shader Binaries**: No proprietary bytecode, decompiled assemblies, or shader programs are utilized.

### 3.2 Open-Source & Custom UI Design System
The visual presentation of the platform relies exclusively on industry-standard, permissively licensed open-source resources:
- **UI Design Framework**: Google Material Design 3.0 (M3) design token hierarchy (`--md-sys-color-*`, `--md-sys-shape-*`, `--md-sys-elevation-*`) styled with Apple-inspired cozy neutral tones (warm graphite, titanium, oyster, and subtle frosted glass).
- **Typography**: Google Fonts *Plus Jakarta Sans* and *Inter* (Licensed under the SIL Open Font License 1.1).
- **Iconography**: Google Material Symbols Rounded (Licensed under the Apache License 2.0).
- **3D Visual Effects**: Procedural, mathematically generated particle systems created in Three.js (MIT License) running in real-time WebGL, containing zero game models or proprietary textures.

```
+-------------------------------------------------------------------------------------+
|                           UI ASSET PROVENANCE AUDIT                                 |
|                                                                                     |
|   Component          Source / Technology              License Type                  |
|   -----------------  -------------------------------  ---------------------------   |
|   Design Tokens      Material Design 3.0 Standard     Open Standard                 |
|   Typography         Plus Jakarta Sans / Inter        SIL Open Font License 1.1     |
|   Icon System        Material Symbols Rounded (M3)    Apache License 2.0            |
|   Login Scene        Procedural WebGL / Three.js      MIT License                   |
|   Color Palette      Custom Titanium/Graphite Tokens  Original Work                 |
|   Game Textures      None (Strictly Excluded)         N/A (Zero Proprietary Data)   |
+-------------------------------------------------------------------------------------+
```

### 3.3 Ephemeral In-Memory OCR Processing Pipeline
To eliminate manual data entry for guild officers managing 100-player rosters, the platform offers an Optical Character Recognition (OCR) feature. The architectural implementation guarantees zero retention of game screenshots:

1. **Client-Side Upload**: A guild officer selects a screenshot of an in-game leaderboard or roster table.
2. **Ephemeral In-Memory Transmission**: The image is transmitted via TLS 1.3 to the hardened `ocr-guild-members` Edge Function.
3. **Pure Textual Extraction**: Google Gemini Vision API parses the image in-memory to extract text numbers (power values) and pseudonyms.
4. **Immediate Bitmap Destruction**: The image data is immediately purged from RAM upon response completion. **The platform does NOT store, archive, cache, or monetize user screenshots on disk or in cloud object storage.**
5. **Defensive Sanitization**: Extracted values are cast into plain integers (`Math.round`) and sanitized strings before insertion into database tables.

```
[Guild Admin Device]
        |
        | 1. Upload Screenshot (TLS 1.3)
        v
[ocr-guild-members Edge Function (Deno)]
        |
        | 2. Ephemeral In-Memory Buffer
        v
[Gemini Vision API] ---> Extracts { pseudo: "StarLord", score: 14500000 }
        |
        | 3. Image Bitmap DESTROYED immediately from memory
        v
[PostgreSQL Database] ---> Stores only: pseudo="StarLord", power=14500000
```

### 3.4 Non-Affiliation & Legal Disclaimers
The platform prominently displays unambiguous legal disclaimers on its authentication screens and documentation:
- *“FGF Guild Management is an independent, community-created companion tool. It is not affiliated with, endorsed by, sponsored by, or specifically approved by the game developer or publisher. All game titles, trademarks, and associated names remain the exclusive intellectual property of their respective owners.”*

---

## 4. Full Technical Stack & Modern Architecture

The FGF Guild Management Platform is built on a modern, serverless, type-safe architecture designed for high availability, zero server maintenance vulnerabilities, and deterministic multi-tenant isolation.

```
+------------------------------------------------------------------------------------+
|                               TECHNICAL ARCHITECTURE                               |
|                                                                                    |
|  CLIENT LAYER (Browser / PWA)                                                      |
|  +------------------------------------------------------------------------------+  |
|  | Modern ES Modules | TypeScript | Vite 8.2 | Pub/Sub Store | Web Workers      |  |
|  | Material Design 3.0 Tokens | Three.js Procedural Ambient Background          |  |
|  +------------------------------------------------------------------------------+  |
|                                        |                                           |
|                     HTTPS / TLS 1.3    | Cryptographic JWT                         |
|                                        v                                           |
|  EDGE FUNCTION LAYER (Deno Runtime / Supabase Cloud)                              |
|  +------------------------------------------------------------------------------+  |
|  |  member-portal        |  ocr-guild-members    |  discord-webhook-proxy        |  |
|  |  admin-accounts       |  auth-login           |  gm-stripe-webhook            |  |
|  +------------------------------------------------------------------------------+  |
|                                        |                                           |
|                                        | Postgres Protocol (RLS Kernel Gate)       |
|                                        v                                           |
|  DATABASE LAYER (PostgreSQL 17 + Row Level Security)                              |
|  +------------------------------------------------------------------------------+  |
|  |  Schema Tables: guilds, accounts, guild_members, event_participants, ...       |  |
|  |  Kernel RLS Policies: check_user_guild_write_access, gm_can_read_guild_data    |  |
|  |  SECURITY DEFINER Access Helpers (search_path = '')                          |  |
|  |  Distributed Structured Audit Logs (system_audit_logs)                        |  |
|  +------------------------------------------------------------------------------+  |
+------------------------------------------------------------------------------------+
```

### 4.1 Frontend Tier
- **Language & Runtime**: Strict TypeScript (`tsc --noEmit`), modern ES Modules, HTML5, CSS3 Custom Properties.
- **Build System**: Vite 8.2 with optimized asset tree-shaking and production minification.
- **State Management**: Reactive Pub/Sub Store (`src/core/store/store.ts`) ensuring unidirectional data flow without bulky runtime frameworks.
- **High-Performance Calculations**: Dedicated Web Workers (`src/workers/matchup.worker.ts`) offloading heavy mathematical simulations (matchup scoring, cross-server ranking) from the UI main thread.
- **Progressive Web App (PWA)**: Installable application with offline shell caching via Service Worker.

### 4.2 Backend & Database Tier
- **Database Engine**: PostgreSQL 17 hosted on Supabase Cloud Infrastructure.
- **Edge Compute Engine**: Deno TypeScript runtime executing serverless Edge Functions globally at low latency.
- **Consolidated Canonical Schema**: Database migrations unified into 4 master DDL definitions under `supabase/migrations/`:
  1. `20260812000001_schema_tables_and_indexes.sql` — Tables, primary keys, and foreign keys.
  2. `20260812000002_security_rls_policies.sql` — Row Level Security policies.
  3. `20260812000003_functions_and_rpcs.sql` — Stored procedures and access control helpers.
  4. `20260812000004_triggers_and_crons.sql` — Scheduled automation and cleanup triggers.

### 4.3 Distributed Observability & Audit Logging
- **Standardized Structured Logging**: All edge functions and client services utilize unified JSON logging (`EdgeLogger` and `ClientLogger`) featuring correlation IDs (`x-correlation-id`), execution latency measurements, and automatic credential sanitization.
- **Persistent Security Audit Trail**: Critical administrative actions (roster updates, member role modifications, account provisioning) generate persistent immutable records in `public.system_audit_logs`.

---

## 5. Zero-Trust Security Model & Defensive Protections

The platform implements a **Zero-Trust Access Control Model** wherein no client, user, or function is trusted by default. Every database transaction and API invocation undergoes strict cryptographic verification.

### 5.1 The Four-Role Access Model
Access control is partitioned into four distinct, non-overlapping roles:

```
+---------------------------------------------------------------------------------------+
|                               FOUR-ROLE ZERO-TRUST MODEL                              |
|                                                                                       |
|   [super_admin]   --> Full cross-tenant read/write & diagnostic system console        |
|   [server_admin]  --> Server-scoped read/write across guilds sharing assigned server |
|   [guild_admin]   --> Single guild tenant read/write (Strict RLS isolation)           |
|   [member]        --> ZERO direct database access. Gated via member-portal Edge Fn    |
+---------------------------------------------------------------------------------------+
```

| Role | Database & REST Scope | Allowed UI Surface | Security Boundary |
| :--- | :--- | :--- | :--- |
| **`super_admin`** | Reads and writes all guild tenants. Master administrative account. | Full Command Center, Cross-Guild Rankings, Server Matchups, Live System Logs (`system_audit_logs`). | Authenticated JWT + `accounts.role = 'super_admin'` verification. |
| **`server_admin`** | Reads and writes only guilds matching their assigned `server_number`. | Command Center with server-scoped Guild Switcher. Roster and event management for assigned server. | Enforced by PostgreSQL RLS checking `guilds.server_number`. |
| **`guild_admin`** | Reads and writes **only their single assigned guild tenant** (e.g. `ALPHA`). | Command Center for their guild: Members, Active Events, Scores, Sanctions, Guild Settings. | Enforced by `gm_can_read_guild_data(guild)` and `check_user_guild_write_access(guild)`. |
| **`member`** | **ZERO direct database access**. Receives empty sets on all tenant tables. | Player Portal only (`portal.js` / `PortalService`). | Communicates exclusively through the `member-portal` Edge Function with cryptographic token resolution. |

### 5.2 PostgreSQL Row-Level Security (RLS) Implementation
Row-Level Security is active on 100% of public database tables. All policies utilize centralized `SECURITY DEFINER` helper functions operating under explicit `SET search_path TO ''` to prevent search-path injection vulnerabilities.

#### Canonical Access Control Helper Functions:
- **`public.gm_can_read_guild_data(p_guild text)`**: Evaluates whether the current authenticated user has permission to read records belonging to tenant `p_guild`. Returns `true` for `super_admin`, matching `server_admin`, or `guild_admin` of that tenant.
- **`public.check_user_guild_write_access(p_guild text)`**: Validates write authorization before any INSERT, UPDATE, or DELETE operation.
- **`public.is_subscription_active(p_guild text)`**: Gates write operations on active SaaS subscription status.

```sql
-- Example Canonical RLS Policy for Guild Members
CREATE POLICY guild_members_select_policy ON public.guild_members
FOR SELECT TO authenticated
USING (public.gm_can_read_guild_data(guild));

CREATE POLICY guild_members_write_policy ON public.guild_members
FOR ALL TO authenticated
USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));
```

### 5.3 Player Portal Isolation Invariant
Members (individual players) are granted **zero direct database permissions**. When a player signs in:
1. Direct queries to `guild_members`, `event_participants`, or `guild_config` return `403 Forbidden` or empty arrays `[]`.
2. The Player Portal issues an authenticated HTTP request to the `member-portal` Edge Function.
3. The Edge Function verifies the caller's JWT against Supabase Auth, resolves the player's identity via `accounts.auth_user_id`, and returns only that player's personal score history and guild schedule.
4. Client-supplied user IDs are strictly ignored; identity is derived exclusively from the cryptographic token.

### 5.4 Edge Function Defensive Protections
Every Edge Function incorporates defensive security controls:
- **JWT Cryptographic Verification**: Mandatory verification via `validateCallerAuth` in `supabase/functions/_shared/auth.ts`. Unauthenticated or unauthorized requests are rejected with `401 Unauthorized` or `403 Forbidden` before business logic executes.
- **Server-Side Request Forgery (SSRF) Protection**: The `discord-webhook-proxy` function strictly validates destination URLs against an explicit regex whitelist (`https://discord.com/api/webhooks/*` or `https://discordapp.com/api/webhooks/*`). Requests to localhost, private IP subnets (RFC 1918), or arbitrary web endpoints are unconditionally blocked.
- **Defensive Score Bounding**: Inbound numerical scores are validated using `parseSafeScore`, capping values between `0` and `500,000,000` to prevent integer overflow, negative score injection, or database corruption.
- **Credential Sanitization**: The structured logger automatically scrubs authentication tokens, passwords, and secret keys before logging output.

---

## 6. Automated Quality Assurance & Verification Protocols

The codebase is governed by a mandatory **Zero-Regression Quality Gate** enforced via automated GitHub Actions CI/CD workflows on every commit.

```
[Developer / Agent Commit]
            |
            v
+------------------------------------------------------------------------------------+
|                       AUTOMATED CI/CD QUALITY GATE PIPELINE                        |
|                                                                                    |
|  Step 1: Static Type Check         Step 2: Automated Unit Tests                    |
|  $ npm run type-check              $ npm test                                      |
|  - TypeScript compiler             - Vitest + jsdom battery                        |
|  - 0 type errors required          - 219 / 219 tests green required                |
|                                                                                    |
|  Step 3: Production Build          Step 4: End-to-End Testing                      |
|  $ npm run build                   $ npm run test:e2e                              |
|  - Vite bundle compilation         - Playwright headless browser                   |
|  - Clean dist/ output required     - Critical user journey validation              |
+------------------------------------------------------------------------------------+
            |
            v
[Automated Deployment to Vercel Production with Hardened CSP]
```

### 6.1 Automated Verification Battery
1. **Static Type Safety**: `npm run type-check` executes `tsc --noEmit` across the entire codebase to guarantee zero type regressions.
2. **Automated Unit & Integration Test Battery**: `npm test` runs 219 automated unit and integration tests under Vitest with jsdom simulation, validating:
   - Deterministic event session ID generation (`buildEventSessionId`).
   - ISO week date math and scoring key synchronizations.
   - Role-based authorization rules and permissions matrices.
   - Pub/Sub state store mutations and Web Worker communications.
   - Defensive score parser bounds and sanitizers.
3. **Production Compilation**: `npm run build` verifies clean asset bundling into `/dist`.

---

## 7. Publisher Compliance Matrix & Summary Checklist

Below is a consolidated summary addressing the specific inquiries and operational requirements of the Game Publisher:

| Compliance Area | Game Publisher Requirement | Platform Implementation & Guarantee | Verification Status |
| :--- | :--- | :--- | :---: |
| **Personal Data (PII)** | No collection of real-world personal data (GDPR / CCPA). | Zero PII stored. In-game pseudonyms and public numerical stats only. Zero email addresses in business schema. | ✅ **FULLY COMPLIANT** |
| **Game Modification** | No memory injection, packet tampering, or client hooks. | 100% external web application. Zero interaction with game client binaries or memory space. | ✅ **FULLY COMPLIANT** |
| **Automation / Bots** | No automated gameplay, macro scripting, or bot actions. | Manual roster management and voluntary score entry only. Zero game automation. | ✅ **FULLY COMPLIANT** |
| **Copyrighted Assets** | No proprietary textures, 3D models, audio, or game binaries. | 100% open-source design system (Material Design 3.0, Material Symbols Rounded, Three.js WebGL). | ✅ **FULLY COMPLIANT** |
| **OCR Screenshot Handling** | Screenshots must not be permanently archived or monetized. | Ephemeral in-memory OCR extraction. Images destroyed immediately upon parsing; only text numbers saved. | ✅ **FULLY COMPLIANT** |
| **Access Security** | Robust data protection and multi-tenant isolation. | PostgreSQL 17 Row-Level Security, 4-Role Zero-Trust model, cryptographically signed JWT sessions. | ✅ **FULLY COMPLIANT** |
| **SSRF & Network Safety** | Safe webhook relaying without external vulnerability risks. | Strict Discord domain whitelist validation. Blocks all internal IP ranges and unauthorized hosts. | ✅ **FULLY COMPLIANT** |
| **Game Economy** | No in-game currency manipulation or account trading. | Out-of-game organizational tool only. No virtual goods, trading mechanisms, or game-server writes. | ✅ **FULLY COMPLIANT** |
| **Legal Status** | Clear statement of non-affiliation and fair use. | Explicit, prominent non-affiliation disclaimers on login portal, documentation, and user interfaces. | ✅ **FULLY COMPLIANT** |

---

## 8. Attestation & Responsible Communication

### 8.1 Developer Attestation
This technical document attests that the **FGF Guild Management Platform** operates strictly as an independent community tool designed to support guild coordination without compromising the game publisher’s intellectual property, game security, player privacy, or server infrastructure.

### 8.2 Publisher Inquiries & Direct Communication Channel
The development team maintains an open, collaborative stance with the Game Publisher and its community operations teams. If the Publisher has specific inquiries, suggestions, or requests regarding compliance or platform operation, direct contact can be established via:

- **Security & Technical Inquiries**: Direct administrative contact within the official platform repository and communication channels.
- **Compliance Lead**: Platform Lead Engineer & Community Coordinator
- **Responsible Disclosure**: Any identified security or compliance concerns are addressed with immediate priority under our zero-regression quality protocol.

---
*End of Whitepaper — Document Reference: FGF-SEC-IP-COMPLIANCE-2026*
