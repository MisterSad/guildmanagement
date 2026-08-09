# Changelog

All notable changes to this project are documented in this file.

`CHANGELOG.md` is rewritten and updated at **every** change: a **New**
section (features) and a **Fixed** section (bug fixes). `DISCORD_CHANGELOG.md`
carries the same information in a Discord-ready format, limited to the last
few hours, with an incrementing number in its title.

---

## New

- **Arms Race scoring: each Stage session counts as one event** (all
  tenants): Stage A and Stage B are now separate participation units, keyed by
  their session id like Defend Trade Route. A guild running two Arms Race
  cycles in one week (e.g. CLAW on 08-05 and 08-08) no longer collapses them
  into a single event: 2 x A + 2 x B in a week = 4 events. The change is
  applied in sync to `window.GM.eventScoringKey`, `gm_event_scoring_key` and
  the member-portal `eventScoringKey`.
- **Stats only count events for the week they take place** (all tenants): an
  event counts in the stats of the week it is scheduled in (Monday to Sunday),
  never in the week it was launched. Sessions planned for a later week (e.g. an
  Arms Race started this week but dated next Monday) are excluded from every
  stats mode until their own week arrives: global leaderboard, single-event
  (SvS/GvG), participation and the Engagement KPI. The week picker no longer
  offers future weeks as the "current" one. Before this fix, a planned event
  with pre-populated members inflated the participation denominator and showed
  an empty "recent" week in Engagement.
- **Stats load the full guild dataset via a server RPC** (all tenants): the
  Stats page now fetches members, participation, Glory and squads through the
  new `gm_stats_data` SECURITY DEFINER RPC instead of raw REST reads. This
  removes the 1000-row limit that silently truncated event data for every
  tenant with more than 1000 rows (DEMO, OMEGA, BABE, CLAW, ALPHA), so recent
  scores and participation always show up. Role rules match the other RPCs:
  `guild_admin` is scoped to their own guild, `super_admin` may pick any, a
  `member` gets nothing.
- **SaaS audit: same event flow for every tenant**: verified that event
  creation (`buildEventSessionId` / `gm_event_session_id`), score recording
  (`score_prep`/`score_pvp` for SvS/GvG, `score` elsewhere) and the history
  rules are identical across ALPHA, BABE, CLAW, DEMO, IMK, OMEGA, YARR. The
  JS and SQL session-id helpers produce the same ids, so no tenant runs a
  different event pipeline.
- **Per-guild payments switch** (all tenants): a new `payments_disabled`
  flag on `guilds` turns off the self-service subscription flow for any
  guild. The Subscription tab is hidden from the sidebar, the subscription
  page shows a "Payments are disabled" notice instead of plan tiles, and
  `gm-create-order` refuses to create a checkout session (server-side
  `payments_disabled` error). The shared helper
  `window.GM.isPaymentsDisabled(guildId)` drives the nav and the page. DEMO,
  the public preview tenant shared in articles, has the flag enabled so
  visitors can never start a real purchase.
- **Shadowfront "Squad One/Two" titles now consistent on every tenant**: the
  history RPC (`gm_list_event_sessions`) used to derive the squad name from a
  JOIN on `event_status`, which only matched when the tenant's event_status
  row carried the same session_id (ALPHA, DEMO). BABE, CLAW, OMEGA, YARR
  fell back to the generic "Shadowfront" label. The display name is now
  derived from the session id itself (SF1-* / SF2-*), so every tenant shows
  the same "Squad One"/"Squad Two" titles.
- **Overview "Glory this week" now shows the gain**: the tile sums the glory
  *gained* this week (each member's current week score minus their previous
  week score, floored at zero) instead of the sum of every cumulative score.
  A new member's first declaration counts in full; the tile meta now reads
  "Gained vs last week".
- **Public DEMO tenant accounts**: `DemoAdmin` (guild admin) and
  `DemoPlayer` (Player Portal, linked to the in-game member KiraIX) let
  anyone preview the tool from a web article. Both log in with the easy
  credential `demo1234`.
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

- **Two Arms Race in the same week counted as one**: the scoring key grouped
  Stage A + B by week, so a guild running 2 cycles in a week (CLAW) showed a
  participation denominator too small (5 instead of 8). Each Stage session now
  counts once, matching how the game actually runs.
- **Future-planned events leaked into current stats**: sessions started this
  week but dated next week (e.g. ARA-20260811) carried a correct future
  `week_start`, but the participation mode, the Engagement KPI and the global
  "all time" mode counted them anyway (inflated denominator, empty future week
  in Engagement). All modes now ignore weeks strictly after the current Monday.
- **Stats page appeared to ignore newly entered scores**: the Supabase REST API
  silently truncates `event_participants` at 1000 rows, and the client never
  sent an ORDER BY, so the rows returned were always the OLDEST by id. Any
  tenant with more than 1000 non-Glory rows (DEMO, OMEGA, BABE, CLAW, ALPHA)
  lost its recent events on the Stats page — exactly what CLAW reported after
  entering all scores. Stats now load the full dataset through `gm_stats_data`.
- **A failed Stats load could freeze the page**: `state.isLoading` was only
  reset on the happy path; an error (network, RPC, render) left it stuck at
  `true`, silently disabling every later Stats reload. The load is now wrapped
  so `isLoading` always clears.
- **BABE current-week Glory had no session id**: 172 Glory rows for the week
  of 2026-08-03 carried `session_id = NULL` (created before Glory rows were
  keyed), unlike every other tenant which uses `GLORY-2026-W32`. A player
  Glory upsert on BABE would have inserted a duplicate row because the
  conflict target is the sessioned index. The missing session id is now
  backfilled so BABE matches the other tenants.
- **Legacy `gm_populate_event_participants` overload could target ALPHA**: the
  3-argument overload fell back to `v_guild := 'ALPHA'` when the guild could
  not be resolved and had a weak authorization check. It was still executable
  by `authenticated`. The frontend only uses the 4-argument overload (explicit
  `p_guild`), so the legacy overload's grants are revoked.
- **Shadowfront history titles missing on some tenants**: BABE, CLAW, OMEGA
  and YARR showed a generic "Shadowfront" label instead of "Squad One"/"Squad
  Two" because the history RPC joined on `event_status`, whose `session_id`
  was NULL for those tenants. The squad name is now read from the session id,
  matching ALPHA's display on every tenant.
- **Overview "Glory this week" showed the sum of all cumulative scores**: the
  tile now computes the glory gained during the week (current week score minus
  previous week score per member, floor at zero), which is what the label
  promises.
- **Payments could be started on the public DEMO tenant**: the Subscription
  tab and the checkout flow are now fully disabled for guilds with the
  `payments_disabled` flag (DEMO). The nav entry, the plan tiles and the
  order-creation edge function are all gated, so a preview visitor cannot
  trigger a real Stripe checkout.
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

- **2026-08-09** — Arms Race per-session scoring, Stats exclude future-planned
  events, Stats full-dataset RPC (1000-row truncation fixed), SaaS audit
  (event flow parity), BABE Glory backfill, legacy populate RPC hardened,
  Shadowfront squad titles fixed for all tenants, Overview Glory-gain fix,
  per-guild payments switch, public DEMO tenant accounts, Scouting feature
  removed (tab, module, DB objects).
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
