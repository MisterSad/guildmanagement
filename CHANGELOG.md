# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Single-Line Score Formatting & No-Wrap Styling**: Updated the **SvS Matchup** page (`svs-matchup.js`) with compact numeric score formatting (`K`/`M`/`B`) and `white-space: nowrap` styling across all table cells and headers. Prevents multi-line text wrapping on large scores (e.g. `19 307 310` is displayed cleanly as `19.3M` on a single line, with full exact numbers available on mouse hover).
- **SvS Dangerosity Power Penalty Thresholds**: Updated the **SvS Matchup** RPC (`20260810180000_svs_matchup_power_penalty.sql`) and client logic (`svs-matchup.js`) to apply power penalties to Dangerosity Scoring:
  - **Power < 60M**: Big Penalty (`0.30x` multiplier)
  - **Power 61M to 90M**: Moderate Penalty (`0.65x` multiplier)
  - **Power > 91M**: Normal Dangerosity (`1.00x` multiplier, no penalty)
- **Day 1 to 5 & Day 6 Average Score Display**: Updated SvS Matchup tables (Side by Side and Combined Leaderboard) to explicitly display the **Average Day 1 to 5 score** and **Average Day 6 PvP score** for each player.
- **Super Admin SvS Server vs Server Matchup Dashboard**: Added a dedicated **SvS Matchup** tab (`svs-matchup.js`, `20260810170000_svs_server_matchup_rpc.sql`) under the `SUPER ADMIN` section to compare all guilds of any Server A against all guilds of Server B.
- **Draft Weighted Coefficient Calculation Formula**: Applied event coefficients to the **Overall** (Global) participation rate calculation on the **Draft** page (`cross-rank.js` & migration `20260810160000_draft_weighted_coefficients.sql`): SvS (5), GvG (5), Shadowfront (3), DTR (2), Arms Race (2).
- **PL/pgSQL Column Ambiguity Fix**: Created migration `20260810150000_fix_cross_guild_ranking_ambiguous_guild.sql` using explicit `guild_id` column aliases across all CTEs.
- **Excluded DEMO Guild from Draft & SvS Rankings**: Updated SECURITY DEFINER RPCs `gm_cross_guild_ranking()` and `gm_svs_server_matchup()` to filter out all members belonging to the `DEMO` tenant.

---

## Fixed

- **Table Score Text Overflow / Multi-Line Wrapping**: Fixed multi-line wrapping of scores in SvS Matchup table cells by applying `white-space: nowrap;` and compact notation (`19.3M`), ensuring all table rows remain strictly single-line.
- **Dangerosity Tier Balance**: Penalized low-power accounts (<60M power) so they cannot artificially inflate threat levels to EXTREME or HIGH without sufficient combat power.
- **Super Admin Navigation**: Added new `SvS` item under `SUPER ADMIN` section in `shell.js` with sword icon (`ph-sword`) and r5Only protection.
- **Global Participation Rate Weighting**: Standardized Overall score calculation on the Draft page so high-impact major guild events (SvS and GvG) carry 5x weight, Shadowfront carries 3x weight, and daily events (DTR & Arms Race) carry 2x weight.
- **PostgreSQL PL/pgSQL Ambiguous Column Error**: Resolved `column reference "guild" is ambiguous` in `gm_cross_guild_ranking()` RPC by qualifying CTE select columns with `guild_id`.

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
