# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-08-07

### Changed
- **Subscription plans updated**: new pricing without the Lifetime plan — 1 Month €7.99, 3 Months €19.99 (save ~16%), 6 Months €34.99 (save ~27%), 12 Months €59.99 (save ~37%, best value). Checkout and application logic unchanged; existing Lifetime guilds keep their status.
- **Login page is now static**: the Three.js 3D space battle background and the animated orbs were removed — the page loads much faster and is lighter on battery. The login keeps the dark DA styling with a static gradient-border card. A new **Discord button** below the login form links to the community server so guild leaders can request a tenant and admin access for their guild.

### Added
- **Player Portal "My Info" tab**: the former "Account" tab was renamed and now groups everything a player manages about themselves: combat power, **weekly Glory** (new, self-service via `update-glory` / `gm_upsert_player_glory`), timezone and guild transfer requests. The redundant logout tile was removed (the sidebar already has a logout button).
- **Personal KPI dashboard in "My Progress"**: a new `get-personal-kpis` / `gm_personal_kpis` server-side RPC computes advanced per-player metrics and their position within the guild: power (current, guild max, rank, percentile, % of guild max), Glory (current week, best ever, guild rank), attendance (rate, events, delta vs guild average, per-event-type breakdown) and tenure. Four KPI cards render above the existing stats.
- **More badge tiers**: the badge catalog now has 45 badges — a **Glory** track going up to 50M weekly Glory (1K to 50M in ten tiers), Seniority with fine intermediate steps capped at 2 years (1/2/3/6/9 months, 1/18/24 months), Power in fine steps capped at 300M (10M to 300M), and Participation from 10 to 1500 events attended. Zero or empty Glory scores never count toward the Glory badges, and **a player's first-ever Glory declaration is also excluded**: since the app just launched, the first declaration would instantly unlock every Glory badge (the player enters their real score). Glory badges only start tracking from the second declaration onwards.

### Fixed
- **New members are now enrolled into active events automatically**: previously, adding a member after events were scheduled (Arms Race, DTR, SvS, GvG) silently left them out of the event member lists. The root cause was a client-side upsert that Postgres rejected against the partial unique index on `event_participants` (42P10), so the error was swallowed and the member was never added. A new `gm_add_member_to_active_events` RPC now inserts the member into every active session of their guild in one atomic, idempotent call (Shadowfront is excluded by design, its participants come from squad assignments). The client helpers were reduced to UI-only memory sync.
- **Shadowfront participant sync fixed**: the same broken upsert pattern in `shadowfront.js` was replaced with a plain insert (rows are already filtered against existing ones).

