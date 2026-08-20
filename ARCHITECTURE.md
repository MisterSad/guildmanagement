# 🏗️ Architecture Specification & System Design — FGF Guild Management Tool

> **Status**: Authoritative Reference • **Standard**: August 2026 Production Specification  
> **Platform**: Multi-Tenant Serverless SaaS • **Single Source of Truth (SSOT)**

---

## 1. Executive Summary & Technology Topology

**FGF Guild Management Tool** is a serverless, multi-tenant SaaS tactical command and analytics platform built for competitive guilds in *Foundation Galactic Frontier*. It handles real-time combat scoring, roster rosters, participation tracking, automated Discord webhook dispatches, cross-guild draft scouting, AI-powered OCR screenshot parsing, and automated subscription gating.

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CLIENT LAYER (Browser / PWA)                          │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Vite Bundled ES Modules (`/src`) + Hybrid Runtime Shell (`index.html`)             │  │
│  │ ├─ Reactive Pub/Sub State Store (`src/core/store/store.ts`)                       │  │
│  │ ├─ Web Worker Engine (`src/workers/matchup.worker.ts`)                            │  │
│  │ ├─ BaseComponent Lifecycle (`src/components/ui/BaseComponent.ts`)                 │  │
│  │ ├─ Material Design 3.0 + Apple Cozy Neutral Design System Tokens (`tokens.css`)   │  │
│  │ └─ Window GM Compatibility Bridge (`window.GM` -> `src/main.ts`)                  │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │ HTTPS / WSS / JWT
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   EDGE & SECURITY LAYER                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Supabase Deno TypeScript Edge Functions (`supabase/functions/`)                   │  │
│  │ ├─ `member-portal`: Cryptographically resolved player portal backend               │  │
│  │ ├─ `discord-webhook-proxy`: Whitelisted Discord webhook dispatcher (SSRF safe)    │  │
│  │ ├─ `ocr-guild-members`: Gemini multimodal OCR screenshot extraction               │  │
│  │ ├─ `admin-accounts`: Cryptographically verified account provisioner (paged GoTrue)│  │
│  │ ├─ `event-reminders`: Deterministic cron notification dispatcher                  │  │
│  │ └─ `_shared/`: Centralized JWT auth, structured logger, and pagination utilities  │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                                           │ Postgres Wire Protocol / RLS
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   DATABASE LAYER (Postgres 17)                          │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Supabase Postgres 17 (Multi-Tenant Schema with Zero-Trust Row Level Security)       │  │
│  │ ├─ 4 Master Canonical DDL Migrations (`supabase/migrations/`)                     │  │
│  │ ├─ Security Definer Access Helpers with `SET search_path TO ''`                   │  │
│  │ ├─ Deterministic Event Session Generator: `public.gm_event_session_id()`           │  │
│  │ └─ Distributed Audit Ledger: `public.system_audit_logs`                           │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Frontend Architecture & Design System

### 2.1 Reactive Pub/Sub Store Pattern
- **Central Store** (`src/core/store/store.ts`): Maintains global immutable state including active tenant guild, authenticated role info, event sessions, rosters, combat scores, and UI filters.
- **Pub/Sub Subscriptions**: Components subscribe to fine-grained state slices. Listeners must register disposers that execute in `BaseComponent.disconnectedCallback()` to guarantee zero memory leaks.

### 2.2 Web Worker Computation Offloading
- **Worker Engine** (`src/workers/matchup.worker.ts`): Heavy computational workloads (e.g. cross-guild draft mercato simulations, SvS power curve calculations, and GvG matchup dangerosity matrices) are offloaded to dedicated background threads, maintaining a silky 60/120 FPS UI thread.

### 2.3 Component Lifecycle Model
- **BaseComponent** (`src/components/ui/BaseComponent.ts`): Abstract component base class providing:
  - Reactive template rendering (`render()`).
  - Automatic event listener lifecycle binding (`listen()`).
  - Safe unmounting and store subscriber disposal (`dispose()`).

### 2.4 Material Design 3.0 + Apple Cozy Neutral Design System
- **Token Hierarchy**:
  - CSS Custom Properties under `tokens.css`, `components.css`, and `shell.css`.
  - Strict M3 naming: `--md-sys-color-*`, `--md-sys-elevation-*`, `--md-sys-shape-*`.
  - Apple Cozy Neutral Palette: Deep graphite (`#141416`), titanium surfaces (`#1b1b1f` to `#2a2a30`), oyster borders (`rgba(255, 255, 255, 0.08)`), subtle frosted glass (`backdrop-filter: blur(20px)`), and muted mineral accents (emerald, amber, rose, sapphire).
