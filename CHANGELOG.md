# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Shadowfront Cross-Squad Member Pool Exclusion**: Assigning a player to any Shadowfront Squad (Squad One or Squad Two) now automatically excludes them from the available member pool of both squads. Unassigning a player immediately returns them to the available pool for both squads.
- **Shadowfront 2-Step Workflow & Member Pool**: Streamlined Shadowfront Squad One & Squad Two management by removing the redundant "Availability" step. Admins now directly compose squads from the complete member pool (Column 1) into Main Participants (Column 2) or Substitutes/Reserves (Column 3), followed by live Participation Tracking (Step 2).
- **Participation Percentage Badge Visibility**: Ensured historical participation rate badges (e.g. `100%`, `85%`, `50%`, `N/A`) are rendered directly in front of member names across all Shadowfront views (Member Pool, Main Participants, Substitutes/Reserves, and Participation Tracking table).
- **Overview Dashboard Pending Account Approvals**: Relocated pending player registration requests from the Accounts & Access tab to the Overview dashboard (`#pending-accounts-card`) for immediate officer visibility upon logging in.
- **Account Role Separation in Accounts & Access**: Split the Accounts tab into two distinct sections: "Active Admin Accounts" (`super_admin` & `guild_admin`) and "Player Portal Member Accounts" (`role === 'member'`), with player accounts clearly tagged with a lilac `Member` chip.
- **On-Demand Password Renewal**: Replaced password reveal button on account cards with an on-demand **Renew Password** action (`ph-arrows-clockwise`). Generates a 12-character random password via Supabase RPC, updates card display, copies password to clipboard, and notifies via English toast.
- **Detailed SvS & GvG Stats Breakdown**: Added Day 1-5 score (`score_prep`), Day 6 score (`score_pvp`), and Total score columns to SvS and GvG tabs in Stats, while preserving the attendance column (`1/1`).
- **Weekly Timeline Streamlining (SvS, GvG, Glory)**: Simplified the left timeline column in Event History for weekly events to display only the week number (e.g. `Week 32`), eliminating redundant date strings.
- **Glory History Tile Harmonization**: Glory events in History are now formatted as weekly events (`Week N`), removing artificial time displays (`12:00 UTC` / `00:00 UTC`).

---

## Fixed

- **Shadowfront Cross-Squad Double Booking Prevention**: Fixed `loadShadowfront()` to load assignment data across all current session IDs (`currentSids`) rather than active-only sessions (`activeSids`), ensuring assigned members are properly hidden from the unassigned pool when preparing squads prior to launch.
- **Shadowfront Double-Entry Removal**: Eliminated duplicate data entry in Shadowfront by replacing the 3-step Availability declaration flow with a streamlined 2-step Squad Composition and Tracking flow.
- **Web Push Notifications Setup Fixes**: Resolved multiple push notification registration errors (`updated_at` column missing, missing `ON CONFLICT` constraint, missing `p_ua` parameter) by adding a unique index on `push_subscriptions(endpoint)`, fixing `save_push_subscription` RPC parameters, using `last_seen`, and granting explicit `EXECUTE` permissions.
- **Phosphor Icons Webfont & CDN CSP Rules**: Updated Content-Security-Policy (CSP) headers in `index.html` to allow `cdn.jsdelivr.net` and `unpkg.com` fonts and stylesheets, restoring event and menu icons across dark theme components.
- **Glory Participation Count Calculation**: Resolved an issue where Glory history tiles showed `0/165 (0%)` participants despite non-zero total scores (e.g. 5.8B Glory). Updated database RPC `gm_list_event_sessions` (`20260810085000_fix_glory_history_participation_count.sql`) and `history.js` client aggregation to count participants when `participated > 0 OR score > 0`.
- **Misleading `00:00 UTC` Event Times**: Event history now renders explicit times (`19:30 UTC`) only when an admin explicitly set `start_at`. For unscheduled or historical events without a start time, default midnight timestamps (`00:00 UTC`) are omitted.
- **DEMO Guild Server Number Fix**: Fixed DEMO tenant `server_number` from `'#0000'` to `'0000'` in `public.guilds` (`20260810095000_fix_demo_server_number.sql`) and added frontend sanitization in `shell.js` to prevent double hash symbols (`##0000`).
- **Inactive Members UI Truncation**: Redesigned inactive member cards in Stats > Engagement with larger containers and line wrapping to prevent long player pseudos from being truncated.
- **Glorious Delta (`Glory Δ`) Column Scoping**: Restricted `Glory Δ` column to Global leaderboard mode only, hiding it in event-specific views (SvS, GvG) where it was irrelevant.
- **Strict 100% English UI Audit**: Audited and localized all UI strings, date formats (`en-GB`), empty state messages, and toast notifications to 100% English across `app.js`, `overview.js`, `history.js`, `sanctions.js`, and `gm-utils.js`.
- **`admin-accounts` Edge Function Fix**: Resolved `ReferenceError: info is not defined` and edge function network call failures by implementing clean response error handling and fallback logic.
- **Event History RPC Query & Order Fix**: Resolved event history loading failures ("No session for this filter") caused by invalid `GROUP BY` clauses and unsafe `session_id::timestamptz` casting in `gm_list_event_sessions` (`20260810040000` & `20260810070000`).

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
