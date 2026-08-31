-- 20260831000000_promote_and_extend_gm_stats_data.sql
--
-- gm_stats_data (the RPC the entire Stats page depends on) has only ever
-- existed in supabase/migrations_archive/20260809180000_gm_stats_data.sql —
-- absent from the canonical migration set, the same disaster-recovery gap
-- already found and fixed for 4 other event RPCs in
-- 20260830071000_promote_archived_event_rpcs.sql. Promoting it here.
--
-- While promoting, extending its projection: shadowfront_squads.squad,
-- .session_id and .is_commander, plus event_participants.late, .excused
-- and .appointed all already exist on their tables and are already
-- read/written by the admin UI (shadowfront.js, history.js) — gm_stats_data
-- was simply dropping them before they ever reached the Stats page, making
-- Squad 1 vs 2, Commander status, and lateness/excusal rate impossible to
-- surface there even though the data exists.

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
             'sub_present', ep.sub_present,
             'late', ep.late,
             'excused', ep.excused,
             'appointed', ep.appointed
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
             'week_start', sq.week_start,
             'squad', sq.squad,
             'session_id', sq.session_id,
             'is_commander', sq.is_commander
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
