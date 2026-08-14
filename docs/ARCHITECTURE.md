# 🏗️ Architecture & File Structure Guide — FGF Guild Management Tool

This document is the authoritative structural reference for the **FGF Guild Management Tool** codebase. All human developers and AI agents must follow this organization and directory structure for any additions, refactoring, or maintenance.

---

## 📂 COMPLETE PROJECT DIRECTORY TREE

```
guildmanagement/
├── .github/
│   └── workflows/
│       └── ci.yml               # Automated CI Quality Gate (type-check, vitest, build)
├── docs/                        # Project documentation & architecture references
│   ├── ARCHITECTURE.md          # Complete project structure & file index (this file)
│   └── database_squash_plan.md  # Database squash documentation & completion reference
├── supabase/
│   ├── functions/               # Deno / TypeScript Edge Functions
│   │   ├── _shared/             # Shared TS utilities (logger, auth, pagination, stripe, CORS)
│   │   │   ├── auth.ts          # Centralized cryptographic JWT & account role validator
│   │   │   ├── logger.ts        # EdgeLogger structured JSON logger with sanitization
│   │   │   └── pagination.ts    # Paged GoTrue user finder (bypasses 50 cutoff)
│   │   ├── admin-accounts/
│   │   ├── auth-login/
│   │   ├── discord-webhook-proxy/
│   │   ├── event-reminders/
│   │   ├── gm-create-order/
│   │   ├── gm-order-status/
│   │   ├── gm-stripe-webhook/
│   │   ├── member-portal/
│   │   ├── ocr-guild-members/
│   │   └── player-register/
│   ├── migrations/              # 4 Canonical Master DDL migrations (Postgres 17)
│   │   ├── 20260812000001_schema_tables_and_indexes.sql
│   │   ├── 20260812000002_security_rls_policies.sql
│   │   ├── 20260812000003_functions_and_rpcs.sql
│   │   └── 20260812000004_triggers_and_crons.sql
│   ├── migrations_archive/      # Historical 158 incremental migration files preserved
│   └── seeds/
│       └── dev_seed.sql         # Test/dev seed data (isolated from migrations)
├── src/                         # Modernized TypeScript & ES Modules Source
│   ├── assets/                  # Icons, images, webmanifest, favicons
│   ├── components/
│   │   └── ui/                  # Reactive UI components
│   │       ├── BaseComponent.ts # Abstract component base class (lifecycle & disposers)
│   │       └── Toast.ts         # Toast notification manager
│   ├── core/                    # Core infrastructure & single sources of truth
│   │   ├── api/
│   │   │   └── supabase.ts      # Typed Supabase client accessor & HTML escape helper
│   │   ├── auth/
│   │   │   └── roles.ts         # Role normalization & authorization helpers
│   │   ├── config/
│   │   │   └── events.ts        # SSOT: Session IDs, ISO week keys & scoring keys
│   │   ├── i18n/
│   │   │   └── i18n.ts          # Internationalization dictionary & translator
│   │   ├── logger/
│   │   │   └── logger.ts        # ClientLogger structured browser logger
│   │   ├── pwa/
│   │   │   └── pwa.ts           # PWA install prompt & app badge management
│   │   └── store/
│   │       └── store.ts         # Centralized reactive Pub/Sub state store
│   ├── modules/                 # Domain-driven feature modules
│   │   ├── armsrace/
│   │   │   └── armsrace-view.ts
│   │   ├── audit/
│   │   │   ├── audit.service.ts # Super Admin system audit query service
│   │   │   └── audit-view.ts    # Real-time System Logs & Diagnostic UI component
│   │   ├── badges/
│   │   │   └── badges-view.ts
│   │   ├── events/
│   │   │   └── events.service.ts
│   │   ├── glory/
│   │   │   └── glory-view.ts
│   │   ├── history/
│   │   │   └── views/
│   │   │       └── HistoryView.ts
│   │   ├── matchup/
│   │   │   ├── cross-rank.ts    # Cross-Guild Draft Ranking & Mercato view
│   │   │   ├── gvg-matchup.ts   # GvG Guild comparison & dangerosity analytics
│   │   │   └── svs-matchup.ts   # SvS Server comparison & power analytics
│   │   ├── overview/
│   │   │   └── views/
│   │   │       └── OverviewView.ts
│   │   ├── portal/
│   │   │   ├── components/
│   │   │   │   └── PortalChart.ts # 2D Canvas progression chart component
│   │   │   └── portal.service.ts
│   │   ├── sanctions/
│   │   │   └── views/
│   │   │       └── SanctionsView.ts
│   │   ├── shadowfront/
│   │   │   └── shadowfront.service.ts
│   │   ├── stats/
│   │   │   └── stats.service.ts
│   │   └── subscription/
│   │       └── subscription-view.ts
│   ├── types/
│   │   └── database.ts          # TypeScript model & Supabase type definitions
│   ├── workers/
│   │   └── matchup.worker.ts    # Web Worker for offloading heavy calculations
│   └── main.ts                  # Vite entrypoint & window.GM compatibility bridge
├── tests/                       # Vitest unit test suite (219/219 tests green)
├── index.html                   # Application HTML shell
├── package.json                 # Project scripts (dev, build, type-check, test)
├── tsconfig.json                # TypeScript compiler configuration
├── vite.config.ts               # Vite bundler configuration
└── vitest.config.js             # Vitest test runner configuration
```

---

## 📌 CORE ARCHITECTURAL RULES FOR DEVELOPERS & AGENTS

1. **English Language Standard**: All code, documentation, comments, tests, UI, commit messages, and changelogs must strictly be written in English.
2. **Multi-Tenant SaaS Integrity**: Never hardcode guild-specific logic. All features and fixes apply uniformly to all tenant guilds.
3. **Deterministic Session IDs**: Centralized in `src/core/config/events.ts`, `gm_event_session_id`, and `window.GM.buildEventSessionId`.
4. **Three-Role Access Model**: `super_admin` (all guilds), `guild_admin` (own guild only), `member` (Player Portal via edge function only).
5. **Quality Verification**: `npm run type-check`, `npm test` (219/219 green), `npm run build` before every commit.
