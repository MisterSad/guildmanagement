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
│   └── database_squash_plan.md  # Step-by-step SQL migration squash guide
├── supabase/
│   ├── functions/               # Deno / TypeScript Edge Functions
│   │   ├── _shared/             # Shared TS utilities (stripe, CORS, auth)
│   │   ├── admin-accounts/
│   │   ├── auth-login/
│   │   ├── discord-webhook-proxy/
│   │   ├── event-reminders/
│   │   ├── gm-create-order/
│   │   ├── gm-order-status/
│   │   ├── gm-stripe-webhook/
│   │   ├── member-portal/
│   │   └── player-register/
│   ├── migrations/              # DDL schema migrations (Postgres 17)
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
│   │   └── store/
│   │       └── store.ts         # Centralized reactive Pub/Sub state store
│   ├── modules/                 # Domain-driven feature modules
│   │   ├── events/
│   │   │   └── events.service.ts
│   │   ├── history/
│   │   │   └── views/
│   │   │       └── HistoryView.ts
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
│   │   └── stats/
│   │       └── stats.service.ts
│   ├── types/
│   │   └── database.ts          # TypeScript model & Supabase type definitions
│   ├── workers/
│   │   └── matchup.worker.ts    # Web Worker for offloading heavy calculations
│   └── main.ts                  # Vite entrypoint & window.GM compatibility bridge
├── tests/                       # Vitest unit test suite (200/200 tests green)
│   ├── badges.test.js
│   ├── cross-rank.test.js
│   ├── gm-utils.test.js
│   ├── gvg-matchup.test.js
│   ├── i18n.test.js
│   ├── overview.test.js
│   ├── player-register.test.js
│   ├── roles.test.js
│   ├── scoping.test.js
│   ├── security_hardening.test.js
│   ├── setup.js
│   ├── shadowfront.test.js
│   ├── stats.test.js
│   ├── subscription.test.js
│   ├── svs-matchup.test.js
│   └── utils.test.js
├── index.html                   # Application HTML shell
├── package.json                 # Project scripts (dev, build, type-check, test)
├── tsconfig.json                # TypeScript compiler configuration
├── vite.config.ts               # Vite bundler configuration
└── vitest.config.js             # Vitest test runner configuration
```

---

## 📌 CORE ARCHITECTURAL RULES FOR DEVELOPERS & AGENTS

1. **Single Source of Truth (`src/core/config/events.ts`)**:
   - Never duplicate event session ID generation or scoring key logic in client code.
   - Always import from `src/core/config/events.ts`.

2. **State Management (`src/core/store/store.ts`)**:
   - Mutate application state through `appStore.setState()` or dedicated setters.
   - Subscribe components via `appStore.subscribe()`.

3. **Heavy Computation Offloading (`src/workers/matchup.worker.ts`)**:
   - Run sorting, dangerosity scoring, and tier computations through the Web Worker to preserve 60 FPS UI performance.

4. **Component Lifecycle (`src/components/ui/BaseComponent.ts`)**:
   - Extend `BaseComponent` for UI components.
   - Register event listeners using `this.addEventListener()` to guarantee automatic disposal on unmount.

5. **Quality Verification Battery**:
   - Every code modification must pass:
     1. `npm run type-check` (0 errors)
     2. `npm run build` (Vite build output)
     3. `npm test` (200/200 tests green)
