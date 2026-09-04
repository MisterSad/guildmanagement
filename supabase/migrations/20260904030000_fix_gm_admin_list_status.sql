-- 20260904030000_fix_gm_admin_list_status.sql
-- Workstream: Fix pending player registration visibility for guild admins
--
-- Root Cause:
-- 1. gm_admin_list() omitted the `status` column from its RETURNS TABLE definition.
--    This caused pending accounts returned to the client to lack `status`, so
--    renderPendingRegistrations filter (acc.status === 'pending') always evaluated to false.
-- 2. gm_admin_list() contained caller-authorization checks using auth.uid()
--    (is_super_admin / gm_can_read_guild_data). Since its sole caller is the
--    admin-accounts Edge Function (invoking it with the service_role key where
--    auth.uid() is NULL), both checks failed and returned 0 rows.
--
-- Fix:
-- 1. Drop and recreate gm_admin_list() returning `status text`.
-- 2. Query accounts directly (service_role only). Admin authorization and
--    tenant-scoping is strictly enforced server-side by the admin-accounts Edge
--    Function (_shared/admin-authz.ts).
-- 3. Revoke from public, anon, authenticated and grant exclusively to service_role.

DROP FUNCTION IF EXISTS public.gm_admin_list();

CREATE OR REPLACE FUNCTION public.gm_admin_list()
RETURNS TABLE(
    id text,
    role text,
    guild text,
    uid text,
    status text,
    created_at timestamptz,
    has_password boolean,
    server_number text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.id,
        COALESCE(a.role, 'member'),
        a.guild,
        a.uid,
        COALESCE(a.status, 'active'),
        a.created_at,
        (a.password_enc IS NOT NULL),
        COALESCE(a.server_number, g.server_number)
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    ORDER BY a.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_admin_list() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_admin_list() TO service_role;

NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
DROP FUNCTION IF EXISTS public.gm_admin_list();
CREATE OR REPLACE FUNCTION public.gm_admin_list()
RETURNS TABLE(id text, role text, guild text, uid text, created_at timestamptz, has_password boolean, server_number text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    IF public.is_super_admin() THEN
        RETURN QUERY
        SELECT a.id, a.role, a.guild, a.uid, a.created_at, (a.password_enc IS NOT NULL), a.server_number
        FROM public.accounts a
        ORDER BY a.created_at DESC;
    ELSE
        RETURN QUERY
        SELECT a.id, a.role, a.guild, a.uid, a.created_at, (a.password_enc IS NOT NULL), a.server_number
        FROM public.accounts a
        WHERE public.gm_can_read_guild_data(a.guild)
        ORDER BY a.created_at DESC;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.gm_admin_list() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_admin_list() TO service_role;
NOTIFY pgrst, 'reload schema';
*/
