-- Migration: Fix guilds table RLS — restrict mutations to Super Admin (R5) only
-- SECURITY FIX: Previously, any authenticated user could INSERT/UPDATE/DELETE guilds.

-- 1. Create a reusable helper function to check if the current user is R5
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.accounts
    WHERE auth_user_id = auth.uid()
      AND role = 'R5'
  );
$$;

-- Grant only to authenticated (not anon)
REVOKE ALL ON FUNCTION public.is_super_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

-- 2. Drop all existing guilds policies (the broken USING (true) ones)
DROP POLICY IF EXISTS gm_authenticated_select ON public.guilds;
DROP POLICY IF EXISTS gm_authenticated_insert ON public.guilds;
DROP POLICY IF EXISTS gm_authenticated_update ON public.guilds;
DROP POLICY IF EXISTS gm_authenticated_delete ON public.guilds;
DROP POLICY IF EXISTS gm_r5_insert            ON public.guilds;
DROP POLICY IF EXISTS gm_r5_update            ON public.guilds;
DROP POLICY IF EXISTS gm_r5_delete            ON public.guilds;

-- 3. Recreate policies:
--    SELECT: all authenticated users may read guild list (needed for guild selector, transfer dialog)
--    INSERT/UPDATE/DELETE: restricted to R5 (Super Admin) only
CREATE POLICY gm_authenticated_select ON public.guilds
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY gm_r5_insert ON public.guilds
  FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

CREATE POLICY gm_r5_update ON public.guilds
  FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

CREATE POLICY gm_r5_delete ON public.guilds
  FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- Ensure RLS is enabled (should already be, but be explicit)
ALTER TABLE public.guilds ENABLE ROW LEVEL SECURITY;
