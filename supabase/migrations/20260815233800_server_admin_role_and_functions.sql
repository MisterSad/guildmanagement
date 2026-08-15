-- ============================================================================
-- Migration: 20260815233800_server_admin_role_and_functions.sql
-- Description: Apply server_admin role level, server_number column, and gm_update_account_role RPC
-- ============================================================================

-- 1. ADD server_number column to accounts if not present
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS server_number text;

-- 2. ACCESS CONTROL HELPERS

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

    -- Check JWT claims
    v_role := COALESCE(
        (((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'app_role'::text),
        (((SELECT auth.jwt()) -> 'user_metadata'::text) ->> 'app_role'::text)
    );
    IF v_role = 'super_admin' OR v_role = 'R5' OR v_role = 'admin' THEN
        RETURN true;
    END IF;

    -- Check accounts table
    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    RETURN (v_role = 'super_admin' OR v_role = 'R5' OR v_role = 'admin');
END;
$$;

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

    -- Check JWT claims
    v_role := COALESCE(
        (((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'app_role'::text),
        (((SELECT auth.jwt()) -> 'user_metadata'::text) ->> 'app_role'::text)
    );
    IF v_role = 'super_admin' OR v_role = 'R5' OR v_role = 'admin' OR v_role = 'server_admin' THEN
        RETURN true;
    END IF;

    -- Check accounts table
    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    RETURN (v_role = 'super_admin' OR v_role = 'R5' OR v_role = 'admin' OR v_role = 'server_admin');
END;
$$;

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

    -- Check JWT claims first
    v_role := COALESCE(
        (((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'app_role'::text),
        (((SELECT auth.jwt()) -> 'user_metadata'::text) ->> 'app_role'::text)
    );
    IF v_role IN ('super_admin', 'R5', 'admin', 'server_admin', 'guild_admin', 'R4') THEN
        RETURN true;
    END IF;

    -- Check accounts table
    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    RETURN (v_role IN ('super_admin', 'R5', 'admin', 'server_admin', 'guild_admin', 'R4'));
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_can_read_guild_data(p_guild text)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_auth_id uuid;
    v_role text;
    v_guild text;
    v_server_number text;
    v_target_server text;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;

    -- 1. Super Admin: full cross-guild read access
    IF public.is_super_admin() THEN
        RETURN true;
    END IF;

    -- 2. Fetch authoritative account information
    SELECT a.role, a.guild, a.server_number INTO v_role, v_guild, v_server_number
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    IF v_role IS NULL THEN
        RETURN false;
    END IF;

    -- 3. Server Admin: can read any guild sharing their server_number
    IF v_role = 'server_admin' THEN
        IF v_server_number IS NOT NULL THEN
            SELECT g.server_number INTO v_target_server FROM public.guilds g WHERE g.id = p_guild;
            RETURN (v_target_server IS NOT NULL AND v_target_server = v_server_number);
        END IF;
        RETURN false;
    END IF;

    -- 4. Guild Admin: scoped to own tenant only
    IF v_role IN ('guild_admin', 'R4') THEN
        RETURN (v_guild IS NOT NULL AND v_guild = p_guild);
    END IF;

    -- 5. Member / Pending / others: zero direct access to tenant tables
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_user_guild_write_access(p_guild text)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_auth_id uuid;
    v_role text;
    v_guild text;
    v_server_number text;
    v_target_server text;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;

    -- 1. Super Admin has unrestricted write access across all tenants
    IF public.is_super_admin() THEN
        RETURN true;
    END IF;

    -- 2. Fetch authoritative account record
    SELECT a.role, a.guild, a.server_number INTO v_role, v_guild, v_server_number
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    IF v_role IS NULL THEN
        RETURN false;
    END IF;

    -- 3. Server Admin: write access to all guilds on their server
    IF v_role = 'server_admin' THEN
        IF v_server_number IS NOT NULL THEN
            SELECT g.server_number INTO v_target_server FROM public.guilds g WHERE g.id = p_guild;
            RETURN (v_target_server IS NOT NULL AND v_target_server = v_server_number);
        END IF;
        RETURN false;
    END IF;

    -- 4. Guild Admin: write access to their own assigned guild tenant only
    IF v_role IN ('guild_admin', 'R4') THEN
        RETURN (v_guild IS NOT NULL AND v_guild = p_guild);
    END IF;

    -- 5. Members / Pending: Zero direct write access
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_update_account_role(
    p_id text,
    p_role text,
    p_guild text DEFAULT NULL,
    p_server_number text DEFAULT NULL
)
RETURNS TABLE(ok boolean, role text, server_number text, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_acc record;
    v_target_server text;
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'forbidden'::text;
        RETURN;
    END IF;

    SELECT a.id, a.role, a.guild, a.server_number, a.auth_user_id INTO v_acc
    FROM public.accounts a
    WHERE a.id ILIKE TRIM(p_id);

    IF v_acc.id IS NULL THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, 'not_found'::text;
        RETURN;
    END IF;

    v_target_server := p_server_number;
    IF p_role = 'server_admin' AND v_target_server IS NULL THEN
        IF p_guild IS NOT NULL AND p_guild <> 'ALL' THEN
            SELECT g.server_number INTO v_target_server FROM public.guilds g WHERE g.id = p_guild;
        ELSIF v_acc.guild IS NOT NULL THEN
            SELECT g.server_number INTO v_target_server FROM public.guilds g WHERE g.id = v_acc.guild;
        END IF;
    END IF;

    UPDATE public.accounts
    SET
        role = p_role,
        guild = CASE WHEN p_guild = 'ALL' THEN NULL WHEN p_guild IS NOT NULL THEN p_guild ELSE public.accounts.guild END,
        server_number = COALESCE(v_target_server, public.accounts.server_number)
    WHERE id = v_acc.id;

    RETURN QUERY SELECT true, p_role, v_target_server, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_update_account_role(text, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_update_account_role(text, text, text, text) TO authenticated;
