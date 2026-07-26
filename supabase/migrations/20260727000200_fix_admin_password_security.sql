-- Migration: Fix gm_admin_list to not return passwords in plaintext
-- Creates gm_get_account_password(p_id) for secure on-demand password retrieval
--
-- SECURITY FIX (C8): gm_admin_list was returning the decrypted password in every list call,
-- causing it to appear in DB logs and be stored in the HTML DOM (data-acc-pass attribute).
-- SECURITY FIX (C4): Frontend stored password in HTML attribute, visible via DevTools.

-- 1. Replace gm_admin_list to no longer return the password column
CREATE OR REPLACE FUNCTION public.gm_admin_list()
RETURNS TABLE(id text, role text, guild text, auth_user_id uuid, created_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    a.id,
    coalesce(a.role, 'R4'),
    a.guild,
    a.auth_user_id,
    a.created_at
  FROM public.accounts a
  ORDER BY a.id;
$$;

-- 2. Create gm_get_account_password: secure on-demand password retrieval
--    Only service_role may call this function (called via Edge Function after auth check)
CREATE OR REPLACE FUNCTION public.gm_get_account_password(p_id text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT extensions.pgp_sym_decrypt(
    a.password_enc,
    (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
  )
  FROM public.accounts a
  WHERE a.id = p_id
  LIMIT 1;
$$;

-- 3. Lock down: only service_role may call gm_get_account_password
REVOKE ALL ON FUNCTION
  public.gm_admin_list(),
  public.gm_get_account_password(text)
FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.gm_admin_list(),
  public.gm_get_account_password(text)
TO service_role;
