-- 20260810230000_fix_reset_password_case_and_trim.sql
-- Restore original emailFor and password comparison in gm_check_login and gm_reset_account_password.

DROP FUNCTION IF EXISTS public.gm_reset_account_password(text, text);
CREATE OR REPLACE FUNCTION public.gm_reset_account_password(p_id text, p_password text)
 RETURNS TABLE(ok boolean, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_id IS NULL OR p_password IS NULL OR length(p_password) < 6 THEN
    RETURN QUERY SELECT false, 'invalid_password'::text;
    RETURN;
  END IF;

  UPDATE public.accounts
  SET password_enc = extensions.pgp_sym_encrypt(
        p_password,
        (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
      )
  WHERE LOWER(id) = LOWER(p_id);

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'account_not_found'::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_reset_account_password(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_reset_account_password(text, text) TO service_role;

DROP FUNCTION IF EXISTS public.gm_check_login(text, text);
CREATE OR REPLACE FUNCTION public.gm_check_login(p_id text, p_password text)
 RETURNS TABLE(canonical_id text, role text, status text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT a.id,
         COALESCE(a.role, 'member'),
         COALESCE(a.status, 'active')
  FROM public.accounts a
  WHERE LOWER(a.id) = LOWER(p_id)
    AND a.password_enc IS NOT NULL
    AND extensions.pgp_sym_decrypt(
          a.password_enc,
          (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
        ) = p_password
  LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.gm_check_login(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_check_login(text, text) TO service_role;

NOTIFY pgrst, 'reload schema';
