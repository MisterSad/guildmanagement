-- 20260812044000_harden_accounts_and_guilds_rls_helpers.sql
--
-- Clean up all inline auth.jwt() policies on accounts and guilds, replacing
-- them with SECURITY DEFINER helpers as mandated by AGENTS.md rules 3.1 & 3.2.

-- 1. Helper function for accounts read access
CREATE OR REPLACE FUNCTION public.gm_can_read_account(p_account_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT
    -- super_admin can read all accounts
    public.is_super_admin()
    OR
    -- caller reading their own account
    EXISTS (
      SELECT 1 FROM public.accounts
      WHERE auth_user_id = auth.uid()
        AND LOWER(id) = LOWER(p_account_id)
    );
$function$;

REVOKE ALL ON FUNCTION public.gm_can_read_account(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_can_read_account(text) TO authenticated;

-- 2. Ensure accounts table grants and RLS policies use SECURITY DEFINER helpers
GRANT SELECT ON public.accounts TO authenticated;

DROP POLICY IF EXISTS "Users can select their own account" ON public.accounts;
DROP POLICY IF EXISTS "Super admins can update accounts" ON public.accounts;
DROP POLICY IF EXISTS gm_authenticated_select ON public.accounts;
DROP POLICY IF EXISTS gm_authenticated_update ON public.accounts;
DROP POLICY IF EXISTS gm_accounts_select ON public.accounts;
DROP POLICY IF EXISTS gm_accounts_update ON public.accounts;

CREATE POLICY gm_accounts_select ON public.accounts
  FOR SELECT TO authenticated
  USING (public.gm_can_read_account(id));

CREATE POLICY gm_accounts_update ON public.accounts
  FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

-- 3. Ensure guilds table policies are clean and use SECURITY DEFINER helpers
DROP POLICY IF EXISTS "Super admins can manage guilds" ON public.guilds;
DROP POLICY IF EXISTS gm_authenticated_select ON public.guilds;
DROP POLICY IF EXISTS gm_r5_insert ON public.guilds;
DROP POLICY IF EXISTS gm_r5_update ON public.guilds;
DROP POLICY IF EXISTS gm_r5_delete ON public.guilds;
DROP POLICY IF EXISTS gm_guilds_select ON public.guilds;
DROP POLICY IF EXISTS gm_guilds_insert ON public.guilds;
DROP POLICY IF EXISTS gm_guilds_update ON public.guilds;
DROP POLICY IF EXISTS gm_guilds_delete ON public.guilds;

CREATE POLICY gm_guilds_select ON public.guilds
  FOR SELECT TO authenticated
  USING (public.gm_can_read_guilds());

CREATE POLICY gm_guilds_insert ON public.guilds
  FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

CREATE POLICY gm_guilds_update ON public.guilds
  FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

CREATE POLICY gm_guilds_delete ON public.guilds
  FOR DELETE TO authenticated
  USING (public.is_super_admin());

ALTER TABLE public.guilds ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
