# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Super Admin SvS Server vs Server Matchup Dashboard**: Added a dedicated **SvS Matchup** tab (`svs-matchup.js`, `20260810170000_svs_server_matchup_rpc.sql`) under the `SUPER ADMIN` section to compare all guilds of any Server A against all guilds of Server B.
- **Detailed SvS Dangerosity & Scoring Breakdown**: Displays complete player rosters for both servers with score breakdowns for **Day 1 to 5** (Preparation Phase) and **Day 6** (PvP / Invasion Battle Day), calculating an integrated Dangerosity Score ($\text{Power} + 2 \times \text{Prep Avg} + 5 \times \text{PvP Avg}$) and assigning Threat Badges (`EXTREME 🔴`, `HIGH 🟠`, `MEDIUM 🟡`, `LOW 🟢`).
- **Side-by-Side & Combined Leaderboard Modes**: Includes a dual-pane **Side by Side** view comparing Server A and Server B rosters, along with a **Combined Leaderboard** mode allowing sorting across all servers by Danger Score, Day 6 PvP, Day 1-5 Prep, Power, or Guild.
- **Draft Weighted Coefficient Calculation Formula**: Applied event coefficients to the **Overall** (Global) participation rate calculation on the **Draft** page (`cross-rank.js` & migration `20260810160000_draft_weighted_coefficients.sql`):
  - **SvS**: Coefficient 5
  - **GvG**: Coefficient 5
  - **Shadowfront**: Coefficient 3
  - **DTR (Defend Trade Route)**: Coefficient 2
  - **Arms Race**: Coefficient 2
- **Expanded Event Rate Columns**: Displayed rate columns with clear coefficient indicators (`SvS (x5)`, `GvG (x5)`, `Shadowfront (x3)`, `DTR (x2)`, `Arms Race (x2)`, and `Overall (Weighted %)`) for total transparency.
- **PL/pgSQL Column Ambiguity Fix**: Created migration `20260810150000_fix_cross_guild_ranking_ambiguous_guild.sql` using explicit `guild_id` column aliases across all CTEs, resolving the PostgreSQL `column reference "guild" is ambiguous` error.
- **Excluded DEMO Guild from Draft & SvS Rankings**: Updated SECURITY DEFINER RPCs `gm_cross_guild_ranking()` and `gm_svs_server_matchup()` to filter out all members belonging to the `DEMO` tenant.

---

## Fixed

- **Super Admin Navigation**: Added new `SvS` item under `SUPER ADMIN` section in `shell.js` with sword icon (`ph-sword`) and r5Only protection.
- **Global Participation Rate Weighting**: Standardized Overall score calculation on the Draft page so high-impact major guild events (SvS and GvG) carry 5x weight, Shadowfront carries 3x weight, and daily events (DTR & Arms Race) carry 2x weight.
- **PostgreSQL PL/pgSQL Ambiguous Column Error**: Resolved `column reference "guild" is ambiguous` in `gm_cross_guild_ranking()` RPC by qualifying CTE select columns with `guild_id`.
- **DEMO Guild Player Exposure**: Excluded test/demo accounts (`DEMO` tenant) from appearing in superadmin Mercato & Transfer rankings and SvS Matchup.
- **PostgREST 1000 Row Truncation**: Resolved issue where player count was hardcoded/capped at `1000 of 1000 players` by bypassing the default REST pagination range limit.

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
