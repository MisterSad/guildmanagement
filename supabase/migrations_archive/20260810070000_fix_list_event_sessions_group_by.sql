-- 20260810070000_fix_list_event_sessions_group_by.sql
-- Fixes GROUP BY invalidity in gm_list_event_sessions:
-- Column 3 (session_id) must be coalesce(ep.session_id, ep.week_start::text)
-- and display_name coalesce(es.event_name, ep.event_name) must be in GROUP BY.

drop function if exists public.gm_list_event_sessions(text);
create or replace function public.gm_list_event_sessions(p_guild text default null::text)
 returns table(
   event_name text,
   display_name text,
   session_id text,
   week_start date,
   start_at timestamptz,
   participants integer,
   participated_count integer,
   total_score bigint
 )
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
    v_user_role text;
    v_user_guild text;
    v_target_guild text;
begin
    select role, guild into v_user_role, v_user_guild
    from public.accounts
    where auth_user_id = auth.uid();

    -- Only admins (or super admins) may list sessions; members use the portal.
    if v_user_role is null or v_user_role = 'member' then
        return;
    end if;

    if v_user_role = 'guild_admin' then
        v_target_guild := coalesce(v_user_guild, 'ALPHA');
    else
        v_target_guild := coalesce(p_guild, coalesce(v_user_guild, 'ALPHA'));
    end if;

    return query
    select
        ep.event_name,
        coalesce(es.event_name, ep.event_name) as display_name,
        coalesce(ep.session_id, ep.week_start::text) as session_id,
        min(ep.week_start) as week_start,
        max(es.start_at) as start_at,
        count(*)::integer as participants,
        sum(case when ep.participated > 0 then 1 else 0 end)::integer as participated_count,
        sum(coalesce(ep.score, 0) + coalesce(ep.score_prep, 0) + coalesce(ep.score_pvp, 0))::bigint as total_score
    from public.event_participants ep
    left join public.event_status es
      on es.guild = ep.guild
     and es.session_id = ep.session_id
     and (
       lower(es.event_name) = lower(ep.event_name)
       or (ep.event_name = 'Shadowfront' and es.event_name like 'Shadowfront%')
     )
    where ep.guild = v_target_guild
    group by ep.event_name, coalesce(es.event_name, ep.event_name), coalesce(ep.session_id, ep.week_start::text)
    order by coalesce(
      max(es.start_at),
      case
        when min(coalesce(ep.session_id, '')) ~ '-[0-9]{8}(-[0-9]+)?$'
        then to_timestamp(
               substring(min(ep.session_id) from '-([0-9]{8})'),
               'YYYYMMDD'
             ) at time zone 'UTC'
        else null
      end,
      (min(ep.week_start) || 'T12:00:00')::timestamptz
    ) desc;
end;
$function$;

revoke all on function public.gm_list_event_sessions(text)
  from public, anon, authenticated;
grant execute on function public.gm_list_event_sessions(text)
  to authenticated;

notify pgrst, 'reload schema';
