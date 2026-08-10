-- 20260810000000_security_hardening_p0.sql
-- Security Hardening P0:
-- 1. Drop lingering DEFAULT 'ALPHA' on tenant tables to enforce strict multi-tenant isolation.
-- 2. Revoke PUBLIC execute on gm_cross_guild_ranking and other sensitive RPCs.
-- 3. Replace gm_get_account_password with gm_reset_account_password (R-02).
-- 4. Fix search_path TO '' on SECURITY DEFINER functions.

-- 1. Drop DEFAULT 'ALPHA' on remaining tenant tables
ALTER TABLE public.guild_members ALTER COLUMN guild DROP DEFAULT;
ALTER TABLE public.event_participants ALTER COLUMN guild DROP DEFAULT;
ALTER TABLE public.event_status ALTER COLUMN guild DROP DEFAULT;
ALTER TABLE public.shadowfront_squads ALTER COLUMN guild DROP DEFAULT;
ALTER TABLE public.weekly_scores ALTER COLUMN guild DROP DEFAULT;
ALTER TABLE public.sanctions ALTER COLUMN guild DROP DEFAULT;
ALTER TABLE public.banned_players ALTER COLUMN guild DROP DEFAULT;

-- 2. Revoke PUBLIC EXECUTE on gm_cross_guild_ranking
REVOKE ALL ON FUNCTION public.gm_cross_guild_ranking() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_cross_guild_ranking() TO authenticated;

-- 3. Drop plaintext password retrieval RPC and replace with reset password RPC
DROP FUNCTION IF EXISTS public.gm_get_account_password(text);

DROP FUNCTION IF EXISTS public.gm_reset_account_password(text, text);
CREATE OR REPLACE FUNCTION public.gm_reset_account_password(p_id text, p_password text)
 RETURNS table(ok boolean, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_id IS NULL OR p_password IS NULL OR length(trim(p_password)) < 6 THEN
    RETURN QUERY SELECT false, 'invalid_password'::text;
    RETURN;
  END IF;

  UPDATE public.accounts
  SET password_enc = extensions.pgp_sym_encrypt(
        p_password,
        (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
      )
  WHERE id = p_id;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'account_not_found'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_reset_account_password(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_reset_account_password(text, text) TO service_role;

-- 4. Harden search_path TO '' on gm_populate_event_participants_v2
DROP FUNCTION IF EXISTS public.gm_populate_event_participants_v2(text, text, date);
CREATE OR REPLACE FUNCTION public.gm_populate_event_participants_v2(
  p_guild text,
  p_event_name text,
  p_week_start date
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_inserted integer;
  v_session text;
BEGIN
  IF p_guild IS NULL OR p_event_name IS NULL OR p_week_start IS NULL THEN
    RAISE EXCEPTION 'missing_parameters';
  END IF;

  v_session := public.gm_event_session_id(p_event_name, p_week_start);

  WITH ins AS (
    INSERT INTO public.event_participants (guild, event_name, week_start, session_id, pseudo, participated)
    SELECT
      p_guild,
      p_event_name,
      p_week_start,
      v_session,
      gm.pseudo,
      0
    FROM public.guild_members gm
    WHERE gm.guild = p_guild
    ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN coalesce(v_inserted, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_populate_event_participants_v2(text, text, date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_populate_event_participants_v2(text, text, date) TO authenticated;

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
