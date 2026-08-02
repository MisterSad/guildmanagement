-- Migration: fix admin transfer dialog + close public data leaks.
--
-- 1. guilds SELECT: guild_admins must read every guild row to offer sister
--    guilds in the Transfer Member dialog (same-server check). Only player
--    accounts (member) are excluded. Super admins keep full access.
--    (Previous policy gm_can_read_guild_data(id) returned only the admin's
--    own row, breaking the transfer dialog for every non-ALPHA admin.)
-- 2. list_event_sessions / list_event_weeks: revoke anon execute (public
--    leak of event aggregates of any guild) and scope guild_admin to their
--    own guild; other authenticated callers get no data.
-- 3. request_guild_transfer: revoke anon execute (spam vector).
-- 4. check_uid_exists_globally: revoke anon execute (cross-guild UID probe).

-- 1. guilds read for admins
create or replace function public.gm_can_read_guilds()
 returns boolean
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_role text;
begin
  select role into v_role
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_role is null then
    return false;
  end if;

  -- Super admins and guild admins need the guild list (transfers,
  -- subscription views). Player accounts do not.
  return v_role in ('super_admin', 'guild_admin');
end;
$function$;

drop policy if exists gm_authenticated_select on public.guilds;
drop policy if exists "Authenticated users can select guilds" on public.guilds;
create policy gm_authenticated_select on public.guilds
  for select to authenticated
  using (public.gm_can_read_guilds());

-- 2. history/stats RPCs: revoke anon, force guild_admin's own guild
revoke all on function public.list_event_sessions(text) from anon;
revoke all on function public.list_event_weeks(text) from anon;

create or replace function public.list_event_sessions(p_guild text default null::text)
 returns table(event_name text, session_id text, week_start date, participants integer, participated_count integer, total_score bigint)
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
        ep.session_id,
        ep.week_start,
        count(*)::integer as participants,
        sum(case when ep.participated > 0 then 1 else 0 end)::integer as participated_count,
        sum(coalesce(ep.score, 0) + coalesce(ep.score_prep, 0) + coalesce(ep.score_pvp, 0))::bigint as total_score
    from public.event_participants ep
    where ep.guild = v_target_guild
    group by ep.event_name, ep.session_id, ep.week_start
    order by coalesce(ep.session_id, ep.week_start::text || 'T00:00:00.000Z') desc;
end;
$function$;

create or replace function public.list_event_weeks(p_guild text default null::text)
 returns table(week_start date)
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

    if v_user_role is null or v_user_role = 'member' then
        return;
    end if;

    if v_user_role = 'guild_admin' then
        v_target_guild := coalesce(v_user_guild, 'ALPHA');
    else
        v_target_guild := coalesce(p_guild, coalesce(v_user_guild, 'ALPHA'));
    end if;

    return query
    select distinct ep.week_start
    from public.event_participants ep
    where ep.week_start is not null
      and ep.guild = v_target_guild
    order by ep.week_start desc;
end;
$function$;

grant execute on function public.list_event_sessions(text) to authenticated;
grant execute on function public.list_event_weeks(text) to authenticated;

-- 3. transfer request RPC: revoke anon
revoke all on function public.request_guild_transfer(text, text) from anon;

-- 4. UID probe RPC: revoke anon
revoke all on function public.check_uid_exists_globally(text) from anon;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
