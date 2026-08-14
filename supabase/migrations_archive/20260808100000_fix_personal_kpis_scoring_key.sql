-- 20260808100000_fix_personal_kpis_scoring_key.sql
-- gm_personal_kpis counted DISTINCT sessions, so Shadowfront (2 squads) and
-- Arms Race (A+B) each counted twice per week. The participation totals and
-- per-type rates now use gm_event_scoring_key: Arms/Shadowfront one per week,
-- DTR per session, SvS/GvG per week. Fresh OID.

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
  select * into v_member
  from public.guild_members
  where uid = p_uid
  order by created_at desc
  limit 1;

  if v_member is null then
    return jsonb_build_object('ok', false, 'error', 'player_not_found');
  end if;

  -- Combat power rank in the guild (including the member).
  select count(*) into v_power_total
  from public.guild_members
  where guild = v_member.guild;

  select count(*) + 1 into v_power_rank
  from public.guild_members
  where guild = v_member.guild
    and coalesce(overall_power, 0) > coalesce(v_member.overall_power, 0);

  select coalesce(max(overall_power), 0) into v_power_max
  from public.guild_members
  where guild = v_member.guild;

  -- Glory: only positive scores count; the player's first-ever positive Glory
  -- week never counts (matches the badge engine).
  select count(*) into v_glory_counted
  from public.event_participants
  where guild = v_member.guild
    and lower(pseudo) = lower(v_member.pseudo)
    and event_name = 'Glory'
    and coalesce(score, 0) > 0;

  -- Current week Glory: only when at least two positive weeks exist.
  select (week_start::text) into v_week
  from public.event_participants
  where guild = v_member.guild
    and lower(pseudo) = lower(v_member.pseudo)
    and event_name = 'Glory'
    and coalesce(score, 0) > 0
  order by week_start desc
  limit 1;

  v_glory_week := null;
  if v_glory_counted > 1 then
    select score into v_glory_week
    from public.event_participants
    where guild = v_member.guild
      and lower(pseudo) = lower(v_member.pseudo)
      and event_name = 'Glory'
      and coalesce(score, 0) > 0
    order by week_start desc
    limit 1;
  end if;

  -- Best Glory ever (positive, excluding the first declaration).
  if v_glory_counted > 1 then
    select max(score) into v_glory_best
    from (
      select score from public.event_participants
      where guild = v_member.guild
        and lower(pseudo) = lower(v_member.pseudo)
        and event_name = 'Glory'
        and coalesce(score, 0) > 0
      order by week_start
      offset 1
    ) g;
  else
    v_glory_best := null;
  end if;

  -- Guild max Glory for the current week (positive scores only).
  select coalesce(max(score), 0) into v_glory_week_max
  from public.event_participants
  where guild = v_member.guild
    and event_name = 'Glory'
    and week_start = (v_week::date)
    and coalesce(score, 0) > 0;

  -- Rank among players with a positive Glory score this week.
  select count(*) + 1 into v_glory_rank
  from public.event_participants
  where guild = v_member.guild
    and event_name = 'Glory'
    and week_start = (v_week::date)
    and coalesce(score, 0) > coalesce(v_glory_week, 0);

  -- Tenure in the guild.
  select floor(extract(epoch from (now() - v_member.created_at)) / 86400)::int
    into v_days_in_guild;

  -- Participation: DISTINCT scoring keys (Glory excluded), overall and per
  -- type. Arms/Shadowfront count once per week, DTR per session.
  select count(distinct public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text)),
         count(distinct public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text)) filter (where ep.participated > 0 or ep.sub_present)
    into v_events_total, v_events_attended
  from public.event_participants ep
  where ep.guild = v_member.guild
    and lower(ep.pseudo) = lower(v_member.pseudo)
    and lower(ep.event_name) <> 'glory';

  v_rate := case when coalesce(v_events_total, 0) > 0
    then round((coalesce(v_events_attended, 0)::numeric / v_events_total) * 100)
    else 0 end;

  -- Guild average participation rate (per member, same key set).
  select round(avg(r.rate)) into v_guild_avg_rate
  from (
    select
      count(distinct public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text)) filter (where ep.participated > 0 or ep.sub_present)::numeric
        / nullif(count(distinct public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text)), 0) * 100 as rate
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
      count(distinct public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text)) as total,
      count(distinct public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text)) filter (where ep.participated > 0 or ep.sub_present) as attended
    from public.event_participants ep
    where ep.guild = v_member.guild
      and lower(ep.pseudo) = lower(v_member.pseudo)
      and lower(ep.event_name) <> 'glory'
    group by upper(ep.event_name)
  ) evt;

  -- Glory history for the charts.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'week', ep.week_start::text,
      'score', ep.score
    ) order by ep.week_start
  ), '[]'::jsonb) into v_glory_history
  from (
    select week_start, score
    from public.event_participants
    where guild = v_member.guild
      and lower(pseudo) = lower(v_member.pseudo)
      and event_name = 'Glory'
      and coalesce(score, 0) > 0
  ) ep;

  v_result := jsonb_build_object(
    'ok', true,
    'pseudo', v_member.pseudo,
    'guild', v_member.guild,
    'power', jsonb_build_object(
      'value', v_member.overall_power,
      'rank', v_power_rank,
      'total', v_power_total,
      'percentile', case when v_power_total > 0
        then round((100.0 * (v_power_total - v_power_rank + 1) / v_power_total))
        else 0 end,
      'guild_max', v_power_max
    ),
    'glory', jsonb_build_object(
      'current_week', v_glory_week,
      'best', v_glory_best,
      'rank', v_glory_rank,
      'guild_max_week', v_glory_week_max,
      'counted_weeks', v_glory_counted
    ),
    'attendance', jsonb_build_object(
      'total', v_events_total,
      'attended', v_events_attended,
      'rate', v_rate,
      'guild_avg_rate', v_guild_avg_rate
    ),
    'event_rates', v_event_rates,
    'tenure_days', v_days_in_guild,
    'glory_history', v_glory_history
  );

  return v_result;
end;
$function$;

revoke all on function public.gm_personal_kpis(text)
  from public, anon, authenticated;
grant execute on function public.gm_personal_kpis(text)
  to service_role;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
