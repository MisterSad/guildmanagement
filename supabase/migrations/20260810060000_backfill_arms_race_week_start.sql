-- 20260810060000_backfill_arms_race_week_start.sql
-- Before migration 20260809190000 (arms_race_scoring_per_session), the Arms Race
-- scoring key used week_start. Some historical rows may have week_start NULL or
-- mismatched with the actual battle date encoded in the session_id (ARA-YYYYMMDD,
-- ARB-YYYYMMDD).
--
-- This migration recalculates week_start from the YYYYMMDD part of the session_id
-- for all Arms Race rows where the value is missing or inconsistent.
-- This ensures gm_leaderboard and gm_personal_kpis produce correct historical stats.

update public.event_participants
set week_start = (
  date_trunc('week',
    to_date(
      substring(session_id from '-([0-9]{8})'),
      'YYYYMMDD'
    ) at time zone 'UTC'
  )::date
)
where upper(event_name) in ('ARMS RACE STAGE A', 'ARMS RACE STAGE B')
  and session_id ~ '^AR[AB]-[0-9]{8}'
  and (
    week_start is null
    or week_start <> (
      date_trunc('week',
        to_date(
          substring(session_id from '-([0-9]{8})'),
          'YYYYMMDD'
        ) at time zone 'UTC'
      )::date
    )
  );

notify pgrst, 'reload schema';
