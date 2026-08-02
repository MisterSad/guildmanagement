# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-08-02

### Added
- **Self-service subscriptions (Revolut)**: new Subscription tab visible to `guild_admin` and `super_admin` (per tenant), with five plans — 1 Month €6.99, 3 Months €16.99, 6 Months €27.99, 12 Months €47.99, Lifetime €89.00. Checkout runs through the Revolut Merchant Web SDK embedded checkout (card, Revolut Pay, Apple Pay, Google Pay), orders are created server-side by the `gm-create-order` edge function and recorded in a new `gm_payments` table. `gm-revolut-webhook` (HMAC-verified, public) applies completed payments atomically and idempotently (`gm_apply_subscription_payment` RPC): time plans extend the guild's `subscription_end` from `max(now, current end)` so renewals stack; the Lifetime plan switches the guild to a new `Lifetime` subscription type that never expires. `gm-order-status` lets the UI confirm payments immediately after checkout while the webhook stays the source of truth. The super admin's manual grant UI (Unlimited/Premium + date) is unchanged and now also supports the `Lifetime` type.
- **Unit tests**: coverage for the subscription module (plans, status rendering, widget wiring, payment polling, error states) — 91 tests total.
- **Shadowfront unit tests**: smoke coverage for the new stepper, availability entry, composition pool, tracking bulk actions and Discord sharing — 96 tests total.
- **Shadowfront — share composition on Discord**: new "Share on Discord" button in the Squad Composition step. Sends a single embed with Squad One and Squad Two (participants with 👑 for commanders, substitutes, live counters) to the configured Shadowfront webhook (`webhook_shadowfront`, falling back to `discord_webhook_url`), via a new shared `GM.sendDiscordWebhook()` helper reused by the existing event notifications.
- **Shadowfront — UI/UX rework**: the event now follows the in-game flow in three guided steps. (1) **Availability**: admins enter the players who declared availability in-game, per squad — searchable member list with multi-select and bulk "Add to Squad One/Two" actions; two parallel pools (Squad One/Squad Two available) with one-click removal. The legacy "Both/None" declaration model is gone. (2) **Squad Composition**: only declared players appear in the pool, sorted by participation rate by default (toggle Rate/Power), with category filters, per-squad summary chips (pool, participants /20, substitutes /10, average participation rate), commander stars (max 3) and the Discord share button. Assigning a player no longer auto-starts the event: the session is created inactive and only "Start" activates it, so rosters can be composed in advance; ending a squad closes its session so the next start creates a fresh one. (3) **Participation Tracking**: bulk "All present / All absent" actions, a subtle "Saved" flash on every autosave, and the vestigial pending/approve flow was removed. The Running Tab (whose history was never actually loaded) and its dead code were deleted.

## [Unreleased] - 2026-08-02

### Added
- **Settings tab (super admin only)**: New `tab-settings` panel visible only to `super_admin`, backed by the `gm_cross_guild_ranking` RPC (SECURITY DEFINER, guarded by `is_super_admin()`). Shows every player across all guilds with current power and participation rates for SvS, GvG, Shadowfront, Glory and overall (all event types except Glory, matching the stats module's participation semantics). Sortable columns, search and guild filter; client-side guard renders a "Super admin only" state for other roles.
- **Unit test suite**: coverage for the new ranking module (sorting, filtering, escaping, error/retry, access guard) — 77 tests total.

### Fixed
- **Cross-guild ranking RPC**: the `gm_cross_guild_ranking` function failed at runtime with `column reference "guild" is ambiguous` — the `RETURNS TABLE` OUT parameters (`pseudo`, `guild`, …) act as PL/pgSQL variables and collided with unqualified column references in the query body. All column references are now qualified with table aliases; the session totals (`count(*)`) are cast to `integer` to match the declared result type. Validated on live data (653 players) and redeployed.

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
