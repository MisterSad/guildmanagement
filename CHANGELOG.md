# Changelog

## New

- **Dedicated Roster & Power OCR Import (v88)**:
  - **White-Label AI Integration**: Completely removed all references to external AI provider names ("Gemini") across all user-facing UI elements, buttons, titles, dropzone hints, loading spinners, and toast notifications.
  - **Clear Purpose & Scope**: Re-labeled the button in the `Add a member` card to **`Import Members (OCR)`** and updated the modal header to **`Import Members & Power (OCR)`** to explicitly clarify its dedicated function (importing new roster members and updating player power levels).
  - **Future Modular OCR Ready**: Architecture structured to allow adding future dedicated OCR buttons across other modules (e.g. SvS/GvG event scores, stats, sanctions).

- **Gemini 2.5 Flash OCR Bulk Member Import (v87)**:
  - **Scan Button & Modal**: Integrated a dedicated "Scan OCR" button in the `Members` tab (`Add a member` section).
  - **100% English UI & Localization**: Standardized all modal titles, headers, dropzone instructions, review table columns, status tags (`New Player`, `Update`, `Unchanged`), and toast notifications in English.
  - **Interactive Verification Grid**: Drag-and-drop or upload game screenshots (leaderboards, guild roster lists) to preview detected player names, extracted power values, and match status.
  - **Supabase Edge Function**: Created `supabase/functions/ocr-guild-members/index.ts` leveraging Google Gemini API (`gemini-2.5-flash`) with structured JSON schema outputs (`response_mime_type: "application/json"`).
  - **Postgres Bulk Upsert RPC**: Added migration `supabase/migrations/20260813000000_gm_bulk_upsert_members.sql` (`gm_bulk_upsert_members`) with strict RLS authorization and tenant scoping.

- **Ultimate Feature Overhaul (v85)**:
  - **PWA Experience**: App Shortcuts (`manifest.webmanifest`), custom PWA install prompt, network online/offline status monitoring (`src/core/pwa/pwa.ts`), and App Notification Badge API integration (`navigator.setAppBadge`).
  - **Matchup Combat Engine**: Web Worker offloading for SvS/GvG dangerosity ranking calculations (`src/workers/matchup.worker.ts`), side-by-side & combined views, and Discord webhook sharing.
  - **Shadowfront Squad Builder**: Automated roster composition for Squad 1 & Squad 2 (`src/modules/shadowfront/shadowfront.service.ts`) with strict duplicate player exclusion validation.
  - **Player Portal Canvas Charts**: 2D Canvas progression chart component (`src/modules/portal/components/PortalChart.ts`) with high-DPI scaling, double-buffering, and distinct session KPI periods (`1w`, `4w`, `8w`, `all`).
  - **Stats & CSV Exports**: Comprehensive participation stats (`src/modules/stats/stats.service.ts`), historical session tracking, and instant CSV report generation.

## Fixed

- **Provider White-Labeling**: Cleaned up all brand provider mentions from UI strings to maintain a professional white-label SaaS appearance.
- **OCR Modal UI & Click Event Delegation**: Document-level click handler ensures modal opens immediately from any view state.
- **Strict English Localization**: Replaced all remaining French UI strings with clean, standardized English terminology.
- **Type Safety & Build Verification**: All scripts pass with 0 errors (`npm run type-check`) and 200/200 green Vitest tests (`npm test`).
