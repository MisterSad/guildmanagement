# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-08-02

### Added
- **Settings tab (super admin only)**: New `tab-settings` panel visible only to `super_admin`, backed by the `gm_cross_guild_ranking` RPC (SECURITY DEFINER, guarded by `is_super_admin()`). Shows every player across all guilds with current power and participation rates for SvS, GvG, Shadowfront, Glory and overall (all event types except Glory, matching the stats module's participation semantics). Sortable columns, search and guild filter; client-side guard renders a "Super admin only" state for other roles.
- **Unit test suite**: coverage for the new ranking module (sorting, filtering, escaping, error/retry, access guard) — 77 tests total.

## [Unreleased] - 2026-08-02

### Changed
- **Semantic Account Roles**: Replaced the legacy numeric roles (`R5`/`R4`) with semantic roles (`super_admin`/`guild_admin`/`member`) across the database (accounts, 12 functions, 5 RLS policies, constraints), the `admin-accounts` edge function and the frontend. The client normalizes legacy stored values for backwards compatibility; existing sessions keep working until token refresh.
- **Rename RAD → GM**: The shared module is now `gm-utils.js` and all globals/keys are prefixed `GM_` (`window.GM`, `localStorage gm_*`). A one-time shim migrates legacy `rad_*` localStorage keys on load. All asset cache busters bumped.
- **CSS utilities**: `.text-success`, `.ph-spin` and the `shake` keyframe were moved from a runtime injection in `app.js` into `components.css`; a dead duplicate `shake` keyframe was removed from `shell.css`.
- **Recidivist alert**: The native `alert()` in `sanctions.js` was replaced with the in-app confirm modal.
- **Manifest**: `lang` set to `en`.

### Removed
- Stray `openapi.json` (98-byte API error response) and dead `admin-banned` inline style / unused variable.

### Added
- **Unit test suite** (Vitest + jsdom): 65 tests covering shared utilities, i18n, statistics engine, role resolution and subscription gating. Run with `npm test`.
- **README.md** documenting the stack, roles, layout, deployment and testing.

## [Unreleased] - 2026-07-19

### Fixed
- **Shadowfront Participation Controls**: Replaced the standard browser checkbox controls for "Late", "Excused", and "Sub Present" with premium, color-coded toggle switch sliders (Orange/Warning for Late, Blue/Info for Excused, Purple/Accent for Sub Present).
- **Shadowfront Live Tracking Stats**: Implemented real-time updates for the "X participated" statistic pill. Toggling any player's participation state now immediately recalculates and updates the stats in the UI without requiring a full tab refresh.

## [Unreleased] - 2026-07-10

### Fixed
- **Edge Functions**: Deployed all outstanding local Edge Function updates to the remote Supabase environment (version alignment for `event-reminders`, `auth-login`, and `admin-accounts`).
- **Event Reminders Deadlock**: Added stale lock handling for GvG Saturday, SvS PvP, and Calamity Befalls notifications inside the `event-reminders` function to prevent deadlocks (stale `sending` locks older than 5 minutes are now cleared automatically).
- **Webhooks**: Tested and verified Discord webhook URLs across all active tenants (`ALPHA`, `OMEGA`, `IMK`, `BABE`) to ensure messages deliver successfully.
- **Custom Templates**: Restored template configuration integration on the remote server for Arms Race, Shadowfront, and other event reminders.
