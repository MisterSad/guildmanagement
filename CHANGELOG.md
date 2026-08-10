# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Super Admin GvG Guild A vs Guild B Matchup Dashboard**: Updated the **GvG** tab (`gvg-matchup.js`, `20260810200000_gvg_player_matchup_rpc.sql`) under the `SUPER ADMIN` section to compare **Guild A vs Guild B** directly through dedicated guild selection dropdowns (`ALPHA (#1058)`, `OMEGA (#1064)`, `IMK (#1058)`, `YARR (#1064)`, etc.).
- **Complete Player Roster Comparison for Selected Guilds**: Side-by-side tables display the complete player rosters of Guild A and Guild B with individual player stats:
  - **Power** (with power penalty multipliers: <60M x0.30, 60M-90M x0.65, >91M x1.00)
  - **Day 1-5 Avg** (average preparation phase GvG score per player)
  - **Day 6 Avg** (average Saturday castle battle GvG score per player)
  - **Threat Badge** (`EXTREME 🔴`, `HIGH 🟠`, `MEDIUM 🟡`, `LOW 🟢`)
- **Single-Line Score Formatting & No-Wrap Styling**: Enforced compact numeric score formatting (`K`/`M`/`B`) and `white-space: nowrap` styling across all table cells and headers.
- **SvS Dangerosity Power Penalty Thresholds**: Applied combat power penalty multipliers to SvS Dangerosity Scoring (<60M: 0.30x, 61M-90M: 0.65x, >91M: 1.00x).
- **Draft Weighted Coefficient Calculation Formula**: Applied event coefficients to the **Overall** (Global) participation rate calculation on the **Draft** page (`cross-rank.js` & migration `20260810160000_draft_weighted_coefficients.sql`): SvS (5), GvG (5), Shadowfront (3), DTR (2), Arms Race (2).
- **PL/pgSQL Column Ambiguity Fix**: Created migration `20260810150000_fix_cross_guild_ranking_ambiguous_guild.sql` using explicit `guild_id` column aliases across all CTEs.
- **Excluded DEMO Guild from Draft, SvS & GvG Rankings**: Updated SECURITY DEFINER RPCs `gm_cross_guild_ranking()`, `gm_svs_server_matchup()`, and `gm_gvg_player_matchup()` to filter out all members belonging to the `DEMO` tenant.

---

## Fixed

- **GvG Selection Mode**: Switched GvG tab dropdowns to list Guilds (with server number tags) rather than raw server numbers, allowing direct 1-vs-1 guild roster comparisons.
- **Super Admin GvG Navigation**: Added new `GvG` item under `SUPER ADMIN` section in `shell.js` with banner icon (`ph-flag-banner`) and r5Only protection.
- **Table Score Text Overflow / Multi-Line Wrapping**: Fixed multi-line wrapping of scores in matchup table cells by applying `white-space: nowrap;` and compact notation (`19.3M`), ensuring all table rows remain strictly single-line.
- **Dangerosity Tier Balance**: Penalized low-power accounts (<60M power) so they cannot artificially inflate threat levels to EXTREME or HIGH without sufficient combat power.

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