- **Typography & Iconography**:
  - Fonts: *Plus Jakarta Sans* (display / headings), *Inter* (interface / body), *Space Grotesk* (tactical labels), *JetBrains Mono* (scores / IDs).
  - Icons: *Material Symbols Rounded* (variable optical size 20..48, weight 300..700, fill 0..1) alongside *Phosphor Icons Web*.

### 2.5 Hybrid Compatibility Bridge (`window.GM`)
To guarantee seamless backward compatibility and zero UI regressions during modernization, `src/main.ts` exports all core services into the global `window.GM` namespace. Existing DOM event handlers and views interface with modern TypeScript modules without disruption.

---

## 3. The Four-Role Zero-Trust Access Model

Security is enforced at both the database level (Postgres RLS) and the API edge.

```
                    ┌─────────────────────────┐
                    │      GoTrue JWT         │
                    └────────────┬────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   super_admin   │     │  server_admin   │     │   guild_admin   │
├─────────────────┤     ├─────────────────┤     ├─────────────────┤
│ Access: ALL     │     │ Access: ALL     │     │ Access: SINGLE  │
│ tenants globally│     │ tenants on same │     │ tenant guild    │
│ Single master   │     │ server_number   │     │ (active sub)    │
│ (HawkEye)       │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │     member      │
                        ├─────────────────┤
                        │ 0 direct SQL    │
                        │ Player Portal   │
                        │ via Edge Fn     │
                        └─────────────────┘
```

| Role | Database & REST Scope | Edge Function Scope | UI Capabilities |
| :--- | :--- | :--- | :--- |
| `super_admin` | Unrestricted read/write across all 13 tenant guilds. | Full execution on all edge functions. | Complete Admin Command Center, Cross-Guild Draft Ranking, Server Matchups, Live System Logs (`#tab-system-logs`). |
| `server_admin` | Read/write scoped to all guilds matching caller's `server_number`. | Scoped admin operations within server. | Command Center with dynamic Server Guild Switcher dropdown. Manages rosters, scores, sanctions, and webhooks for all server guilds. |
| `guild_admin` | Read/write strictly scoped to caller's single assigned `guild` tenant. | Scoped to own guild tenant. | Command Center for own guild: Members, Active Events, Scores, Sanctions, Guild Settings. Gated on active subscription. |
| `member` | **ZERO direct database access** (denied on all tables via RLS). | Queries `member-portal` edge function exclusively. | **Player Portal only** (`portal.js` / `PortalService`). Identity resolved cryptographically from `auth_user_id`. |

---

## 4. Deterministic Event Session Architecture

Every event session carries a deterministic, chronologically sortable `session_id` calculated from the event type and battle date.

### 4.1 Tripartite Synchronization Invariant
The following three definitions **MUST** remain in exact mathematical synchronization:
1. **TypeScript SSOT**: `src/core/config/events.ts` (`buildEventSessionId`)
2. **Postgres SSOT**: `public.gm_event_session_id(text, date)`
3. **Window Bridge**: `window.GM.buildEventSessionId(eventName, date)`

### 4.2 Standard Session ID Formats
| Event Type | Session ID Scheme | Calculation Basis |
| :--- | :--- | :--- |
| **SvS (Server vs Server)** | `SVS-YYYY-Www` | ISO week of the battle date |
| **GvG (Guild vs Guild)** | `GVG-YYYY-Www` | ISO week of the battle date |
| **Glory Battle** | `GLORY-YYYY-Www` | Weekly ISO key based on `week_start` |
| **Arms Race Stage A / B** | `ARA-YYYYMMDD` / `ARB-YYYYMMDD` | Specific daily stage date |
| **Defend Trade Route (DTR)** | `DTR-YYYYMMDD` | Specific event date |
| **Shadowfront Squad 1 / 2** | `SF-YYYYMMDD` | Specific event date |

---

## 5. Complete Annotated Directory Tree

