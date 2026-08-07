-- 20260807060000_approve_participant_submission.sql
-- Reliable approval of player-submitted scores.
--
-- The client previously approved submissions with a direct table update
-- chained on state[tabKey] fields; when those were not the active session,
-- the WHERE matched nothing and is_pending stayed true (silent failure).
--
-- This RPC resolves the active session for the guild+event server-side and
-- clears is_pending for the given player, checking the caller is an admin
-- (super_admin any guild, guild_admin own guild). member/anon denied.
--
-- SECURITY DEFINER with search_path '' and public-qualified tables.

create or replace function public.gm_approve_participant_submission(
  p_guild text,
  p_event_name text,
  p_session_id text,
  p_pseudo text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_caller_role text;
  v_caller_guild text;
  v_target text;
  v_updated integer;
begin
  if p_guild is null or p_event_name is null or p_pseudo is null or p_session_id is null then
    return jsonb_build_object('ok', false, 'error', 'missing_parameters');
  end if;

  select role, guild into v_caller_role, v_caller_guild
  from public.accounts
  where auth_user_id = auth.uid()
     or id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  if v_caller_role is null or v_caller_role = 'member' then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_caller_role = 'guild_admin' then
    v_target := coalesce(v_caller_guild, 'ALPHA');
    if p_guild <> v_target then
      return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;
  else
    v_target := coalesce(upper(p_guild), 'ALPHA');
  end if;

  update public.event_participants
     set is_pending = false
   where guild = v_target
     and event_name = p_event_name
     and session_id = p_session_id
     and lower(pseudo) = lower(p_pseudo);
  get diagnostics v_updated = row_count;

  return jsonb_build_object('ok', true, 'updated', v_updated);
end;
$function$;

revoke all on function public.gm_approve_participant_submission(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.gm_approve_participant_submission(text, text, text, text)
  to authenticated;

COMMIT;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
