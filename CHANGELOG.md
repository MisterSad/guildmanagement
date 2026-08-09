# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Overview Dashboard Pending Account Approvals**: Relocated pending player registration requests from the Accounts & Access tab to the Overview dashboard (`#pending-accounts-card`) for immediate officer visibility upon logging in.
- **Account Separation in Accounts & Access**: Split the Accounts tab into two distinct sections: "Active Admin Accounts" (`super_admin` & `guild_admin`) and "Player Portal Member Accounts" (`role === 'member'`), with player accounts clearly tagged with a lilac `Member` chip.
- **On-Demand Password Renewal**: Replaced password reveal button on account cards with an on-demand **Renew Password** action. Generates a secure random password via Supabase RPC, updates card display, copies password to clipboard, and notifies via English toast.
- **Detailed SvS & GvG Stats Breakdown**: Added Day 1-5 score, Day 6 score, and Total score columns to SvS and GvG tabs in Stats, while preserving the attendance column (`1/1`).
- **Weekly Timeline Streamlining (SvS, GvG, Glory)**: Simplified the left timeline column in Event History for weekly events to display only the week number (e.g. `Week 32`), eliminating redundant date strings.
- **Glory History Tile Harmonization**: Glory events in History are now formatted as weekly events (`Week N`), removing artificial time displays (`12:00 UTC` / `00:00 UTC`).

---

## Fixed

- **Glory Participation Count Calculation**: Resolved an issue where Glory history tiles showed `0/165 (0%)` participants despite non-zero total scores (e.g. 5.8B Glory). Updated database RPC `gm_list_event_sessions` (`20260810085000_fix_glory_history_participation_count.sql`) and `history.js` client aggregation to count participants when `participated > 0 OR score > 0`.
- **Misleading `00:00 UTC` Event Times**: Event history now renders explicit times (`19:30 UTC`) only when an admin explicitly set `start_at`. For unscheduled or historical events without a start time, default midnight timestamps (`00:00 UTC`) are omitted.
- **DEMO Guild Server Number Fix**: Fixed DEMO tenant `server_number` from `'#0000'` to `'0000'` in `public.guilds` (`20260810095000_fix_demo_server_number.sql`) and added frontend sanitization in `shell.js` to prevent double hash symbols (`##0000`).
- **Inactive Members UI Truncation**: Redesigned inactive member cards in Stats > Engagement with larger containers and line wrapping to prevent long player pseudos from being truncated.
- **Glorious Delta (`Glory Δ`) Column Scoping**: Restricted `Glory Δ` column to Global leaderboard mode only, hiding it in event-specific views (SvS, GvG) where it was irrelevant.
- **Strict 100% English UI Audit**: Audited and localized all UI strings, date formats (`en-GB`), empty state messages, and toast notifications to 100% English across `app.js`, `overview.js`, `history.js`, `sanctions.js`, and `gm-utils.js`.
- **Anti-Collision Event Session IDs**: Daily events (DTR, Arms Race Stage A/B, Shadowfront Squad 1/2) now include a sequence suffix in their session ID (`DTR-20260812-1`, `DTR-20260812-2`, etc.), allowing multiple sessions of the same event type on the same UTC day without data collision.
- **Mandatory Date Picker for SvS and GvG**: Launching a Server vs Server or Guild vs Guild event now requires an explicit admin-set battle date, ensuring the ISO-week session ID always matches the actual battle week.
- **Session ID Cascade on Schedule Edit**: Editing the battle date of an active event now recalculates and cascades the `session_id` to both `event_status` and `event_participants`, keeping the ID consistent with the actual date.
- **`gm_session_id_base()` SQL Helper**: New SQL function strips the sequence suffix from a session ID (e.g., `DTR-20260812-2` -> `DTR-20260812`) for use in future aggregation queries.
- **`idx_event_status_guild_session` Index**: New composite index on `event_status(guild, session_id)` accelerates JOIN lookups in `gm_list_event_sessions`.

---

