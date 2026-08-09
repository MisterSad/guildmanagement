# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Guild benchmark (super admin)**: a new "Guild benchmark" tab compares
  every guild side by side: members, total/max power, active events, the
  8-week participation rate, members inactive for 2+ weeks, subscription type
  and push subscription count. Each guild card flags automatic alerts (low
  participation, many inactive, no power data) so problems are visible at a
  glance. Super admin only (`gm_guild_benchmark` is gated by
  `is_super_admin()`).
- **Contextual push reminders with per-player preferences**: players can now
  choose which web-push reminders they receive from the "My Info" tab (event
  reminders, Glory, challenges). Preferences are stored per guild+player
  (`player_push_prefs`) and respected by the reminder engine: a player who
  opted out of an event type no longer receives that push. Subscriptions are
  now bound to the authenticated player (`push_subscriptions.pseudo`), and the
  default remains "receive everything" for players who never set preferences.
- **Weekly challenges + season progression (Player Portal)**: a new
  "Challenges" tab shows weekly goals computed server-side: attend 1/3/5
  events this week (via the shared scoring key), submit your Glory score, and
  refresh your power. A season summary (last 4 weeks) shows your total events
  and a Bronze/Silver/Gold season rank. Completed challenges are checked off;
  progress bars update live.
- **Stats > Engagement page rebuilt**: the tiles and charts are now clear. The
  page shows: active members this week, the average 8-week participation rate,
  members inactive for 2+ weeks, and weeks with data; a weekly participation
  trend (distinct members who attended at least one event, computed with the
  shared scoring key so Arms A+B and Shadowfront count once per week); a
  per-event-type engagement breakdown (SvS, GvG, Shadowfront, Arms Race, DTR);
  and an inactive-members list sorted by length of absence with last-seen week
  and power.
- **Stats tabs persist**: the selected Stats mode (Guild Health, Engagement,
  Roster, Operations) is saved and restored after a page reload. The
  period/week selectors are hidden on KPI tabs so they can no longer fall back
  to the global leaderboard.
- **Multi-tenant sandbox hardened** (all tenants):
  - `guildsList` is loaded from the `guilds` table instead of a stale
    hard-coded list.
  - The `'ALPHA'` column defaults were removed from 6 tables: an insert
    without a guild now fails loudly instead of silently landing in ALPHA.
  - `accounts.guild` is required for every role except `super_admin`;
    `join_code_hash` is globally unique; `gm_cross_guild_ranking` grants are
    restricted.
  - DTR uses a single event name (`Defend Trade Route`); the
    `player_name_history` insert now provides the guild.
- **Participation counted per the game rules** (all tenants): a shared scoring
  key (`gm_event_scoring_key` / `window.GM.eventScoringKey`) drives all
  participation math. Arms Race (Stage A + B) and Shadowfront (Squad 1 + 2)
  count **once per week**; SvS and GvG once per week; each DTR event counts
  separately. Applied to the stats leaderboard, cross-guild ranking, Player
  Portal KPIs and participation badges.
- **Shadowfront weeks derived from the battle date**: the client and
  `gm_sync_shadowfront_participants` use the admin-chosen date (`start_at`),
  falling back to the date encoded in the session id. Inconsistent existing
  rows were backfilled for all tenants (a player can only be in one squad per
  week; duplicates merged).
- **Human-readable deterministic session ids** (all tenants): every event
  carries a readable, chronologically-sortable id (`SVS-2026-W32`,
  `ARA-20260809`, `SF1-20260802`...). Re-starting an event for the same date
  reuses the session instead of creating a ghost duplicate. History is sorted
  most recent first.
- **Gamification badges** in the Player Portal: ranks, seniority, power,
  participation, Glory. Tiers recalibrated (seniority up to 2 years, power up
  to 300M, participation up to 1500, Glory up to 50M/week). A player's
  first-ever Glory declaration never counts.
- **"My Info" portal tab**: power, self-service Glory, timezone, transfer
  request. Personal KPI dashboard (power rank, percentile, Glory, attendance,
  tenure).
- **Stripe payments**: replaced the legacy processor with a hosted Stripe
  checkout (order creation, status, webhook). New pricing (1M 7.99 EUR / 3M
  19.99 EUR / 6M 34.99 EUR / 12M 59.99 EUR), Lifetime removed, full-width plan
  tiles with a detailed payment-methods list.
- **Permanent per-guild join codes**: one code per guild, read-only display
  with copy, no regeneration. `join_code_hash` globally unique.
- **Static login page** (no 3D animation) with a Discord community button and
  a "Developed by HawkEye #1058" footer.
- **Portal access badge on member tiles**: a "Portal" chip marks players whose
  account has been validated.
