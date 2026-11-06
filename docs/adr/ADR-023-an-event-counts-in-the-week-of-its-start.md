# ADR-023: An event counts in the week of its start

- **Status**: Accepted
- **Date**: 2026-11-06
- **Supersedes**: none (extends ADR-002)
- **Related**: ADR-002 (session ids), ADR-019 (weekly snapshots), ADR-022 (mutable TAG)

## Context

Every participation row carries a `week_start`, and every weekly figure (Stats,
snapshots, Glory, the player portal, the Discord challenges) groups on it. That
week used to be chosen by whoever wrote the row, mostly the browser, and it fell
back to "now" whenever the start of the session was not at hand:

- ending an Arms Race stage or a Shadowfront squad wrote
  `event_status.start_at = NULL`. `event_status` only holds the *current*
  session, so the start of a finished session was then stored nowhere;
- every later write for that session, such as an OCR import, a history edit or
  a member added, sent `getWeekStart(start_at || new Date())`: the week the
  officer was typing in, not the week the event ran;
- `gm_add_member_to_active_events` fell back to `updated_at`.
  `gm_upsert_daily_scores` and `gm_sync_shadowfront_participants` fell back
  to `now()`. A transfer wrote `start_at::date`, which is not a Monday;
- `gm_upsert_war_session` stamped `now()` over the war start on every save
  (audit EVT-02).

Measured on production, 2026-11-06:

| Symptom | Count |
|---|---|
| Sessions split across two weeks | 12 (1,500 rows) |
| Rows whose `week_start` is not a Monday | 34 |
| Shadowfront squad rows filed before their session | 234 (one to six weeks early) |
| War sessions dated outside their own ISO week | 19 of 91 |

A session started on a Sunday in week 44 and closed on the Monday of week 45
was therefore counted, wholly or partly, in week 45.

## Decision

Owner decisions, 2026-11-06:

1. **Every session has a start date and time, and it is mandatory.** The
   existing start dialog (day + time, UTC) is required for every event,
   including SvS and GvG.
2. **A session counts in the ISO week (Monday 00:00 UTC) of its start.** That
   holds whenever it is closed and whenever its scores are typed.
3. **UTC is the reference**, as everywhere else in the app. A start on Monday
   01:00 Paris time is Sunday 23:00 UTC, so it counts in the previous week.
4. **Correcting the start moves the session.** Every row of the session follows
   the new start to its week.

### Implementation (`20261106145045_event_sessions_week_attribution`)

- **A registry, `event_sessions`.** It holds one row per `(guild, session_id)`,
  with the start (`start_at`), the week it implies (`week_start`, set by
  trigger, always a Monday), where the start came from (`start_source`:
  `officer`, `derived` or `backfill`) and `ended_at`.
  - A session id is unique per guild across events, thanks to the
    `ARA-/ARB-/DTR-/SF1-/SF2-` + date and `SVS-/GVG-/GLORY-` + ISO week
    prefixes of ADR-002.
  - The table is private: RLS is forced, there is no policy and no grant to the
    API roles.
  - It follows a TAG rename through its FK, per ADR-022.
- **The database decides the week, not the caller.** Triggers cover every write
  path: RPCs, direct PostgREST writes by `authenticated`, service-role Edge
  Functions and the Discord worker.
  - `event_participants` and `shadowfront_squads` take their session's
    `week_start`. A row for an unknown session registers it, with the start its
    id implies. A row with no session (legacy Glory) is normalised to its
    Monday.
  - `war_sessions` takes its session's `start_at`.
  - `event_status` writes the start an officer picked into the registry. An
    update that sends `start_at = NULL` for the same session keeps the start.
  - Changing a session's `start_at` in the registry moves its participation
    rows, squad rows and war session.
- **Constraints.** `week_start` must be a Monday (`isodow = 1`) on both tables,
  and a running session must have a start.
- **Server-side lifecycle.**
  - `gm_start_event_session` requires the start, bounded to the last 60 days
    or the next 14. It builds the id from that start, with the same-day suffix
    (EVT-05), and refuses an event that is already running.
  - `gm_end_event_session` keeps the start and refuses a stale tab (EVT-07).
  - `gm_reschedule_event_session` moves the registry first and refuses to merge
    into an existing session.
- **The browser** (`EventsView`, `ArmsRaceView`, `ShadowfrontView`) starts and
  ends only through those functions. The start dialog shows, live, the week the
  session will count in.

## Consequences and invariants

- **Never compute a week in the browser for a write.** A `p_week_start`
  argument, where one still exists, is overridden by the trigger. Do not build
  logic on the value you send.
- **Never write `event_status.start_at = NULL` to mean "ended".** End through
  `gm_end_event_session`.
- **A new table that stores per-session rows with a `week_start` must take its
  week from `event_sessions`.** Use the same trigger
  (`gm_rows_take_session_week`), or the row can land in the wrong week again.
- **The registry is the start of record.** `event_status.start_at` is the
  current session's copy, and `war_sessions.start_at` is a mirror kept equal
  by trigger.
- **Snapshots of past weeks are not recomputed automatically** when a start is
  corrected later. The migration recomputed the 26 weeks it touched. A
  correction afterwards is reflected in Stats immediately, since Stats reads
  `event_participants`, and in `guild_weekly_snapshots` only for weeks the
  cron recomputes.
- **Not covered: relevés, not events.** `player_metrics_history` (power) and
  `shadowfront_signups` are dated in the week they were taken, which is
  correct for them.
- **Known open item (EVT-06).** Starting a Shadowfront squad moves, rather than
  copies, the previous session's squad rows. Copying would collide with the
  one-squad-per-player-per-week unique key, so it needs its own decision.
- **Tests.** `supabase/tests/13_event_week_attribution.sql` has 29 assertions,
  run on a replayed database. It starts a session on a Sunday at 23:30, closes
  it, then imports by OCR, writes directly and edits the week in a later week;
  every row stays in the start week. `tests/event_week_attribution.test.js`
  covers the browser side.
