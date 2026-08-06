-- 20260807030000_player_glory_and_personal_kpis.sql
-- Player Portal: self-service Glory entry + advanced personal KPIs.
--
--   1. gm_upsert_player_glory: upserts the player's weekly Glory row in
--      event_participants (event_name='Glory', no session_id). The partial
--      unique index event_participants_no_session_unique
--      (guild,event_name,week_start,pseudo) WHERE session_id IS NULL cannot
--      be inferred by an ON CONFLICT column list, so the upsert runs here in
--      native SQL with the explicit partial-index inference.
--      SECURITY DEFINER; the member-portal edge function (service_role)
--      resolves the player's guild+pseudo server-side before calling it.
--
--   2. gm_personal_kpis: computes the player's personal KPIs plus their
--      position relative to the rest of their guild:
--        - power: current, guild max, guild rank, percentile
--        - glory: current week score, best ever, guild rank this week
--        - participation: overall rate + per event type, guild average
--          comparison
--        - tenure: days in guild, role
--      SECURITY DEFINER; called by member-portal only (service_role).

BEGIN;

-- ── 1. Weekly Glory upsert ──────────────────────────────────────────────────
create or replace function public.gm_upsert_player_glory(
  p_guild text,
  p_pseudo text,
  p_week_start text,
  p_glory integer
)
 returns table(ok boolean, error text)
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_guild is null or p_pseudo is null or p_week_start is null then
    return query select false, 'missing_parameters';
    return;
  end if;

  insert into public.event_participants (guild, event_name, week_start, pseudo, participated, score)
  values (p_guild, 'Glory', p_week_start::date, p_pseudo, 1, p_glory)
  on conflict (guild, event_name, week_start, pseudo) where session_id is null do update
    set score = p_glory, participated = 1;

  return query select true, null;
end;
$function$;

