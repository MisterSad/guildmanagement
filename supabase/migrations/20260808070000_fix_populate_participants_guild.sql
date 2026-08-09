-- 20260808070000_fix_populate_participants_guild.sql
-- gm_populate_event_participants resolved the target guild from
-- event_status WHERE session_id = p_session_id. With deterministic session
-- ids, the same id (e.g. GVG-2026-W32) is shared by every guild, so the query
-- could resolve an arbitrary guild and enroll the wrong tenant's players.
--
-- The guild is now passed explicitly by the client (p_guild) and enforced
-- against the caller: guild_admin only their own guild, super_admin any
-- guild they pick, member/anon denied. Fresh OID.

create or replace function public.gm_populate_event_participants(
  p_event_name text,
  p_session_id text,
  p_week_start date,
  p_guild text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
  v_target_guild text;
  v_caller_role text;
  v_caller_guild text;
begin
  if p_event_name is null or p_session_id is null or p_week_start is null then
    raise exception 'event_name, session_id and week_start are required';
  end if;

  select role, guild into v_caller_role, v_caller_guild
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_caller_role is null or v_caller_role = 'member' then
    raise exception 'not_authorized';
  end if;

  -- guild_admin may only enroll their own guild; super_admin may enroll the
  -- guild they are currently viewing.
  if v_caller_role = 'guild_admin' then
    v_target_guild := coalesce(v_caller_guild, 'ALPHA');
    if upper(p_guild) <> v_target_guild then
      raise exception 'not_authorized';
    end if;
  else
    v_target_guild := coalesce(upper(p_guild), 'ALPHA');
  end if;

  with ins as (
    insert into public.event_participants (guild, event_name, week_start, session_id, pseudo, participated, score)
    select v_target_guild, p_event_name, p_week_start, p_session_id, gm.pseudo, 0, null
    from public.guild_members gm
    where gm.guild = v_target_guild
      and not exists (
        select 1 from public.event_participants ep
        where ep.guild = v_target_guild
          and ep.event_name = p_event_name
          and ep.session_id = p_session_id
          and ep.pseudo = gm.pseudo
      )
    returning 1
  )
  select count(*) into inserted_count from ins;

  return inserted_count;
end;
$$;

revoke all on function public.gm_populate_event_participants(text, text, date, text)
  from public, anon;
grant execute on function public.gm_populate_event_participants(text, text, date, text)
  to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
