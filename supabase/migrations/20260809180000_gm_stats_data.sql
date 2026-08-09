-- 20260809180000_gm_stats_data.sql
-- stats.js used to load event_participants / guild_members / shadowfront_squads
-- straight from the REST API. Supabase truncates anonymous REST results to
-- 1000 rows (no error), and the client never sent an ORDER BY, so the rows
-- returned were always the OLDEST by id. Any tenant with more than 1000
-- non-Glory rows (DEMO, OMEGA, BABE, CLAW, ALPHA) silently lost its recent
-- event data: the Stats page showed stale/partial leaderboards and looked
-- like it "did not update" after scores were entered.
--
-- Fix (SaaS, every tenant): a SECURITY DEFINER RPC returns the full dataset
-- for the caller's guild as JSONB, free of the 1000-row REST cap. Role rules
-- mirror gm_list_event_sessions: guild_admin is forced to their own guild,
-- super_admin may pass any p_guild, member gets nothing.

create or replace function public.gm_stats_data(p_guild text default null::text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
    v_user_role text;
    v_user_guild text;
    v_target_guild text;
    v_members jsonb;
    v_participants jsonb;
    v_glory jsonb;
    v_squads jsonb;
begin
    select role, guild into v_user_role, v_user_guild
    from public.accounts
    where auth_user_id = auth.uid();

    if v_user_role is null or v_user_role = 'member' then
        return null;
    end if;

    if v_user_role = 'guild_admin' then
        v_target_guild := coalesce(v_user_guild, 'ALPHA');
    else
        v_target_guild := coalesce(p_guild, coalesce(v_user_guild, 'ALPHA'));
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
             'pseudo', gm.pseudo,
             'uid', gm.uid
           )), '[]'::jsonb)
      into v_members
    from public.guild_members gm
    where gm.guild = v_target_guild;

    select coalesce(jsonb_agg(jsonb_build_object(
             'pseudo', ep.pseudo,
             'event_name', ep.event_name,
             'week_start', ep.week_start,
             'session_id', ep.session_id,
             'participated', ep.participated,
             'score', ep.score,
             'score_prep', ep.score_prep,
             'score_pvp', ep.score_pvp,
             'is_pending', ep.is_pending,
             'sub_present', ep.sub_present
           )), '[]'::jsonb)
      into v_participants
    from public.event_participants ep
    where ep.guild = v_target_guild
      and ep.event_name <> 'Glory';

    select coalesce(jsonb_agg(jsonb_build_object(
             'pseudo', ep.pseudo,
             'score', ep.score,
             'week_start', ep.week_start
           )), '[]'::jsonb)
      into v_glory
    from public.event_participants ep
    where ep.guild = v_target_guild
      and ep.event_name = 'Glory';

    select coalesce(jsonb_agg(jsonb_build_object(
             'pseudo', sq.pseudo,
             'role', sq.role,
             'week_start', sq.week_start
           )), '[]'::jsonb)
      into v_squads
    from public.shadowfront_squads sq
    where sq.guild = v_target_guild;

    return jsonb_build_object(
        'guild', v_target_guild,
        'members', v_members,
        'participants', v_participants,
        'glory', v_glory,
        'squads', v_squads
    );
end;
$function$;

revoke all on function public.gm_stats_data(text)
  from public, anon, authenticated;
grant execute on function public.gm_stats_data(text)
  to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