revoke all on function public.gm_upsert_player_glory(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.gm_upsert_player_glory(text, text, text, integer)
  to service_role;

-- ── 2. Personal KPIs + guild positioning ───────────────────────────────────
create or replace function public.gm_personal_kpis(p_uid text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_member record;
  v_power_max bigint;
  v_power_rank integer;
  v_power_total integer;
  v_glory_week integer;
  v_glory_best integer;
  v_glory_week_max integer;
  v_glory_rank integer;
  v_glory_counted integer;
  v_days_in_guild integer;
  v_week text;
  v_events_total integer;
  v_events_attended integer;
  v_rate numeric;
  v_guild_avg_rate numeric;
  v_event_rates jsonb;
  v_glory_history jsonb;
  v_result jsonb;
begin
  select pseudo, guild, role, overall_power, created_at into v_member
  from public.guild_members
  where uid = p_uid
  order by created_at desc
  limit 1;

  if v_member.pseudo is null then
    return jsonb_build_object('ok', false, 'error', 'player_not_found');
  end if;

  -- Power rank within the guild (higher power = better rank; ties share rank).
  select count(*) into v_power_total
  from public.guild_members where guild = v_member.guild;

  select coalesce(max(overall_power), 0) into v_power_max
  from public.guild_members where guild = v_member.guild;

  select count(*) + 1 into v_power_rank
  from public.guild_members
  where guild = v_member.guild
    and overall_power > coalesce(v_member.overall_power, 0);

  -- Tenure.
  v_days_in_guild := coalesce(
    (extract(epoch from (now() - v_member.created_at)) / 86400)::integer,
    0
  );

  -- Glory: current week, best ever, this-week rank.
  v_week := to_char(date_trunc('week', now())::date, 'YYYY-MM-DD');

  select score into v_glory_week
  from public.event_participants
  where guild = v_member.guild
    and event_name = 'Glory'
    and week_start = v_week::date
    and lower(pseudo) = lower(v_member.pseudo)
  limit 1;

  select max(score) into v_glory_best
  from public.event_participants
  where guild = v_member.guild
    and event_name = 'Glory'
    and lower(pseudo) = lower(v_member.pseudo);

  select max(score) into v_glory_week_max
  from public.event_participants
  where guild = v_member.guild
    and event_name = 'Glory'
    and week_start = v_week::date;

  select count(*) + 1 into v_glory_rank
  from public.event_participants
  where guild = v_member.guild
    and event_name = 'Glory'
    and week_start = v_week::date
    and coalesce(score, 0) > coalesce(v_glory_week, 0);

  -- Glory history (last 12 weeks, newest first).
  select coalesce(jsonb_agg(jsonb_build_object(
    'week_start', to_char(ep.week_start, 'YYYY-MM-DD'),
    'score', ep.score
  ) order by ep.week_start desc), '[]'::jsonb) into v_glory_history
  from (
    select week_start, score
    from public.event_participants
    where guild = v_member.guild
      and event_name = 'Glory'
      and lower(pseudo) = lower(v_member.pseudo)
      and week_start is not null
    order by week_start desc
    limit 12
  ) ep;

  -- Participation: overall + per event type (Glory excluded).
  select count(*), count(*) filter (where participated > 0 or sub_present)
    into v_events_total, v_events_attended
  from public.event_participants
  where guild = v_member.guild
    and lower(pseudo) = lower(v_member.pseudo)
    and lower(event_name) <> 'glory';

  v_rate := case when v_events_total > 0
    then round((v_events_attended::numeric / v_events_total) * 100)
    else 0 end;

  -- Guild average participation rate (per member, same event set).
  select round(avg(r.rate)) into v_guild_avg_rate
  from (
    select
      count(*) filter (where ep.participated > 0 or ep.sub_present)::numeric
        / nullif(count(*), 0) * 100 as rate
    from public.event_participants ep
    where ep.guild = v_member.guild
      and lower(ep.event_name) <> 'glory'
    group by ep.pseudo
  ) r;

  -- Per-event-type participation rate for the player.
  select coalesce(jsonb_object_agg(
    evt.event_key,
    jsonb_build_object(
      'count', evt.total,
      'attended', evt.attended,
      'rate', case when evt.total > 0
        then round((evt.attended::numeric / evt.total) * 100)
        else 0 end
    )
  ), '{}'::jsonb) into v_event_rates
  from (
    select
      upper(ep.event_name) as event_key,
      count(*) as total,
      count(*) filter (where ep.participated > 0 or ep.sub_present) as attended
    from public.event_participants ep
    where ep.guild = v_member.guild
      and lower(ep.pseudo) = lower(v_member.pseudo)
      and lower(ep.event_name) <> 'glory'
    group by upper(ep.event_name)
  ) evt;

  v_result := jsonb_build_object(
    'ok', true,
    'pseudo', v_member.pseudo,
    'guild', v_member.guild,
    'role', v_member.role,
    'days_in_guild', v_days_in_guild,
    'power', jsonb_build_object(
      'current', coalesce(v_member.overall_power, 0),
      'guild_max', v_power_max,
      'rank', v_power_rank,
      'members', v_power_total,
      'percentile', case when v_power_total > 0
        then round((1 - ((v_power_rank - 1)::numeric / v_power_total)) * 100)
        else 0 end
    ),
    'glory', jsonb_build_object(
      'current_week', v_glory_week,
      'best_ever', v_glory_best,
      'guild_max_week', v_glory_week_max,
      'rank', v_glory_rank,
      'history', v_glory_history
    ),
    'participation', jsonb_build_object(
      'total', v_events_total,
      'attended', v_events_attended,
      'rate', v_rate,
      'guild_avg_rate', v_guild_avg_rate,
      'per_event', v_event_rates
    )
  );

  return v_result;
end;
$function$;

revoke all on function public.gm_personal_kpis(text)
  from public, anon, authenticated;
grant execute on function public.gm_personal_kpis(text)
  to service_role;

COMMIT;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
