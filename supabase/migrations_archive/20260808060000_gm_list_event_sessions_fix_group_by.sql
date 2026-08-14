-- 20260808060000_gm_list_event_sessions_fix_group_by.sql
-- gm_list_event_sessions failed with:
--   column "ep.session_id" must appear in the GROUP BY clause
-- The SELECT exposed ep.session_id while the GROUP BY used
-- coalesce(ep.session_id, ep.week_start::text). PostgreSQL requires the bare
-- column in the GROUP BY. The SELECT now selects the coalesce expression
-- (aliased session_id) so the query parses and the History page works again.
-- Fresh OID so PostgREST drops any cached plan.

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
        -- Afficher le nom du squad (Shadowfront Squad One/Two) quand il existe,
        -- sinon le nom générique de l'événement.
        coalesce(es.event_name, ep.event_name) as display_name,
        -- Group key: session_id when the event is sessioned, else the week.
        -- Selecting the coalesce expression itself (not the bare column) keeps
        -- the query valid under PostgreSQL's GROUP BY rules.
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
