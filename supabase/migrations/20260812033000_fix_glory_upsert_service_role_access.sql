-- 20260812033000_fix_glory_upsert_service_role_access.sql
--
-- Fixes an issue where `gm_upsert_player_glory` returned `permission_denied`
-- when invoked by `service_role` (Edge Function member-portal).
--
-- Updates `check_user_guild_write_access` to allow `service_role` execution.
-- Updates `gm_upsert_player_glory` to allow execution under `service_role`
-- or an authorized guild_admin/super_admin.

CREATE OR REPLACE FUNCTION public.check_user_guild_write_access(p_guild text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_role  text;
  v_guild text;
BEGIN
  -- Allow service_role (Edge Functions operating on behalf of validated players)
  IF (auth.jwt()->>'role') = 'service_role' OR current_setting('request.jwt.claim.role', true) = 'service_role' THEN
    RETURN true;
  END IF;

  -- Primary lookup: match by GoTrue user id stored in accounts
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  -- Fallback: match by JWT sub (GoTrue uid) when auth_user_id hasn't been synced yet
  IF v_role IS NULL THEN
    SELECT role, guild INTO v_role, v_guild
    FROM public.accounts
    WHERE auth_user_id::text = (auth.jwt()->>'sub');
  END IF;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- super_admin writes everywhere
  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  -- Only guild_admin may write tenant data via API (members use edge functions)
  IF v_role <> 'guild_admin' THEN
    RETURN false;
  END IF;

  RETURN COALESCE(v_guild, '') = COALESCE(p_guild, '');
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_upsert_player_glory(
  p_guild text,
  p_pseudo text,
  p_week_start text,
  p_glory integer
)
 RETURNS TABLE(ok boolean, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_session text;
BEGIN
  IF p_guild IS NULL OR p_pseudo IS NULL OR p_week_start IS NULL THEN
    RETURN QUERY SELECT false, 'missing_parameters';
    RETURN;
  END IF;

  -- Add security checks because this is SECURITY DEFINER and bypasses RLS
  IF NOT public.check_user_guild_write_access(p_guild) THEN
    RETURN QUERY SELECT false, 'permission_denied';
    RETURN;
  END IF;

  IF NOT public.is_subscription_active(p_guild) THEN
    RETURN QUERY SELECT false, 'subscription_expired';
    RETURN;
  END IF;

  v_session := public.gm_event_session_id('Glory', p_week_start::date);

  INSERT INTO public.event_participants (guild, event_name, week_start, pseudo, participated, score, session_id)
  VALUES (p_guild, 'Glory', p_week_start::date, p_pseudo, 1, p_glory, v_session)
  ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO UPDATE
    SET score = p_glory, participated = 1;

  RETURN QUERY SELECT true, null::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_upsert_player_glory(text, text, text, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_glory(text, text, text, integer)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
