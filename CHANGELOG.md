# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **PL/pgSQL Column Ambiguity Fix**: Created migration `20260810150000_fix_cross_guild_ranking_ambiguous_guild.sql` using explicit `guild_id` column aliases across all CTEs (`roster`, `player_stats`, `sess_totals`, `sess`, `es_sess`, `ep`), resolving the PostgreSQL `column reference "guild" is ambiguous` PL/pgSQL error on the **Draft** page.
- **Excluded DEMO Guild from Draft Mercato Ranking**: Updated SECURITY DEFINER RPC `gm_cross_guild_ranking()` (`20260810140000_draft_exclude_demo_guild.sql`) and `cross-rank.js` client logic to filter out all members belonging to the `DEMO` tenant, keeping the Draft Mercato list focused strictly on real competitive guilds.
- **Draft Regularity Sort Tie-Breaker & Volume Order**: Updated player ranking on the **Draft** page (`cross-rank.js`) to order players by **Regularity** (rate %, followed by number of attended events, total sessions, and combat power). Players with a long-standing active record (e.g. 22/23 attended) are now ranked above players with few total sessions (e.g. 5/5).
- **PostgREST 1000-Row Limit Bypass & Dynamic Player Counter**: Fixed the pagination cap on `cross-rank.js` by invoking `.range(0, 99999)` on `gm_cross_guild_ranking()`. Updated top-right header counter to display dynamic counts (e.g. `1420 players` when unfiltered, `45 of 1420 players` when filtered).
- **Union Session Denominators in Database SQL**: Created migration `20260810130000_draft_ranking_session_union_and_regularity.sql` combining event sessions from `event_status` and `event_participants`. If a guild has held Shadowfront sessions in `event_status`, members who did not participate display `0% (0/N)` rather than `— (0/0)`.

---

## Fixed

- **PostgreSQL PL/pgSQL Ambiguous Column Error**: Resolved `column reference "guild" is ambiguous` in `gm_cross_guild_ranking()` RPC by qualifying CTE select columns with `guild_id`.
- **DEMO Guild Player Exposure**: Excluded test/demo accounts (`DEMO` tenant) from appearing in superadmin Mercato & Transfer rankings.
- **PostgREST 1000 Row Truncation**: Resolved issue where player count was hardcoded/capped at `1000 of 1000 players` by bypassing the default REST pagination range limit.
- **Cross-Guild Ranking Null Rate Sorting**: Fixed rate sorting logic in `cross-rank.js` so players without event records are placed at the bottom regardless of sort direction.

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
