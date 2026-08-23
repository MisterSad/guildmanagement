-- 20260823050000_role_helpers_remove_user_metadata_fallback.sql
-- Workstream W2: Remove user_metadata role fallback in SQL helpers
--
-- Authoritative role resolution: all authorization helpers now strictly resolve roles
-- from public.accounts WHERE auth_user_id = auth.uid() AND status = 'active'.
-- Eliminates client-forged JWT user_metadata spoofing vectors.
--
-- PRE-DEPLOY VERIFICATION QUERY (detects GoTrue users whose app_metadata differs from accounts):
-- SELECT u.id, u.raw_user_meta_data, a.id AS account_id, a.role, a.status
-- FROM auth.users u LEFT JOIN public.accounts a ON a.auth_user_id = u.id
-- WHERE (u.raw_app_meta_data->>'app_role') IS DISTINCT FROM a.role OR a.id IS NULL;

-- 1. is_super_admin()
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_role text;
    v_auth_id uuid;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    RETURN (v_role = 'super_admin' OR v_role = 'R5' OR v_role = 'admin');
END;
$$;

-- 2. is_server_admin()
CREATE OR REPLACE FUNCTION public.is_server_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_role text;
    v_auth_id uuid;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    RETURN (v_role = 'super_admin' OR v_role = 'R5' OR v_role = 'admin' OR v_role = 'server_admin');
END;
$$;

-- 3. gm_can_read_guilds()
CREATE OR REPLACE FUNCTION public.gm_can_read_guilds()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_role text;
    v_auth_id uuid;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    RETURN (v_role IN ('super_admin', 'R5', 'admin', 'server_admin', 'guild_admin', 'R4'));
END;
$$;

-- 4. Update audit_logs_super_admin_select policy to use is_super_admin()
DROP POLICY IF EXISTS audit_logs_super_admin_select ON public.system_audit_logs;
CREATE POLICY audit_logs_super_admin_select ON public.system_audit_logs
    FOR SELECT TO authenticated
    USING (public.is_super_admin());

-- Grants hygiene
REVOKE ALL ON FUNCTION public.is_super_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

REVOKE ALL ON FUNCTION public.is_server_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_server_admin() TO authenticated;

REVOKE ALL ON FUNCTION public.gm_can_read_guilds() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_can_read_guilds() TO authenticated;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
-- Re-enable fallback if rollback is required:
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_role text; v_auth_id uuid; BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN RETURN false; END IF;
    v_role := (((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'app_role'::text);
    IF v_role = 'super_admin' OR v_role = 'R5' OR v_role = 'admin' THEN RETURN true; END IF;
    SELECT a.role INTO v_role FROM public.accounts a WHERE a.auth_user_id = v_auth_id AND a.status = 'active' LIMIT 1;
    RETURN (v_role = 'super_admin' OR v_role = 'R5' OR v_role = 'admin');
END; $$;
*/
