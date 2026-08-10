# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Renamed Settings Tab to Draft**: Updated the super admin cross-guild ranking page and navigation menu item from **"Settings"** to **"Draft"** across `i18n.js`, `index.html`, and `shell.js`, updating the navigation icon to `ph-note-pencil`.
- **Eliminated PostgREST `PGRST116` Multi-Row Errors in Player Portal**: Replaced all `.maybeSingle()` queries in `supabase/functions/member-portal/index.ts` with `.limit(1)` + safe array indexing (`rows?.[0] ?? null`), completely preventing PostgREST `PGRST116` (`"JSON object requested, multiple (or no) rows returned"`) failures when duplicate rows or transferred player profiles exist.
- **Player Portal Reconnect & Error Recovery Actions**: Redesigned the Player Portal error screen in `portal.js` with clear explanations and immediate action buttons (**"Reconnect / Sign Out"** and **"Retry"**), allowing players to clear stale/expired browser sessions and sign back in smoothly.
- **Structured Edge Function JSON Errors**: Updated `member-portal` Edge Function to return HTTP 200 with structured JSON error payloads `{ ok: false, error: "db_error", message: "..." }` instead of generic HTTP 500 status codes, preventing Supabase JS SDK from masking underlying database errors with generic `"Edge Function returned a non-2xx status code"`.
- **Default Current Week Filter & Expanded Stats Timeframes**: Scores in Stats are now filtered **by default on the current week** (`1w`), with dropdown selector support for **1 week** (`1w`), **2 weeks** (`2w`), **4 weeks** (`4w`), **8 weeks** (`8w`), and **All time** (`all`).
- **`gm_leaderboard` SQL RPC Timeframe Update**: Updated Supabase SECURITY DEFINER RPC `gm_leaderboard` (`20260810100000_update_gm_leaderboard_2w.sql`) to default `p_period` to `'1w'` and support the 2-week timeframe (`'2w'`).
- **Shadowfront Historical Participation Rate Fix Across All Tenants**: Resolved a bug where ended past Shadowfront sessions were excluded from historical calculations because `currentSids` retained past session IDs in `event_status`. `loadShadowfront()` now uses `activeSids` for history exclusion and unions `shadowfront_squads` with `event_participants`, ensuring historical participation rate badges (`100%`, `85%`, `50%`) update correctly across all tenants (CLAW, ALPHA, OMEGA, BABE, IMK, YARR, DEMO).
- **Shadowfront Cross-Squad Member Pool Exclusion**: Assigning a player to any Shadowfront Squad (Squad One or Squad Two) now automatically excludes them from the available member pool of both squads. Unassigning a player immediately returns them to the available pool for both squads.
- **Shadowfront 2-Step Workflow & Member Pool**: Streamlined Shadowfront Squad One & Squad Two management by removing the redundant "Availability" step. Admins now directly compose squads from the complete member pool (Column 1) into Main Participants (Column 2) or Substitutes/Reserves (Column 3), followed by live Participation Tracking (Step 2).
- **Participation Percentage Badge Visibility**: Ensured historical participation rate badges (e.g. `100%`, `85%`, `50%`, `N/A`) are rendered directly in front of member names across all Shadowfront views (Member Pool, Main Participants, Substitutes/Reserves, and Participation Tracking table).

---

## Fixed

- **PostgREST `JSON object requested, multiple (or no) rows returned` Fix**: Resolved PostgREST `PGRST116` query errors during portal login by switching `.maybeSingle()` to `.limit(1)` in `member-portal` Edge Function and updating `.single()` to `.maybeSingle()` in `events.js`, `armsrace.js`, and `shadowfront.js`.
- **Player Portal Non-2xx Connection Error Masking**: Fixed generic `"Edge Function returned a non-2xx status code"` error screen by updating `member-portal` Edge Function and `portal.js` to return and handle structured JSON error messages with a built-in Reconnect/Sign Out option.
- **Stats Default Period Selection**: Changed Stats initial timeframe default from `'all'` to `'1w'` (current week) and added missing `2w` option to `stats.js` and `i18n.js`.
- **Shadowfront Participation Rate Badge Freeze**: Fixed player participation percentage calculation in `shadowfront.js` by separating history exclusion logic (`activeSids`) from current squad assignment fetching (`currentSids`), and combining session data from both `shadowfront_squads` and `event_participants`.
- **Shadowfront Cross-Squad Double Booking Prevention**: Fixed `loadShadowfront()` to load assignment data across all current session IDs (`currentSids`) rather than active-only sessions (`activeSids`), ensuring assigned members are properly hidden from the unassigned pool when preparing squads prior to launch.
- **Shadowfront Double-Entry Removal**: Eliminated duplicate data entry in Shadowfront by replacing the 3-step Availability declaration flow with a streamlined 2-step Squad Composition and Tracking flow.
- **Web Push Notifications Setup Fixes**: Resolved multiple push notification registration errors (`updated_at` column missing, missing `ON CONFLICT` constraint, missing `p_ua` parameter) by adding a unique index on `push_subscriptions(endpoint)`, fixing `save_push_subscription` RPC parameters, using `last_seen`, and granting explicit `EXECUTE` permissions.
- **Phosphor Icons Webfont & CDN CSP Rules**: Updated Content-Security-Policy (CSP) headers in `index.html` to allow `cdn.jsdelivr.net` and `unpkg.com` fonts and stylesheets, restoring event and menu icons across dark theme components.

---

## Historical Fixes

- **Anti-Collision Event Session IDs**: Daily events (DTR, Arms Race Stage A/B, Shadowfront Squad 1/2) include a sequence suffix in their session ID (`DTR-20260812-1`, `DTR-20260812-2`, etc.), allowing multiple sessions of the same event type on the same UTC day without data collision.
- **`gm_session_id_base()` SQL Helper**: SQL function strips the sequence suffix from a session ID (e.g., `DTR-20260812-2` -> `DTR-20260812`) for use in future aggregation queries.
- **`idx_event_status_guild_session` Index**: Composite index on `event_status(guild, session_id)` accelerates JOIN lookups in `gm_list_event_sessions`.
- **CRITICAL SQL Crash in `gm_list_event_sessions`**: Replaced unsafe timestamp cast in ORDER BY clause with safe regex extraction of YYYYMMDD date portion.
- **Same-Day Session Collision (DTR, Arms Race, Shadowfront)**: Starting a second DTR, Arms Race stage, or Shadowfront squad on the same UTC day generates a unique session ID.
- **Session ID Stale After Date Edit**: Recalculated and cascaded new `session_id` on schedule edits.
- **Arms Race Historical `week_start` Backfill**: Recalculated `week_start` from YYYYMMDD part of `session_id` for historical rows.
- **Server-Side Leaderboard Engine (`gm_leaderboard` RPC)**: Calculated 100% in SQL via SECURITY DEFINER function.
- **Secure Password Reset API**: Replaced legacy plaintext password retrieval endpoint with secure password reset action.