- **Fictional DEMO tenant** (server #0000, 200 players, 4 weeks of events) for
  screenshots and demos, re-seedable via `scripts/generate_demo_data.py`.
- **GitHub Actions CI** (vitest + `deno check` on edge functions) and
  **`scripts/bump_cache_busters.py`** (automatic `?v=` bumps).
- **Playwright e2e suite**: 7 browser tests cover the login page (title,
  footer, Discord button, empty-submit validation, register/form switch) and
  the Player Portal (dashboard boot, sidebar navigation, weekly challenges
  panel). The Supabase backend is stubbed via route interception so the suite
  runs locally and in CI without touching the live project. A new `e2e` CI job
  installs Chromium and runs `npx playwright test` on every push/PR.
  `npm run test:e2e` added; test artifacts are gitignored.

---

## Removed

- **Scouting tool (super admin) removed**: the `Scouting` tab, its client
  module (`scouting.js`) and the backend objects it created
  (`scouting_snapshots` table, `gm_scouting_capture` / `gm_scouting_report` /
  `gm_scouting_history` functions and their grants) are gone. The drop
  migration `20260809140000_drop_scouting.sql` removes every artifact for all
  tenants; the feature is no longer used and its rival-roster data is dropped.

---

## Fixed

- **Stats no longer jumps back to "Weekly Global"**: reloading the page or
  changing the period/week while on a KPI tab used to bounce to the global
  leaderboard. The selected Stats mode is now persisted and restored, and the
  period/week selectors are hidden on KPI tabs.
- **History page came back empty after the event-id rework**: the
  `gm_list_event_sessions` RPC selected `ep.session_id` with a `GROUP BY` on
  `coalesce(...)`, which PostgreSQL rejects. The RPC now selects the `coalesce`
  expression aliased `session_id` (fresh OID), restoring the page for all
  tenants.
- **History sorted most recent first**: sessions are always sorted newest to
  oldest (the sort previously only ran in one code path).
- **History dates with a bare `+00` offset**: Postgres serializes `timestamptz`
  as `+00`, which `new Date()` rejects. The date helpers now normalize the
  offset.
- **Approve / Approve All stuck on "..."**: the handlers called `showToast()`
  without a prefix (undefined in scope), aborting the `catch` before restoring
  the button. Now uses `window.GM.showToast` and reloads participants after
  approving.
- **Active events showing players from other guilds**: with the shared
  deterministic session ids (e.g. `GVG-2026-W32`), queries filtered only by
  `event_name` + `session_id` loaded every guild's participants. All reads and
  writes on `event_participants`, `event_status`, `shadowfront_squads`,
  `shadowfront_signups` now also filter by the active guild, and
  `gm_populate_event_participants` takes an explicit `p_guild` verified against
  the caller. No cross-tenant data (verified).
- **Ending a Shadowfront squad resets its UI**: the composition and
  availability of an ended squad are no longer shown; a new Start creates a
  fresh session without touching the other squad or the history.
- **Score approval is reliable**: `gm_approve_participant_submission` resolves
  the session server-side and clears `is_pending`.
- **Shadowfront: participants never synced + history lost on end**: the sync
  now runs in the database (`gm_sync_shadowfront_participants`), and ending a
  squad keeps the session for history.
- **History: squad names and dates**: "Shadowfront Squad One/Two" shown
  cleanly, the battle date chosen at creation is used, no duplicate rows.
- **Timezone coverage ratio** now counts only the active tenant's members.
- **Page refresh keeps the active tab**: `?checkout=` params are purged from
  the URL after the Stripe return.
- **Auto-enroll of new members** into active events via RPC (instead of client
  upserts that failed on the partial index).
- **Duplicate-UID dialog**: `gm_find_player_by_uid` + `gm_admin_request_transfer`
  for transfers, `guild_transfers` RLS hardened.
- **Glory rule (first declaration excluded)** applied everywhere: badges,
  portal KPIs, leaderboard, cross-guild ranking. Zero/empty scores never count.
- **Badges: zero/empty excluded and tiers recalibrated** to avoid instant
  unlocks.

---

## Version history

- **2026-08-09** — Scouting feature removed (tab, module, DB objects).
- **2026-08-09** — Playwright e2e suite (login + portal, stubbed backend) and
  CI `e2e` job.
- **2026-08-09** — Stats Engagement rebuilt, persisted Stats tabs, sandbox
  hardened, scoring per game rules, Shadowfront weeks fixed, readable session
  ids, DTR unified.
- **2026-08-08** — tenancy hardening, score approval, guild scoping, history
  fixed, permanent join codes, DEMO tenant.
- **2026-08-07** — badges/portal, Stripe payments, login page, subscription,
  Shadowfront/history/approval fixes.
- **2026-08-06** — deterministic session ids, readable session ids, static
  login, pricing plan, auto-enroll, transfers.
- **2026-08-05** — badges (initial), Stats KPI tabs, misc fixes.
