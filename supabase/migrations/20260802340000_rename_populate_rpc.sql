-- Migration: rename populate_event_participants -> gm_populate_event_participants.
-- PostgREST kept serving a cached plan of the old (unguarded) version even
-- after CREATE OR REPLACE (same OID), so the caller-guild check was never
-- executed. A new function name forces a new OID and fresh plans. The body
-- is identical to the fixed version (super_admin any guild; guild_admin
-- only their own; member/anon denied).

create or replace function public.gm_populate_event_participants(
  p_event_name text,
  p_session_id text,
  p_week_start date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_count integer;
  v_guild text;
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

  select guild into v_guild
  from event_status
  where event_name = p_event_name and session_id = p_session_id;

  if v_guild is null then
    select guild into v_guild
    from public.accounts
    where auth_user_id = auth.uid();
  end if;

  if v_guild is null then
    v_guild := 'ALPHA';
  end if;

  if v_caller_role = 'guild_admin' and coalesce(v_guild, 'ALPHA') <> coalesce(v_caller_guild, 'ALPHA') then
    raise exception 'not_authorized';
  end if;

  with ins as (
    insert into event_participants (event_name, week_start, session_id, pseudo, guild, participated, score)
    select p_event_name, p_week_start, p_session_id, gm.pseudo, coalesce(gm.guild, v_guild), 0, null
    from guild_members gm
    where coalesce(gm.guild, 'ALPHA') = coalesce(v_guild, 'ALPHA')
      and not exists (
        select 1 from event_participants ep
        where ep.event_name = p_event_name
          and ep.session_id = p_session_id
          and ep.pseudo = gm.pseudo
          and coalesce(ep.guild, 'ALPHA') = coalesce(gm.guild, 'ALPHA')
      )
    returning 1
  )
  select count(*) into inserted_count from ins;

  return inserted_count;
end;
$$;

-- Drop the old cached name (no longer referenced by the frontend after this
-- migration's frontend change is deployed together).
drop function if exists public.populate_event_participants(text, text, date);

revoke all on function public.gm_populate_event_participants(text, text, date) from public, anon;
grant execute on function public.gm_populate_event_participants(text, text, date) to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
