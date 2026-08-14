-- 20260809160000_gm_list_event_sessions_squad_names.sql
-- Shadowfront titles ("Squad One"/"Squad Two") only appeared when the
-- event_status row happened to carry the same session_id as the
-- participants (ALPHA, DEMO). Tenants with event_status.session_id NULL
-- (BABE, CLAW, OMEGA Squad 1, ...) fell back to the generic "Shadowfront"
-- label because the display_name came from a JOIN on event_status.
--
-- Fix (SaaS, every tenant): derive the squad display name from the
-- deterministic session_id itself (SF1-/SF2- prefix), which every
-- Shadowfront row carries, and keep event_status only as a fallback.
-- New OID so PostgREST drops any cached plan.

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
 set search_path to 'public'
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
        -- Squad name derived from the session id (SF1-* => Squad 1,
        -- SF2-* => Squad 2). This no longer depends on event_status carrying
        -- the session_id, so every tenant gets the same "Squad One/Two" titles.
        -- The CASE reads the coalesce expression used by the GROUP BY so the
        -- query stays valid under PostgreSQL's GROUP BY rules.
        case
            when ep.event_name = 'Shadowfront' and coalesce(ep.session_id, ep.week_start::text) like 'SF1%' then 'Shadowfront Squad 1'
            when ep.event_name = 'Shadowfront' and coalesce(ep.session_id, ep.week_start::text) like 'SF2%' then 'Shadowfront Squad 2'
            else coalesce(es.event_name, ep.event_name)
        end as display_name,
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
     -- event_participants uses the scoring identity 'Shadowfront' while
     -- event_status names each squad ('Shadowfront Squad 1/2').
     and (
       lower(es.event_name) = lower(ep.event_name)
       or (ep.event_name = 'Shadowfront' and es.event_name like 'Shadowfront%')
     )
    where ep.guild = v_target_guild
    -- Une session = une ligne (session_id non nul) ; pour les événements sans
    -- session (Glory), une ligne par semaine : on regroupe par session_id OU
    -- par week_start via coalesce.
    group by ep.event_name, es.event_name, coalesce(ep.session_id, ep.week_start::text)
    order by coalesce(max(es.start_at), (min(ep.week_start) || 'T12:00:00')::timestamptz) desc;
end;
$function$;

revoke all on function public.gm_list_event_sessions(text)
  from public, anon, authenticated;
grant execute on function public.gm_list_event_sessions(text)
  to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
