# ADR-019: Weekly guild snapshots, and why the aggregate is not member-grain

- **Status**: Accepted
- **Date**: 2026-09-27
- **Supersedes**: none
- **Related**: ADR-003 (multi-tenant invariants), ADR-008 (migration protocol), ADR-018 (GDPR inventory)

## Context

Seven tables reference the roster by name:

```
FOREIGN KEY (guild, pseudo) REFERENCES guild_members(guild, pseudo)
  ON UPDATE CASCADE ON DELETE CASCADE
```

`event_participants`, `player_metrics_history`, `event_daily_scores`,
`sanctions`, `shadowfront_squads`, `shadowfront_signups` and `weekly_scores`.

The consequence is that **removing a member erases their entire history**, and
every historical guild aggregate moves with it. Last month's participation rate
changes when a guild kicks someone today. Nothing warned anyone: the figure
simply differed from the one they saw last week.

The retired "Weekly participation rate" card compounded it by dividing every
historical week by **today's** roster size, so a removal rewrote every past bar
at once.

This is also why roster churn is not measurable: there is no record that a
member ever existed once they are gone, and `system_audit_logs` records no
roster joins or leaves.

## Decision

Freeze one row per guild per week in a new table, `guild_weekly_snapshots`,
written by a cron job every Monday at 03:20 UTC.

**The table is guild-grain and carries no `(guild, pseudo)` foreign key.**

That is the whole decision, and it is not an oversight:

- A **member-grain** snapshot would need the same `(guild, pseudo)` key to stay
  referentially consistent, and would then be destroyed by exactly the cascade
  it exists to survive. It would look like a fix and be none.
- **Dropping the foreign key** from the existing tables was considered and
  rejected. `gm_erase_player` (migration `20260926223300`) is built on
  `ON UPDATE CASCADE` propagating a pseudonymising rename across all seven
  children in one transaction, and that migration's own comments record that an
  earlier version was wrong precisely because it fought the cascade. Erasure
  correctness outranks statistical convenience.

So a member's personal history still goes when the member goes — which is what
the Terms and the privacy notice promise — and **the guild's record of that
week does not**.

**Counts are stored, not scores.** `per_bucket` holds
`{"SvS": {"opp": n, "attendances": n, "members": n}, ...}`. The per-tenant
coefficients stay declared once, in `src/core/config/event-coeffs.ts`
(finding B1), so a past week can be re-weighted later without re-reading
`event_participants`.

**`week_start` is normalised to the ISO Monday.** 14 rows out of 55,739 carry a
`week_start` that is not a Monday; grouping on them raw invents six extra
"weeks" of one or two rows each.

## Consequences

**Good.** Guild history stops moving. Weekly participation, opportunity counts
and median power become stable series. A guild that ran nothing gets a row with
`opportunities = 0`, which distinguishes a quiet week from a missing one.

**The backfill is not clean, and says so.** Rows written for weeks that had
already passed are computed from today's roster: anyone removed before the
backfill ran is already absent from `event_participants` and cannot appear. The
backfill therefore reproduces the bias this table exists to stop. Those rows
carry `source = 'backfill'`; only weeks written by the Monday job from
2026-09-27 onward are contemporaneous records.

**Member-level churn is still not measurable.** This decision does not fix it.
Measuring it would require archiving departed members (a `left_at` column
instead of a delete), which touches all seven foreign keys, the GDPR erasure
path and the OCR departure detection. That is a separate decision, not taken
here.

**Scheduling is load-bearing.** The job runs at 03:20, before the empty-guild
expiry at 03:30, so a guild about to be removed still gets its last week
recorded. (It also ran after the nightly 03:00 rebuild of the DEMO tenant;
that tenant and its rebuild were removed on 2026-10-04.)

**Deny-all.** RLS is enabled and forced with zero policies; the table is
reachable only through `SECURITY DEFINER` functions and `service_role`. Stated
explicitly rather than left as an unexplained silence (finding M4).
