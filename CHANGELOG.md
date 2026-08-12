# Changelog

## New

- **Gemini 2.5 Flash OCR Bulk Member Import (v86)**:
  - **Scan Button & Modal**: Integrated a dedicated "Scan OCR Gemini" button in the `Members` tab (`id="admin-members"` in `index.html`).
  - **Interactive Verification Grid**: Drag-and-drop or upload game screenshots (leaderboards, guild roster lists) to preview detected player names, extracted power values, and match status (`Nouveau`, `Mise à jour`, `Inchangé`).
  - **Supabase Edge Function**: Created `supabase/functions/ocr-guild-members/index.ts` leveraging Google Gemini API (`gemini-2.5-flash`) with structured JSON schema outputs (`response_mime_type: "application/json"`).
  - **Postgres Bulk Upsert RPC**: Added migration `supabase/migrations/20260813000000_gm_bulk_upsert_members.sql` (`gm_bulk_upsert_members`) with strict RLS authorization and tenant scoping.
  - **Fallback Integration**: Automatic fallback to direct Gemini API with key `GEMINI_API_KEY` stored in `.env` and `supabase/.env`.

- **Ultimate Feature Overhaul (v85)**:
  - **PWA Experience**: App Shortcuts (`manifest.webmanifest`), custom PWA install prompt, network online/offline status monitoring (`src/core/pwa/pwa.ts`), and App Notification Badge API integration (`navigator.setAppBadge`).
  - **Matchup Combat Engine**: Web Worker offloading for SvS/GvG dangerosity ranking calculations (`src/workers/matchup.worker.ts`), side-by-side & combined views, and Discord webhook sharing.
  - **Shadowfront Squad Builder**: Automated roster composition for Squad 1 & Squad 2 (`src/modules/shadowfront/shadowfront.service.ts`) with strict duplicate player exclusion validation.
  - **Player Portal Canvas Charts**: 2D Canvas progression chart component (`src/modules/portal/components/PortalChart.ts`) with high-DPI scaling, double-buffering, and distinct session KPI periods (`1w`, `4w`, `8w`, `all`).
  - **Stats & CSV Exports**: Comprehensive participation stats (`src/modules/stats/stats.service.ts`), historical session tracking, and instant CSV report generation.
  - **Sanctions & Attendance**: Modular sanctions manager (`src/modules/sanctions/views/SanctionsView.ts`) with strike tracking and penalty calculations.
  - **Command Center Overview**: Modular overview dashboard (`src/modules/overview/views/OverviewView.ts`) with live guild metrics and active event counters.
  - **Payments & Subscriptions Security Audit**: Verified 12-Month plan integration (365 days / €59.99), database RLS write-gating (`is_subscription_active`), and Stripe HMAC-SHA256 signature verification.
  - **Phase 4 CI/CD Pipeline & SQL Seed Isolation**: Created automated GitHub Actions Continuous Integration workflow (`.github/workflows/ci.yml`) running type checking (`npm run type-check`), Vitest test suite (`npm test`), and production Vite bundling (`npm run build`).

## Fixed

- **OCR Roster Sync**: Seamless bulk updates of member overall power levels without manual line-by-line entry.
- **Seamless PWA Offline Experience**: Gracefully notifies users when network connection drops without breaking active views or displaying blank screens.
- **Canvas Rendering Stability**: Explicit double-buffering and `clearRect` in `PortalChart.ts` prevents canvas overlay artifacts.
- **Shadowfront Roster Validation**: Prevents duplicate player assignments across Squad 1 and Squad 2.
- **Automated Quality Gate**: GitHub Actions pipeline prevents broken builds or failing unit tests from reaching production.
- **Type Safety & Build Verification**: All scripts pass with 0 errors (`npm run type-check`) and 200/200 green Vitest tests (`npm test`).
