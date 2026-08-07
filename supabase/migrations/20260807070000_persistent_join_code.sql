-- 20260807070000_persistent_join_code.sql
-- Each guild gets ONE permanent join code, stored in plain text for display
-- (admins only) plus the SHA-256 hash used to validate player registration.
--
--   guild_config keys:
--     join_code_plain  -> the code itself (readable only by admins of the guild)
--     join_code_hash   -> SHA-256 of the code, used by gm_register_player
--
-- The plain value lives in guild_config whose SELECT/ALL policies are already
-- admin-only (gm_can_read_guild_data), so a player account can never read it.

BEGIN;

-- ── 1. gm_set_join_code: store BOTH the plain code and its hash ─────────────
-- Caller authorization is enforced by the admin-accounts edge function
-- (getCallerInfo). This RPC is invoked with the service role, which has no
-- auth.uid(), so a role check here would always fail.
create or replace function public.gm_set_join_code(p_guild text, p_code text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if p_code is null or length(p_code) < 6 then
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  insert into public.guild_config(guild, key, value, updated_at)
  values (
    p_guild,
    'join_code_plain',
    upper(p_code),
    now()
  )
  on conflict (guild, key) do update
    set value = excluded.value, updated_at = now();

  insert into public.guild_config(guild, key, value, updated_at)
  values (
    p_guild,
    'join_code_hash',
    encode(extensions.digest(upper(p_code), 'sha256'), 'hex'),
    now()
  )
  on conflict (guild, key) do update
    set value = excluded.value, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$function$;

-- ── 2. gm_get_join_code: return the plain code (admins of the guild only) ───
-- Authorization is enforced by the admin-accounts edge function (getCallerInfo
-- restricts to super_admin / the caller's own guild). The RPC itself runs with
-- the service role and returns the plain value to authorized callers only.
create or replace function public.gm_get_join_code(p_guild text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to ''
as $function$
declare
  v_code text;
begin
  select value into v_code
  from public.guild_config
  where guild = p_guild and key = 'join_code_plain';

  return jsonb_build_object('ok', true, 'code', v_code);
end;
$function$;

-- ── 3. Grants (role-gated inside, no anon/public) ────────────────────────────
revoke all on function public.gm_set_join_code(text, text)
  from public, anon, authenticated;
grant execute on function public.gm_set_join_code(text, text)
  to authenticated;

revoke all on function public.gm_get_join_code(text)
  from public, anon, authenticated;
grant execute on function public.gm_get_join_code(text)
  to authenticated;

COMMIT;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
