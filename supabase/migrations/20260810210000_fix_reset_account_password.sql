-- 20260810210000_fix_reset_account_password.sql
-- Fix gm_reset_account_password RPC to use password_enc column and pgp_sym_encrypt with vault key.

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

NOTIFY pgrst, 'reload schema';
