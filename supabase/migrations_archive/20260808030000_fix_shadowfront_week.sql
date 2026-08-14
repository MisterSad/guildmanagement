-- 20260808030000_fix_shadowfront_week.sql
-- gm_sync_shadowfront_participants resolved the week from
-- p_session_id::timestamptz, but session_id is now a human-readable key
-- (SF1-20260802, ...). The week is derived from the squad's event_status
-- start_at (battle date) falling back to updated_at, matching the client's
-- getWeekStart().

create or replace function public.gm_sync_shadowfront_participants(p_guild text, p_session_id text)
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_caller_role text;
  v_caller_guild text;
  v_target text;
  v_inserted integer;
  v_week date;
begin
  if p_guild is null or p_session_id is null or p_session_id = '' then
    raise exception 'missing_parameters';
  end if;

  select role, guild into v_caller_role, v_caller_guild
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_caller_role is null or v_caller_role = 'member' then
    raise exception 'not_authorized';
  end if;

  if v_caller_role = 'guild_admin' then
    v_target := coalesce(v_caller_guild, 'ALPHA');
    if p_guild <> v_target then
      raise exception 'not_authorized';
    end if;
  else
    v_target := coalesce(upper(p_guild), 'ALPHA');
  end if;

  -- Resolve the week from the squad's battle date (start_at) or, when the
  -- admin never picked one, the event_status row updated_at. Same semantics
  -- as the client's getWeekStart().
  select (date_trunc('week', coalesce(es.start_at, es.updated_at) at time zone 'UTC'))::date
    into v_week
  from public.event_status es
  where es.guild = v_target
    and es.session_id = p_session_id
  limit 1;

  if v_week is null then
    raise exception 'session_not_found';
  end if;

  with ins as (
    insert into public.event_participants (guild, event_name, session_id, week_start, pseudo, participated)
    select
      v_target,
      'Shadowfront',
      p_session_id,
      v_week,
      s.pseudo,
      0
    from public.shadowfront_squads s
    where s.guild = v_target
      and s.session_id = p_session_id
    on conflict (guild, event_name, session_id, pseudo) where session_id is not null do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return coalesce(v_inserted, 0);
end;
$function$;

revoke all on function public.gm_sync_shadowfront_participants(text, text)
  from public, anon, authenticated;
grant execute on function public.gm_sync_shadowfront_participants(text, text)
  to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
