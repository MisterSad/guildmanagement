# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] - 2026-08-08

### Fixed
- **History page came back empty after the event-id rework**: the `gm_list_event_sessions` RPC selected `ep.session_id` while its `GROUP BY` used `coalesce(ep.session_id, ep.week_start::text)`, which PostgreSQL rejects ("column must appear in the GROUP BY"). Every History load failed silently and showed no events. The RPC now selects the coalesce expression itself (aliased `session_id`), restoring the History page for every tenant.
- **History dates with a bare `+00` offset parsed as invalid**: Postgres serializes `timestamptz` as `2026-08-12T19:30:00+00`, which `new Date()` rejects. The history date helpers now normalize the offset, so battle dates render reliably.

## [Unreleased] - 2026-08-08

### Changed
- **Human-readable event session ids across every tenant**: each event session now carries a deterministic, chronologically-sortable id built from its type and battle date: `SVS-2026-W32` / `GVG-2026-W32` / `GLORY-2026-W32` (ISO week) and `ARA-20260809` / `ARB-20260809` / `DTR-20260809` / `SF1-20260802` / `SF2-20260805` (YYYYMMDD). Starting an event that already has a session for the same date reuses it, so duplicate "ghost" sessions can no longer be created. The SQL helper `gm_event_session_id` and the frontend `window.GM.buildEventSessionId` stay in sync; all historical sessions were migrated (existing data fused where duplicates existed, no scores or participation lost) and `Glory` is now keyed by `GLORY-YYYY-Www`.
- **Participation rates count distinct sessions**: `gm_personal_kpis` and the attendance dashboard previously counted every participant row, so a player listed in two sessions of the same event was counted twice and guild totals could read "5/7" for 5 real events. Rates now use `count(distinct session_id)`.

### Added
- **Login page footer**: the sign-in screen now shows "Developed by HawkEye #1058" centered at the bottom, under the Discord button.
- **Portal access badge on member tiles**: the member list now shows a small green "Portal" chip next to any member whose in-game UID matches a validated player account (role `member`, status `active`). It makes it obvious at a glance who has registered and been approved on the Player Portal. Pending registrations and admin accounts do not get the badge.
- **DEMO tenant for public screenshots and app demos**: a fully fictional guild `DEMO` (server `#0000`, join code `FGF-DEMO-0000`) seeded with 200 fictional players and 4 weeks (2026-07-13 → 2026-08-03) of Glory, DTR, Arms Race, SvS, GvG and Shadowfront events with realistic scores, participation and attendance trends. Re-seed anytime with `python3 scripts/generate_demo_data.py | supabase db query --linked`. Visible to super admins through the guild selector (server number shown as `#0000`).

### Fixed
- **History grouped all Glory weeks into a single row**: `gm_list_event_sessions` grouped by `(event, session_id)` and Glory has no session, so multiple weeks collapsed into one History entry. The group key is now `coalesce(session_id, week_start)`: sessioned events keep one row per session, session-less events (Glory) get one row per week. Fresh OID applied to drop any cached PostgREST plan.
- **Ending a Shadowfront squad now resets its UI**: previously, clicking "End" on a squad kept showing the declared availability and the old squad composition because the tab reloaded assignments from every session (active and ended). Now a squad whose session was started and then ended shows a clean "not active" state with a Start button: availability, past composition and tracking are no longer displayed, the next Start creates a brand-new session, and the other squad (still running) plus all history stay untouched.

## [Unreleased] - 2026-08-07

### Fixed
- **Ending a Shadowfront squad now resets its UI**: previously, clicking "End" on a squad kept showing the declared availability and the old squad composition because the tab reloaded assignments from every session (active and ended). Now a squad whose session was started and then ended shows a clean "not active" state with a Start button: availability, past composition and tracking are no longer displayed, the next Start creates a brand-new session, and the other squad (still running) plus all history stay untouched.
- **History detail showed every tenant's players**: opening a session detail (e.g. the Glory log) loaded `event_participants` without a guild filter, so a super admin viewing ALPHA saw 651 players instead of 165. The detail query now filters by the active guild.
- **Page refresh no longer forces the Subscription tab**: after a Stripe checkout redirect, the URL kept `?checkout=success&session_id=...`, so every page reload switched back to the Subscription tab regardless of where you were. The checkout parameters are now removed from the URL as soon as they are handled, so a refresh restores the tab you were on.