```
/ (Root Directory)
├── .agents/                                # Autonomous AI agent definitions & domain skills
│   └── skills/                             # Reusable agent skills
│       ├── fgf-changelog-discord/          # Changelog generation rules & Discord digest formatter
│       ├── fgf-memory-keeper/              # Long-term memory, ADR tracking & anti-regression
│       ├── fgf-quality-gate/               # 3-step test, type-check & build verification runner
│       ├── fgf-rls-security/               # RLS security validator & zero-trust enforcement
│       └── fgf-saas-architect/             # SaaS multi-tenant architectural standards
├── .github/                                # GitHub Actions CI/CD workflows
│   └── workflows/
│       └── ci.yml                          # Quality gate CI (type-check, vitest battery, vite build)
├── docs/                                   # Architectural records, ADRs & compliance documents
│   ├── adr/                                # Architectural Decision Records
│   │   ├── ADR-001-three-role-zero-trust-access-model.md
│   │   ├── ADR-002-deterministic-event-session-ids.md
│   │   ├── ADR-003-multi-tenant-saas-invariants.md
│   │   ├── ADR-004-consolidated-database-schema-and-security-definer.md
│   │   ├── ADR-005-memory-and-regression-prevention-protocol.md
│   │   ├── ADR-006-four-role-access-model-with-server-admin.md
│   │   └── README.md                       # Index of all architectural decisions
│   ├── ARCHITECTURE.md                     # Synced copy of master architecture document
│   ├── audit_report_2026-08-14.md          # Historical 360° technical audit report
│   ├── COMPLIANCE_AND_SECURITY_WHITEPAPER.md # Technical & IP compliance whitepaper source
│   ├── compliance-whitepaper-template.html # Print template for compliance PDF generation
│   ├── database_squash_plan.md             # Canonical database consolidation roadmap
│   └── FGF_Guild_Management_Technical_Security_IP_Compliance_Whitepaper.pdf # Compiled compliance PDF
├── scripts/                                # Maintenance & build utility scripts
│   ├── build.js                            # Production build script (Vite + asset copy to dist/)
│   └── generate-compliance-pdf.js          # Playwright Chromium PDF generator
├── src/                                    # Modern TypeScript Source Code (ES2022)
│   ├── components/                         # Reusable UI Web Components
│   │   └── ui/
│   │       ├── BaseComponent.ts            # Abstract base component with state & lifecycle binding
│   │       └── Toast.ts                    # M3 Toast notification system
│   ├── core/                               # Core foundational infrastructure
│   │   ├── api/
│   │   │   └── supabase.ts                 # Supabase client factory & sanitized queries
│   │   ├── auth/
│   │   │   └── roles.ts                    # Normalized role evaluation & permission checking
│   │   ├── config/
│   │   │   ├── events.ts                   # Event configuration & deterministic session IDs SSOT
│   │   │   └── gvg-tasks.ts                # GvG combat daily task scoring matrices
│   │   ├── i18n/
│   │   │   └── i18n.ts                     # Internationalization dictionaries & reactive switcher
│   │   ├── logger/
│   │   │   └── logger.ts                   # Structured ClientLogger with latency & audit ledger
│   │   ├── pwa/
│   │   │   └── pwa.ts                      # Service Worker registration & PWA install prompts
│   │   └── store/
│   │       └── store.ts                    # Central reactive Pub/Sub state store
│   ├── modules/                            # Domain-driven feature modules
│   │   ├── armsrace/                       # Arms Race daily scoring & leaderboard views
│   │   ├── audit/                          # System audit logs & live diagnostic console
│   │   ├── badges/                         # Member achievement & veteran badge computation
│   │   ├── events/                         # Active event management & session coordinator
│   │   ├── glory/                          # Weekly Glory Battle combat scoring
│   │   ├── history/                        # Chronological session archive & score history
│   │   ├── matchup/                        # SvS, GvG analytics & Cross-Guild draft ranking
│   │   ├── overview/                       # Guild Command Center overview & summary KPI cards
│   │   ├── portal/                         # Player Portal service & progression chart
│   │   ├── sanctions/                      # Member sanctions & strike penalty tracking
│   │   ├── shadowfront/                    # Shadowfront squad combat service
│   │   ├── stats/                          # Historical KPI statistics & member participation
│   │   └── subscription/                   # SaaS subscription status & billing view
│   ├── types/                              # Strict TypeScript type definitions
│   │   └── database.ts                     # Supabase database schema & row definitions
│   ├── workers/                            # Web Workers for heavy background calculations
│   │   └── matchup.worker.ts               # Background combat matchup simulation worker
│   └── main.ts                             # Modern TypeScript entrypoint & window.GM bridge
├── supabase/                               # Supabase Database & Edge Functions
│   ├── functions/                          # Deno TypeScript Edge Functions
│   │   ├── _shared/                        # Shared Edge utilities (auth.ts, logger.ts, pagination.ts)
│   │   ├── admin-accounts/                 # Super/Server Admin user account provisioner
│   │   ├── auth-login/                     # Hardened authentication & JWT claim issuance
│   │   ├── discord-webhook-proxy/          # Whitelisted Discord webhook proxy dispatcher
│   │   ├── event-reminders/                # Automated battle event Discord reminder cron
│   │   ├── gm-create-order/                # Stripe checkout session generator
│   │   ├── gm-order-status/                # Stripe order status resolver
│   │   ├── gm-stripe-webhook/              # Stripe subscription lifecycle webhook listener
│   │   ├── member-portal/                  # Player Portal backend (cryptographic auth resolution)
│   │   ├── ocr-guild-members/              # Gemini multimodal OCR roster score extractor
│   │   └── player-register/                # Self-service player registration backend
│   ├── migrations/                         # 4 Master Canonical DDL files + consolidated updates
│   │   ├── 20260812000001_schema_tables_and_indexes.sql
│   │   ├── 20260812000002_security_rls_policies.sql
│   │   ├── 20260812000003_functions_and_rpcs.sql
│   │   └── 20260812000004_triggers_and_crons.sql
│   ├── migrations_archive/                 # Historical archive of 158 superseded migrations
│   └── seeds/                              # Isolated test & development seed data
│       └── dev_seed.sql
├── tests/                                  # Vitest unit & integration test suite (294 tests)
├── .gitignore                              # Git exclusion rules (node_modules, dist, test-results)
├── AGENTS.md                               # Authoritative engineering guidelines for AI agents
├── ARCHITECTURE.md                         # Master architecture specification (this document)
├── CHANGELOG.md                            # Cumulative technical release history
├── DISCORD_CHANGELOG.md                    # Daily user-centric Discord announcement digest
├── index.html                              # Main application HTML shell & PWA container
├── package.json                            # Package scripts & dependencies
├── terms.html                              # Dedicated full-page Terms & Conditions
├── tokens.css                              # Design system tokens (M3 + Apple Cozy Neutral)
├── tsconfig.json                           # TypeScript compiler configuration
├── vercel.json                             # Vercel deployment configuration & CSP headers
├── vite.config.ts                          # Vite bundler configuration
└── vitest.config.js                        # Vitest test runner configuration
```

