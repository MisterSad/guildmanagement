-- 20260811195000_fix_glory_upsert_auth.sql
--
-- Fixes an issue where `gm_upsert_player_glory` was only executable by
-- `service_role`, preventing guild admins from updating Glory scores from the client.
-- Adds proper RLS equivalent checks inside the SECURITY DEFINER function
-- and grants EXECUTE to `authenticated`.

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

-- Revoke all, then grant to authenticated and service_role
REVOKE ALL ON FUNCTION public.gm_upsert_player_glory(text, text, text, integer)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_glory(text, text, text, integer)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
