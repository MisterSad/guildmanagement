-- 20260808120000_fix_shadowfront_week_data.sql
-- Backfill: Shadowfront rows whose week_start does not match the battle week
-- encoded in the session id (SF1-20260802 -> week of 2026-08-02). These were
-- produced by the old gm_sync_shadowfront_participants which fell back to
-- updated_at (the sync time) instead of the session date. Applied to every
-- tenant. shadowfront_squads + event_participants are both fixed so the
-- composition and the scoring agree.
--
-- Two-pass update: each affected row first moves to a per-row unique temp
-- date (2099-01-01 + id days) so rows that swap weeks never collide on the
-- unique (guild, week_start, pseudo) index, then the corrected week applies.

begin;

-- Pass 1: move every affected row to a unique temp date.
with target as (
  select id,
         (date_trunc('week', to_date(substring(session_id from '\d{8}$'), 'YYYYMMDD') at time zone 'UTC'))::date as new_week
  from public.shadowfront_squads
  where session_id ~ '-\d{8}$'
    and week_start is distinct from
        (date_trunc('week', to_date(substring(session_id from '\d{8}$'), 'YYYYMMDD') at time zone 'UTC'))::date
)
update public.shadowfront_squads s
set week_start = (date '2099-01-01' + (t.id % 100000)::int)
from target t
where s.id = t.id;

-- Drop rows that collide on (guild, week_start, pseudo) after correction:
-- a player can only be in one squad per week, keep the newest row.
with target as (
  select id, guild, pseudo,
         (date_trunc('week', to_date(substring(session_id from '\d{8}$'), 'YYYYMMDD') at time zone 'UTC'))::date as new_week
  from public.shadowfront_squads
  where session_id ~ '-\d{8}$'
),
dedup as (
  select id,
         row_number() over (partition by guild, new_week, pseudo order by id desc) as rn
  from target
)
delete from public.shadowfront_squads s
using dedup d
where s.id = d.id and d.rn > 1;

-- Pass 2: apply the corrected week.
with target as (
  select id,
         (date_trunc('week', to_date(substring(session_id from '\d{8}$'), 'YYYYMMDD') at time zone 'UTC'))::date as new_week
  from public.shadowfront_squads
  where session_id ~ '-\d{8}$'
)
update public.shadowfront_squads s
set week_start = t.new_week
from target t
where s.id = t.id
  and s.week_start is distinct from t.new_week;

-- event_participants: same correction (only when the event has no
-- admin-chosen battle date, so the session id stays the source of truth).
update public.event_participants ep
set week_start = (date_trunc('week', to_date(substring(ep.session_id from '\d{8}$'), 'YYYYMMDD') at time zone 'UTC'))::date
where ep.event_name = 'Shadowfront'
  and ep.session_id ~ '-\d{8}$'
  and ep.week_start is distinct from
      (date_trunc('week', to_date(substring(ep.session_id from '\d{8}$'), 'YYYYMMDD') at time zone 'UTC'))::date
  and not exists (
    select 1 from public.event_status es
    where es.guild = ep.guild and es.session_id = ep.session_id and es.start_at is not null
  );

commit;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
