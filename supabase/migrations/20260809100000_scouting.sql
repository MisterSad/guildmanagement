-- 20260809100000_scouting.sql
-- Scouting: track rival guild rosters over time (power snapshots) so the
-- super admin can see growth trends and spot transfer targets.
--
-- scouting_snapshots stores one row per (guild, pseudo, capture date).
-- This is intelligence about OTHER guilds, so it is super_admin-only: no
-- tenant scoping, no member/admin access, RLS denies everyone except
-- super_admin (via is_super_admin()).

create table if not exists public.scouting_snapshots (
  id bigint generated always as identity primary key,
  guild text not null,                 -- observed (rival) guild
  pseudo text not null,
  power bigint not null,
  captured_at timestamptz not null default now(),
  note text
);

create index if not exists scouting_snapshots_guild_idx
  on public.scouting_snapshots (guild, captured_at desc);
create index if not exists scouting_snapshots_pseudo_idx
  on public.scouting_snapshots (guild, lower(pseudo));

alter table public.scouting_snapshots enable row level security;

drop policy if exists scouting_snapshots_superadmin on public.scouting_snapshots;
create policy scouting_snapshots_superadmin
  on public.scouting_snapshots
  for all
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

revoke all on public.scouting_snapshots from anon, authenticated;
grant select, insert, update, delete on public.scouting_snapshots to authenticated;
grant usage on sequence scouting_snapshots_id_seq to authenticated;

-- RPC: capture a roster (bulk insert from pasted CSV) as a single snapshot.
create or replace function public.gm_scouting_capture(
  p_guild text,
  p_rows jsonb   -- array of {"pseudo":"...","power":123}
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_inserted integer := 0;
begin
  if not public.is_super_admin() then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_guild is null or p_rows is null or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'error', 'missing_parameters');
  end if;

  insert into public.scouting_snapshots (guild, pseudo, power, captured_at)
  select
    upper(trim(p_guild)),
    trim(x.value->>'pseudo'),
    coalesce((x.value->>'power')::bigint, 0),
    now()
  from jsonb_array_elements(p_rows) x
  where nullif(trim(x.value->>'pseudo'), '') is not null;

  get diagnostics v_inserted = row_count;
  return jsonb_build_object('ok', true, 'inserted', v_inserted);
end;
$function$;

revoke all on function public.gm_scouting_capture(text, jsonb) from public, anon;
grant execute on function public.gm_scouting_capture(text, jsonb) to authenticated;

-- RPC: latest snapshot per player + growth since the previous capture, for a
-- given rival guild.
create or replace function public.gm_scouting_report(p_guild text)
 returns table(
   pseudo text,
   power bigint,
   prev_power bigint,
   delta bigint,
   last_captured timestamptz
 )
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
begin
  if not public.is_super_admin() then
    return;
  end if;

  return query
  with ranked as (
    select
      s.pseudo,
      s.power,
      s.captured_at,
      row_number() over (partition by lower(s.pseudo) order by s.captured_at desc) as rn,
      lag(s.power) over (partition by lower(s.pseudo) order by s.captured_at) as prev
    from public.scouting_snapshots s
    where s.guild = upper(trim(p_guild))
  )
  select
    r.pseudo,
    r.power,
    coalesce(r.prev, 0),
    r.power - coalesce(r.prev, 0),
    r.captured_at
  from ranked r
  where r.rn = 1
  order by r.power desc;
end;
$function$;

revoke all on function public.gm_scouting_report(text) from public, anon;
grant execute on function public.gm_scouting_report(text) to authenticated;

-- RPC: full history for one player (trend chart).
create or replace function public.gm_scouting_history(p_guild text, p_pseudo text)
 returns table(captured_at timestamptz, power bigint)
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
begin
  if not public.is_super_admin() then
    return;
  end if;
  return query
  select s.captured_at, s.power
  from public.scouting_snapshots s
  where s.guild = upper(trim(p_guild))
    and lower(s.pseudo) = lower(trim(p_pseudo))
  order by s.captured_at asc;
end;
$function$;

revoke all on function public.gm_scouting_history(text, text) from public, anon;
grant execute on function public.gm_scouting_history(text, text) to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