### Changed
- **Permanent guild join codes**: each guild now has ONE join code, stored in plain text (admin-readable only) alongside the SHA-256 hash used to validate registration. The Accounts tab displays it in read-only mode with a copy button, and there is no regenerate option anymore. If a guild has no code yet, the UI creates one once on first visit. A new `gm_get_join_code` RPC + `get-join-code` admin-accounts action return the plain code to admins; the caller is restricted to their own guild (or any guild for super admins). Verified live: the code is accepted by player-register.

### Fixed
- **Timezone coverage counted every tenant**: the Guild Members timezone histogram used the full in-memory member list as its denominator, so a super admin viewing ALPHA saw "2/834" instead of "2/165". `fetchGuildMembers` now filters `guild_members` by the active guild (same as the absences query), so the coverage ratio reflects the current tenant only.
- **Score approvals actually clear the pending state**: approving a player submission (single or "Approve All") no longer silently fails. The client previously updated the table with the in-memory session fields, which could match nothing and leave `is_pending` stuck. A new `gm_approve_participant_submission` RPC (SECURITY DEFINER) resolves the session server-side and clears `is_pending`, checking the caller is an admin of that guild. Verified live: the DTR submissions were approved and no pending rows remain.
- **History: Shadowfront squad name on the tile**: the History card now displays "Shadowfront Squad One" / "Shadowfront Squad Two" directly on the tile, not only when opening the detail modal.
- **History: Shadowfront squads are distinct again**: the History page now shows "Shadowfront Squad One" and "Shadowfront Squad Two" instead of a generic "Shadowfront". The `gm_list_event_sessions` RPC exposes the squad name from `event_status` and groups each session by `(event, session)` instead of by week, which also removes the duplicate row that appeared when a squad had mixed week values.
- **History: battle date fully visible**: the date column was widened so "07/08/2026" is no longer clipped to "07/08/202". The history date and sorting use the battle date chosen at creation, with the session timestamp as fallback.

### Added
- **History shows the battle date**: the History page now displays the fight day chosen when the event was created (`event_status.start_at`) instead of the session creation timestamp. This applies to all session events (Shadowfront, DTR, Arms Race, SvS, GvG). A new `gm_list_event_sessions` RPC (new OID) joins `event_status` to expose `start_at`; `history.js` uses it for the date and the sorting, falling back to the session timestamp when no battle date exists.

### Fixed
- **Shadowfront history restored in ALPHA**: the two accidentally deleted squad histories were rebuilt (Squad 1 session `2026-08-02T17:20:08.453Z` at 2026-08-07 18:00 UTC and Squad 2 session `2026-08-05T19:56:53.062Z` at 2026-08-07 23:00 UTC), with their 30 assignments each, their 30 participant rows and the `event_status` rows reactivated so the End button works again and finishing each squad records the event with the correct date.
- **Shadowfront participants were silently missing**: a composed squad could end up with zero rows in `event_participants`, so the participation tracking showed nothing and scores could not be entered. The client-side sync relied on the UI state and never checked the insert error. A new `gm_sync_shadowfront_participants` RPC resolves assignments straight from `shadowfront_squads` and inserts them with an index-safe `ON CONFLICT`; the client now calls it and logs failures. Existing affected sessions were backfilled.
- **Shadowfront ended squads lost their history**: ending a squad reset its `session_id` to null in `event_status`, so the participants list and the History page could no longer find the event. Ending a squad now keeps its session id (only `is_active` and the schedule are cleared), and the tracking step stays accessible after the end so scores can still be entered. The already-ended Squad 1 session was restored.
- **Glory "first declaration" rule applied everywhere**: the rule that a player's first-ever Glory declaration does not count is now consistent across the whole app. It already applied to the Glory badges; it now also applies to the Player Portal KPIs (`gm_personal_kpis`: `best_ever` excludes the first positive week, `current_week` only counts from the second declaration), to the Stats leaderboard Glory delta (progression starts from the second week) and to the cross-guild ranking (`gm_cross_guild_ranking`: the first Glory week is not counted as attended). The admin Glory tab and history keep showing the raw entered scores.
- **Subscription page tiles**: plan cards now fill the page width in a 4-column grid of equal, taller tiles (2 columns on tablet, 1 on mobile). The accepted-payment message now lists the main methods (Cards, Cartes Bancaires, Apple Pay, Google Pay, PayPal, Alipay, Amazon Pay, Klarna, iDEAL, Bancontact, EPS, BLIK, MB WAY, Pix, Satispay, Multibanco, MobilePay, WeChat Pay, Revolut Pay, Samsung Pay, Kakao Pay, Naver Pay, PAYCO, Link, and more).
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