### Added
- **Duplicate-UID add-member dialog**: when an admin tries to add a player whose UID already exists in another guild, a dialog now shows exactly where the player lives (pseudo, UID, current guild, server number, rank, power and name-change history) and offers a **Request Transfer** action. The admin confirms with an acknowledgement that the process cannot be undone without reporting an issue, then a pending transfer request is created for the target guild.
- **Admin transfer requests**: new `gm_admin_request_transfer` RPC lets a `guild_admin` request moving an existing player into their own guild (or a `super_admin` into any guild). Same-server validation, duplicate-UID and subscription gates. The request appears in the target guild's Pending Transfers list.
- **Transfer direction in the admin panel**: Pending Transfers now shows both directions — `IN` (player joining this guild, approve/reject buttons) and `OUT` (player leaving this guild, waiting on the other guild's approval), with a "From → To" column.
- **RLS hardening on `guild_transfers`**: the legacy inline-`accounts` policies (which all `authenticated` users could hit, letting a member whose guild matched read transfers and even resolve them) were replaced with helper-based admin-only policies (`gm_can_read_guild_data` / `check_user_guild_write_access`).
- **`resolve_guild_transfer` hardened**: approval now moves only the source-guild row (legacy duplicate UIDs can no longer drag unrelated guilds), rejects stale approvals (`member_no_longer_in_source`), re-checks target duplicates, enforces the subscription gate and uses `search_path ''`.

### Changed
- **Payments moved to a hosted checkout session**: self-service subscriptions now use a hosted checkout provider instead of the embedded widget. The admin clicks a plan, is redirected to the provider's checkout page (card, Apple Pay, Google Pay, PayPal) and returns to the app where the subscription is confirmed by polling. Order creation (`gm-create-order`), status (`gm-order-status`) and the signature-verified webhook (`gm-stripe-webhook`) remain the same security shape: the webhook is the source of truth and only applies settled payments. The subscription application RPC is unchanged (atomic, idempotent, stacking). Unit tests updated for the redirect flow.

## [Unreleased] - 2026-08-06

### Added
- **Gamification badges in the Player Portal**: a new "Badges" tab turns player progression into achievements. The `badges.js` module (pure, unit-tested engine) computes a catalog of 19 badges across four tracks from the player's own data: **Ranks** (cumulative R1-R5), **Seniority** (30 days to 2 years in the guild), **Power** (10M to 1B combat power) and **Participation** (10 to 100 events attended). Earned badges render in full color with a glow; locked badges are greyed out and show the objective to reach (description), a progress bar and a current/target metric (e.g. "R3 / R5", "75M / 100M"). Data comes from a new `get-badges` action in the `member-portal` edge function, so the player never reads tables directly. 18 new unit tests (135 total across 10 files).

## [Unreleased] - 2026-08-02

### Added
- **Player self-registration**: players can create their own account from the login screen ("Create a player account") with an identifier, password, in-game UID and the guild join code. The new `player-register` edge function validates the join code (stored as a SHA-256 hash in `guild_config`, never in plaintext), checks the UID belongs to the guild roster and is not already claimed, then creates a `pending` account with a PGP-encrypted password. Accounts are role `member` and cannot sign in until approved.
- **Guild join code**: admins generate a per-guild join code from the Accounts tab (`gm_set_join_code` RPC, hash-only storage, regenerable). `gm-utils.js` exposes `registerPlayer` and `generateJoinCode`.
- **Pending registrations review**: admins approve or reject pending player accounts from the Accounts tab. Approval provisions the shadow GoTrue user at that moment (`gm_approve_player_account` RPC + admin-accounts `approve-registration` action); rejection deletes the request (`gm_reject_player_account`). `gm_admin_list` now returns `uid` and `status`.
- **Pending-aware login**: `gm_check_login` returns the account status; `auth-login` answers `pending_approval` instead of a generic failure for unapproved accounts.
- **Unit tests**: `tests/player-register.test.js` (invocation, trimming, error propagation, join code format) — 104 tests total across 9 files.

## [Unreleased] - 2026-08-02

### Added
- **Self-service subscriptions**: new Subscription tab visible to `guild_admin` and `super_admin` (per tenant), with five plans — 1 Month €6.99, 3 Months €16.99, 6 Months €27.99, 12 Months €47.99, Lifetime €89.00. Checkout runs through a hosted payment provider checkout (card, Apple Pay, Google Pay, PayPal), orders are created server-side by the `gm-create-order` edge function and recorded in a new `gm_payments` table. `gm-stripe-webhook` (signature-verified, public) applies settled payments atomically and idempotently (`gm_apply_subscription_payment` RPC): time plans extend the guild's `subscription_end` from `max(now, current end)` so renewals stack; the Lifetime plan switches the guild to a new `Lifetime` subscription type that never expires. `gm-order-status` lets the UI confirm payments immediately after checkout while the webhook stays the source of truth. The super admin's manual grant UI (Unlimited/Premium + date) is unchanged and now also supports the `Lifetime` type.
- **Unit tests**: coverage for the subscription module (plans, status rendering, checkout flow, payment polling, error states) — 91 tests total.
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
