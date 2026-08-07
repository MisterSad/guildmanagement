-- 20260807040000_sync_shadowfront_participants.sql
-- Reliable participant sync for Shadowfront squads.
--
-- The client-side syncParticipantRows inserted rows one-by-one from an
-- in-memory squad map and never checked the insert error, so a failed insert
-- silently left a composed squad with zero participants in
-- event_participants (no scores could be entered, nothing in tracking).
--
-- This RPC resolves the assignments straight from shadowfront_squads (the
-- database, not the UI state) and inserts the missing participants with an
-- ON CONFLICT that matches the partial unique index
-- event_participants_session_unique (guild,event_name,session_id,pseudo)
-- WHERE session_id IS NOT NULL.
--
-- Access: super_admin (any guild) or guild_admin (own guild only). member/anon
-- denied. SECURITY DEFINER with search_path '' and public-qualified tables.

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

  -- Resolve the week from the session's own timestamp (same as getWeekStart).
  select (date_trunc('week', p_session_id::timestamptz at time zone 'UTC'))::date into v_week;

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
      and exists (
        select 1 from public.guild_members gm
        where gm.guild = v_target and lower(gm.pseudo) = lower(s.pseudo)
      )
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

COMMIT;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