---

## 6. Database & RLS Access Control Protocol

### 6.1 Centralized Access Helpers
Every RLS policy and RPC uses `SECURITY DEFINER` functions with `SET search_path TO ''` to eliminate search-path injection vulnerabilities:
- `public.gm_can_read_guild_data(p_guild text)`: SELECT filter for tenant tables.
- `public.gm_can_read_guilds()`: SELECT filter for `guilds`.
- `public.gm_can_read_account(p_account_id text)`: SELECT filter for `accounts`.
- `public.check_user_guild_write_access(p_guild text)`: INSERT/UPDATE/DELETE authorization check.
- `public.is_subscription_active(p_guild text)`: SaaS subscription validity check.
- `public.gm_can_admin_see_absences(p_guild text)`: Admin absence viewing filter.

### 6.2 Principle of Least Privilege
- Internal RPCs have `EXECUTE` privileges explicitly revoked from `public` and `anon`, granted exclusively to `authenticated`.
- Direct table writes are blocked unless the caller satisfies both valid guild write access and active subscription status.

---

## 7. Distributed Observability & Structured Logging

### 7.1 ClientLogger (`src/core/logger/logger.ts`)
- Outputs structured JSON log entries to browser console.
- Injects `correlation_id`, `session_id`, `caller_role`, and execution latency.
- Automatically redacts sensitive fields (`password`, `token`, `secret`, `access_token`, `authorization`).
- Flushes high-severity error events to `public.system_audit_logs`.

### 7.2 EdgeLogger (`supabase/functions/_shared/logger.ts`)
- Standardized logging format across all 11 Deno Edge Functions.
- Logs HTTP status, duration in milliseconds, authenticated account ID, and tenant scope.

---

## 8. Quality Verification Gate & Release Standards

Before any code modification is merged into `main` or deployed to production, the full quality gate battery must pass with zero errors:

```bash
# 1. Static TypeScript Verification
npm run type-check

# 2. Automated Unit & Regression Battery (294/294 tests green)
npm test

# 3. Production Vite Bundle Build
npm run build
```
