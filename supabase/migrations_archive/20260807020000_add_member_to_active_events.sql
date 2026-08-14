-- 20260807020000_add_member_to_active_events.sql
-- Reliable auto-enrollment of a newly added member into every active event
-- of their guild.
--
-- The client-side addMemberToActiveEvents (events.js / armsrace.js) relied on
-- in-memory UI state, so a member added before ever visiting an event tab
-- (or when the Arms Race stage state had not been loaded) was silently not
-- enrolled. This RPC resolves the active sessions from the database instead,
-- so it always matches reality: every event_status row with is_active = true
-- for the member's guild (except Shadowfront, whose participants come from
-- squad assignments).
--
-- Returns the number of events the member was enrolled into.
--
-- Access: super_admin (any guild) or guild_admin (own guild only). member/anon
-- denied. SECURITY DEFINER with search_path '' and qualified public.tables.

create or replace function public.gm_add_member_to_active_events(p_pseudo text, p_guild text)
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_caller_role text;
  v_caller_guild text;
  v_target_guild text;
  v_inserted integer;
begin
  if p_pseudo is null or p_pseudo = '' then
    raise exception 'pseudo_required';
  end if;

  select role, guild into v_caller_role, v_caller_guild
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_caller_role is null or v_caller_role = 'member' then
    raise exception 'not_authorized';
  end if;

  -- guild_admin is restricted to their own guild; super_admin may pass any.
  if v_caller_role = 'guild_admin' then
    v_target_guild := coalesce(v_caller_guild, 'ALPHA');
    if p_guild is not null and p_guild <> '' and p_guild <> v_target_guild then
      raise exception 'not_authorized';
    end if;
  elsif v_caller_role = 'super_admin' then
    v_target_guild := coalesce(upper(p_guild), 'ALPHA');
  else
    raise exception 'not_authorized';
  end if;

  -- The member must belong to the target guild.
  if not exists (
    select 1 from public.guild_members
    where guild = v_target_guild and lower(pseudo) = lower(p_pseudo)
  ) then
    raise exception 'member_not_in_guild';
  end if;

  -- Enroll into every active session of the guild, skipping Shadowfront
  -- (its participants come from squad assignments, not bulk enrollment).
  -- week_start mirrors the client's getWeekStart(): the Monday (UTC) of the
  -- session's week. date_trunc('week') is ISO-Monday; we force the UTC zone
  -- explicitly so a non-UTC DB session cannot shift the boundary. start_at is
  -- nullable on some rows, so fall back to the session_id timestamp.
  with ins as (
    insert into public.event_participants (guild, event_name, session_id, week_start, pseudo, participated, score)
    select
      v_target_guild,
      es.event_name,
      es.session_id,
      (date_trunc('week', coalesce(es.start_at, es.session_id::timestamptz) at time zone 'UTC'))::date,
      p_pseudo,
      0,
      null
    from public.event_status es
    where es.guild = v_target_guild
      and es.is_active = true
      and es.session_id is not null
      and lower(es.event_name) not like '%shadowfront%'
    on conflict (guild, event_name, session_id, pseudo) where session_id is not null do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return coalesce(v_inserted, 0);
end;
$function$;

revoke all on function public.gm_add_member_to_active_events(text, text)
  from public, anon, authenticated;
grant execute on function public.gm_add_member_to_active_events(text, text)
  to authenticated;

COMMIT;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