- **CRITICAL SQL Crash in `gm_list_event_sessions`**: The ORDER BY clause was casting `session_id::timestamptz`, which throws a PostgreSQL exception for human-readable IDs like `SF1-20260812`, `ARA-20260809`, `DTR-20260812-1`. Replaced with a safe regex extraction of the YYYYMMDD date portion, with a `week_start` fallback for weekly keys.
- **Same-Day Session Collision (DTR, Arms Race, Shadowfront)**: Starting a second DTR, Arms Race stage, or Shadowfront squad on the same UTC day now generates a unique session ID instead of silently overwriting the first session's data.
- **Session ID Stale After Date Edit**: `editEventSchedule` / `editStageSchedule` / `editSquadSchedule` previously updated `start_at` and `week_start` but left the `session_id` pointing to the old date. If the ISO week changed, stats became incoherent. Fixed by recalculating and cascading the new `session_id`.
- **Arms Race Historical `week_start` Backfill**: Rows for `ARMS RACE STAGE A` and `B` created before migration `20260809190000` may have had a `week_start` inconsistent with the date encoded in their session ID. A data migration recalculates `week_start` from the YYYYMMDD part of the `session_id` for all affected rows.
- **`sessionDateFromId` Regex**: Updated to handle the new sequence-suffixed session IDs (`SF1-20260812-1`) in addition to the legacy bare format (`SF1-20260812`).

---

- **Server-Side Deterministic Leaderboard Engine (`gm_leaderboard` RPC)** (all tenants): Statistics scores, participation rates, glory deltas, and consistency bonuses are now calculated 100% in SQL via a `SECURITY DEFINER` function (`public.gm_leaderboard`). Eliminates client-side score discrepancies, 1000-row REST API truncation, and inconsistent calculations across devices.
- **Secure One-Time Password Reset API** (all tenants): Replaced legacy plaintext password retrieval endpoint (`get-password`) in `admin-accounts` with a secure password reset action (`reset-password`).
- **Atomic Shadowfront Unassign RPC (`gm_unsync_shadowfront_participant`)**: Unassigning a player from a Shadowfront squad now atomically deletes their squad assignment and cleans up their row in `event_participants`.
- **Security Headers via `vercel.json`**: Implemented strict Content-Security-Policy (CSP), X-Frame-Options (DENY), X-Content-Type-Options (nosniff), and Referrer-Policy headers.
- **Explicit Webhook Discord Validation**: Added strict URL scheme and hostname validation (`https://discord.com/api/webhooks/`) to block SSRF attacks on `event-reminders`.

---

## Historical Fixes

- **Privilege Escalation in Admin Accounts (`admin-accounts/index.ts`)**: Closed security vulnerability where `member` accounts passed implicit role checks to execute administrative actions.
- **Multi-Tenant Isolation Constraints**: Dropped lingering `DEFAULT 'ALPHA'` values across `guild_members`, `event_participants`, `event_status`, `shadowfront_squads`, `weekly_scores`, `sanctions`, and `banned_players`. Added database foreign keys and indexes for tenant isolation.
- **Shadowfront Re-assignment Scope Fix**: Scoped squad re-assignment deletions in `shadowfront.js` to `session_id` instead of deleting an entire week's assignments.
- **Stats Calculation & Participation Denominator**: Excluded 'Glory' from event instance denominators, and correctly included substitute attendance (`sub_present === true`) across global leaderboard modes.
- **Member Portal Push Preferences in Service Role Context**: Updated `gm_get_push_prefs` and `gm_set_push_prefs` RPCs to accept explicit `p_uid` parameters so service role edge function calls evaluate correctly.
- **Member Score Overwrite Protection**: Prevented player portal score submissions from overwriting event records that have already been validated (`is_pending === false`) by a guild officer.
- **Rate-Limiter IP Spoofing Fix**: Extracted trusted client IP using `cf-connecting-ip` / `x-real-ip` / last `x-forwarded-for` header in `player-register`.
- **Sanctions Guild Assignment & Created By**: Explicitly passed `guild` on sanction creation and enforced `auth.uid()` default for audit logs.
