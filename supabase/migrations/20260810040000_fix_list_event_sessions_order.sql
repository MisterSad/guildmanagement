-- 20260810040000_fix_list_event_sessions_order.sql
-- Corrige le ORDER BY de gm_list_event_sessions qui castait session_id::timestamptz
-- (invalide pour SF1-20260812, ARA-20260809, DTR-20260812-1, etc.) en fallback.
-- Remplace par extraction regex de la date YYYYMMDD dans le session_id.
-- Les cles hebdomadaires (SVS-2026-W32, GLORY-2026-W32) n'ont pas de date YYYYMMDD
-- et tombent sur le fallback week_start.
-- Ajoute aussi l'index manquant idx_event_status_guild_session.
-- set search_path TO '' (SECURITY DEFINER best practice).

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
        -- Display the squad name (Shadowfront Squad One/Two) when available,
        -- otherwise fall back to the generic event name.
        coalesce(es.event_name, ep.event_name) as display_name,
        ep.session_id,
        min(ep.week_start) as week_start,
        max(es.start_at) as start_at,
        count(*)::integer as participants,
        sum(case when ep.participated > 0 then 1 else 0 end)::integer as participated_count,
        sum(coalesce(ep.score, 0) + coalesce(ep.score_prep, 0) + coalesce(ep.score_pvp, 0))::bigint as total_score
    from public.event_participants ep
    left join public.event_status es
      on es.guild = ep.guild
     and es.session_id = ep.session_id
     -- event_participants uses the scoring identity 'Shadowfront' while
     -- event_status names each squad ('Shadowfront Squad 1/2').
     and (
       lower(es.event_name) = lower(ep.event_name)
       or (ep.event_name = 'Shadowfront' and es.event_name like 'Shadowfront%')
     )
    where ep.guild = v_target_guild
    -- One row per session (non-null session_id); for session-less events (Glory),
    -- one row per week via coalesce(session_id, week_start::text).
    group by ep.event_name, es.event_name, coalesce(ep.session_id, ep.week_start::text)
    order by coalesce(
      -- 1. Prefer the admin-set battle timestamp from event_status
      max(es.start_at),
      -- 2. For daily session IDs (SF1-20260812-1, ARA-20260809, DTR-20260812-2...),
      --    extract the YYYYMMDD part via regex and convert to timestamptz.
      --    Weekly keys (SVS-2026-W32, GLORY-2026-W32) do not match this pattern -> null.
      case
        when min(coalesce(ep.session_id, '')) ~ '-[0-9]{8}(-[0-9]+)?$'
        then to_timestamp(
               substring(min(ep.session_id) from '-([0-9]{8})'),
               'YYYYMMDD'
             ) at time zone 'UTC'
        else null
      end,
      -- 3. Final fallback: week_start (covers SVS, GvG, Glory weekly keys)
      (min(ep.week_start) || 'T12:00:00')::timestamptz
    ) desc;
end;
$function$;

revoke all on function public.gm_list_event_sessions(text)
  from public, anon, authenticated;
grant execute on function public.gm_list_event_sessions(text)
  to authenticated;

-- Missing index: event_status lookups by session_id in JOINs above were doing seq scans
create index if not exists idx_event_status_guild_session
  on public.event_status (guild, session_id);

notify pgrst, 'reload schema';
