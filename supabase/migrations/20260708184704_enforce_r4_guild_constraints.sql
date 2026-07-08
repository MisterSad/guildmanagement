-- 1. Add CHECK constraint to public.accounts to ensure R4 accounts have a non-empty guild
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS check_r4_has_guild;
ALTER TABLE public.accounts ADD CONSTRAINT check_r4_has_guild CHECK (role = 'R5' OR (role = 'R4' AND guild IS NOT NULL AND guild <> ''));

-- 2. Add case-insensitive unique index on accounts.id
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_lower_id ON public.accounts (lower(id));

-- 3. Replace public.gm_check_login to be case-insensitive and return both canonical ID and role
DROP FUNCTION IF EXISTS public.gm_check_login(text, text);

CREATE OR REPLACE FUNCTION public.gm_check_login(p_id text, p_password text)
RETURNS TABLE (canonical_id text, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.id, COALESCE(a.role, 'R4')
  FROM public.accounts a
  WHERE LOWER(a.id) = LOWER(p_id)
    AND a.password_enc IS NOT NULL
    AND extensions.pgp_sym_decrypt(
          a.password_enc,
          (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
        ) = p_password
  LIMIT 1;
$$;

-- 4. Replace public.gm_admin_upsert to include p_guild parameter
DROP FUNCTION IF EXISTS public.gm_admin_upsert(text, text, text);

CREATE OR REPLACE FUNCTION public.gm_admin_upsert(p_id text, p_password text, p_role text, p_guild text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.accounts(id, role, password_enc, guild, created_at)
  VALUES (
    p_id,
    COALESCE(NULLIF(p_role, ''), 'R4'),
    extensions.pgp_sym_encrypt(p_password, (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')),
    p_guild,
    NOW())
  ON CONFLICT (id) DO UPDATE
    SET role         = COALESCE(NULLIF(p_role, ''), 'R4'),
        password_enc = extensions.pgp_sym_encrypt(p_password, (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')),
        guild        = p_guild;
END $$;

-- 5. Lock down execution: only service_role (used inside Edge Functions) may call these
REVOKE ALL ON FUNCTION public.gm_check_login(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_check_login(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.gm_admin_upsert(text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_admin_upsert(text, text, text, text) TO service_role;
