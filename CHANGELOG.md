# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Server-Grouped Accordion View for Super Admin Accounts**: Grouped **Active Guild Admin Accounts** in the Super Admin Accounts & Access dashboard (`app.js`) by **Server** (e.g. `Server #1058`, `Server #1064`, etc.) using collapsible accordion cards.
- **Accordion Card UI Elements**: Each server group features a server badge (`Server #1058`), a list of associated guilds (`ALPHA, IMK, BABE`), account count badge (`3 admins`), and an animated toggle arrow (`ph-caret-down`). The first server section is open by default, and clicking any header toggles expand/collapse.
- **Super Admin Accounts & Access Filter Update**: Filtered the **Active Guild Admin Accounts** section in the Super Admin Accounts & Access dashboard (`app.js`) to display **ONLY** `guild_admin` accounts (`acc.role === 'guild_admin'`), completely excluding player portal `member` accounts.
- **Strict Right-Edge Alignment & Zero Overflow**: Enforced `grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)` across all 3 card rows in both **SvS Matchup** (`svs-matchup.js`) and **GvG Matchup** (`gvg-matchup.js`).
- **Compact Roster Row Styling & Truncation**: Added `max-width: 110px`, `text-overflow: ellipsis`, and `overflow: hidden` on player pseudos in side-by-side tables. Adjusted cell padding (`padding: .3rem .2rem`) and badge sizes so the right roster table fits 100% inside its container with zero horizontal overflow.
- **Compact Sidebar Subscription Widget**: Compacted the bottom left sidebar subscription card (`shell.js`, `shell.css`) to retain only the essential elements requested:
  - **Guild Dropdown Selector** (`ALPHA (#1058)`, `OMEGA (#1064)`, etc.)
  - **Subscription Plan Status Pill/Badge** (`Unlimited`, `Premium`, `Free`)
  - Removed the bulky top avatar badge icon, title text, and long description string for a clean, ultra-sleek sidebar layout.
- **Pixel-Perfect Tile & Grid Alignment**: Standardized selector grids in both **SvS Matchup** (`svs-matchup.js`) and **GvG Matchup** (`gvg-matchup.js`) tabs with a unified `display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem;` layout.
- **Centered Floating VS Badge**: Positioned the central `VS` badge absolutely at `left: 50%` over the grid gap, ensuring the right and left borders of top selector boxes align down to the exact pixel with the summary cards and side-by-side roster tables below.
- **Super Admin GvG Guild A vs Guild B Matchup Dashboard**: Added a dedicated **GvG** tab (`gvg-matchup.js`, `20260810200000_gvg_player_matchup_rpc.sql`) under the `SUPER ADMIN` section to compare **Guild A vs Guild B** directly through dedicated guild selection dropdowns (`ALPHA (Server #1058)`, `OMEGA (Server #1064)`, `IMK (Server #1058)`, `YARR (Server #1064)`, etc.).
- **Full Player Roster Comparison for Selected Guilds**: Side-by-side tables display the complete player rosters of Guild A and Guild B with individual player stats (Power, Day 1-5 Avg, Day 6 Avg, Threat Badge).
- **Single-Line Score Formatting & No-Wrap Styling**: Enforced compact numeric score formatting (`K`/`M`/`B`) and `white-space: nowrap` styling across all table cells and headers.
- **SvS Dangerosity Power Penalty Thresholds**: Applied combat power penalty multipliers to SvS Dangerosity Scoring (<60M: 0.30x, 61M-90M: 0.65x, >91M: 1.00x).
- **Draft Weighted Coefficient Calculation Formula**: Applied event coefficients to the **Overall** (Global) participation rate calculation on the **Draft** page (`cross-rank.js` & migration `20260810160000_draft_weighted_coefficients.sql`): SvS (5), GvG (5), Shadowfront (3), DTR (2), Arms Race (2).
- **PL/pgSQL Column Ambiguity Fix**: Created migration `20260810150000_fix_cross_guild_ranking_ambiguous_guild.sql` using explicit `guild_id` column aliases across all CTEs.
- **Excluded DEMO Guild from Draft, SvS & GvG Rankings**: Updated SECURITY DEFINER RPCs `gm_cross_guild_ranking()`, `gm_svs_server_matchup()`, and `gm_gvg_player_matchup()` to filter out all members belonging to the `DEMO` tenant.

---

## Fixed

- **Super Admin Accounts Organization**: Replaced unstructured account list with server-level accordion grouping for easy cross-server administration.
- **Super Admin Accounts List Pollution**: Prevented player portal `member` accounts from appearing in the Super Admin "Active Guild Admin Accounts" overview card.
- **Table Overflow on Right Border**: Fixed right side overflow of player roster tables by capping column grid widths with `minmax(0, 1fr)` and truncating long player pseudos with ellipsis (`...`).
- **Sidebar Space Efficiency**: Reduced vertical height of the sidebar subscription model card by 70%, keeping only the guild switcher dropdown and plan status badge.
- **Tile & Card Vertical Misalignment**: Resolved offset between top selector boxes and lower summary/roster cards in SvS and GvG tabs by aligning grid column dimensions.
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
