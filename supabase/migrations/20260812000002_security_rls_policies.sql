-- ============================================================================
-- FGF GUILD MANAGEMENT — CANONICAL RLS SECURITY POLICIES (Migration 2 of 4)
-- Migration: 20260812000002_security_rls_policies.sql
-- Description: Enable RLS and define multi-tenant isolated access policies.
-- ============================================================================

-- 1. ENABLE ROW LEVEL SECURITY
ALTER TABLE public.guilds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guild_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadowfront_squads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shadowfront_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sanctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banned_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guild_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guild_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_absences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_push_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_reminders_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_notifications_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_name_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gm_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 1.B ACCESS CONTROL HELPERS (Required by RLS Policies)
-- ============================================================================

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
    IF v_role IN ('super_admin', 'server_admin') THEN
        RETURN true;
    END IF;

    -- Check accounts table
    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    RETURN (v_role IN ('super_admin', 'server_admin'));
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
    v_auth_id uuid;
    v_role text;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    RETURN (v_role IN ('super_admin', 'server_admin', 'guild_admin'));
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
    v_user_guild text;
    v_user_server text;
    v_target_server text;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_role, v_user_guild, v_user_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    IF v_role = 'super_admin' THEN
        RETURN true;
    END IF;

    IF v_role = 'server_admin' THEN
        SELECT g2.server_number INTO v_target_server
        FROM public.guilds g2
        WHERE g2.id = p_guild
        LIMIT 1;
        RETURN (v_target_server IS NOT NULL AND v_user_server IS NOT NULL AND v_target_server = v_user_server);
    END IF;

    IF v_role = 'guild_admin' AND v_user_guild = p_guild THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_can_read_account(p_account_id text)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_auth_id uuid;
    v_role text;
    v_user_guild text;
    v_user_server text;
    v_target_guild text;
    v_target_server text;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_role, v_user_guild, v_user_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    IF v_role = 'super_admin' THEN
        RETURN true;
    END IF;

    IF v_role = 'server_admin' THEN
        SELECT a2.guild, COALESCE(a2.server_number, g2.server_number)
        INTO v_target_guild, v_target_server
        FROM public.accounts a2
        LEFT JOIN public.guilds g2 ON g2.id = a2.guild
        WHERE a2.id = p_account_id
        LIMIT 1;
        RETURN (v_target_server IS NOT NULL AND v_user_server IS NOT NULL AND v_target_server = v_user_server);
    END IF;

    IF v_role = 'guild_admin' THEN
        SELECT a2.guild INTO v_target_guild
        FROM public.accounts a2
        WHERE a2.id = p_account_id
        LIMIT 1;
        RETURN (v_target_guild = v_user_guild);
    END IF;

    RETURN (p_account_id = (SELECT a.id FROM public.accounts a WHERE a.auth_user_id = v_auth_id));
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
    v_user_guild text;
    v_user_server text;
    v_target_server text;
BEGIN
    v_auth_id := (SELECT auth.uid());
    IF v_auth_id IS NULL THEN
        RETURN false;
    END IF;

    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_role, v_user_guild, v_user_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    IF v_role = 'super_admin' THEN
        RETURN true;
    END IF;

    IF v_role = 'server_admin' THEN
        SELECT g2.server_number INTO v_target_server
        FROM public.guilds g2
        WHERE g2.id = p_guild
        LIMIT 1;
        RETURN (v_target_server IS NOT NULL AND v_user_server IS NOT NULL AND v_target_server = v_user_server);
    END IF;

    IF v_role = 'guild_admin' AND v_user_guild = p_guild THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.check_user_guild_access(p_guild text)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    RETURN public.check_user_guild_write_access(p_guild);
END;
$$;

CREATE OR REPLACE FUNCTION public.is_subscription_active(p_guild text)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_sub_type text;
    v_sub_end timestamptz;
BEGIN
    IF public.is_super_admin() THEN
        RETURN true;
    END IF;

    SELECT g.subscription_type, g.subscription_end INTO v_sub_type, v_sub_end
    FROM public.guilds g
    WHERE g.id = p_guild
    LIMIT 1;

    IF v_sub_type IN ('Unlimited', 'Lifetime') THEN
        RETURN true;
    END IF;

    IF v_sub_type = 'Premium' AND v_sub_end IS NOT NULL AND v_sub_end > now() THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_can_admin_see_absences(p_guild text)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    RETURN public.gm_can_read_guild_data(p_guild);
END;
$$;

-- ============================================================================
-- 2. GUILDS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_guilds_select ON public.guilds;
CREATE POLICY gm_guilds_select ON public.guilds
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guilds());

DROP POLICY IF EXISTS gm_guilds_insert ON public.guilds;
CREATE POLICY gm_guilds_insert ON public.guilds
    FOR INSERT TO authenticated
    WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS gm_guilds_update ON public.guilds;
CREATE POLICY gm_guilds_update ON public.guilds
    FOR UPDATE TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS gm_guilds_delete ON public.guilds;
CREATE POLICY gm_guilds_delete ON public.guilds
    FOR DELETE TO authenticated
    USING (public.is_super_admin());

-- ============================================================================
-- 3. ACCOUNTS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_accounts_select ON public.accounts;
CREATE POLICY gm_accounts_select ON public.accounts
    FOR SELECT TO authenticated
    USING (public.gm_can_read_account(id));

DROP POLICY IF EXISTS gm_accounts_update ON public.accounts;
CREATE POLICY gm_accounts_update ON public.accounts
    FOR UPDATE TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

-- ============================================================================
-- 4. GUILD MEMBERS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.guild_members;
CREATE POLICY gm_authenticated_select ON public.guild_members
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_authenticated_insert ON public.guild_members;
CREATE POLICY gm_authenticated_insert ON public.guild_members
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.guild_members;
CREATE POLICY gm_authenticated_update ON public.guild_members
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_delete ON public.guild_members;
CREATE POLICY gm_authenticated_delete ON public.guild_members
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 5. EVENT STATUS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.event_status;
CREATE POLICY gm_authenticated_select ON public.event_status
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_authenticated_insert ON public.event_status;
CREATE POLICY gm_authenticated_insert ON public.event_status
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.event_status;
CREATE POLICY gm_authenticated_update ON public.event_status
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_delete ON public.event_status;
CREATE POLICY gm_authenticated_delete ON public.event_status
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 6. EVENT PARTICIPANTS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.event_participants;
CREATE POLICY gm_authenticated_select ON public.event_participants
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_authenticated_insert ON public.event_participants;
CREATE POLICY gm_authenticated_insert ON public.event_participants
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.event_participants;
CREATE POLICY gm_authenticated_update ON public.event_participants
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_delete ON public.event_participants;
CREATE POLICY gm_authenticated_delete ON public.event_participants
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 7. SHADOWFRONT SQUADS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.shadowfront_squads;
CREATE POLICY gm_authenticated_select ON public.shadowfront_squads
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_authenticated_insert ON public.shadowfront_squads;
CREATE POLICY gm_authenticated_insert ON public.shadowfront_squads
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.shadowfront_squads;
CREATE POLICY gm_authenticated_update ON public.shadowfront_squads
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_delete ON public.shadowfront_squads;
CREATE POLICY gm_authenticated_delete ON public.shadowfront_squads
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 8. SHADOWFRONT SIGNUPS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.shadowfront_signups;
CREATE POLICY gm_authenticated_select ON public.shadowfront_signups
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_authenticated_insert ON public.shadowfront_signups;
CREATE POLICY gm_authenticated_insert ON public.shadowfront_signups
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.shadowfront_signups;
CREATE POLICY gm_authenticated_update ON public.shadowfront_signups
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_delete ON public.shadowfront_signups;
CREATE POLICY gm_authenticated_delete ON public.shadowfront_signups
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 9. WEEKLY SCORES POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.weekly_scores;
CREATE POLICY gm_authenticated_select ON public.weekly_scores
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_authenticated_insert ON public.weekly_scores;
CREATE POLICY gm_authenticated_insert ON public.weekly_scores
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.weekly_scores;
CREATE POLICY gm_authenticated_update ON public.weekly_scores
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_delete ON public.weekly_scores;
CREATE POLICY gm_authenticated_delete ON public.weekly_scores
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 10. SANCTIONS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.sanctions;
CREATE POLICY gm_authenticated_select ON public.sanctions
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_authenticated_insert ON public.sanctions;
CREATE POLICY gm_authenticated_insert ON public.sanctions
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.sanctions;
CREATE POLICY gm_authenticated_update ON public.sanctions
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_delete ON public.sanctions;
CREATE POLICY gm_authenticated_delete ON public.sanctions
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 11. BANNED PLAYERS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.banned_players;
CREATE POLICY gm_authenticated_select ON public.banned_players
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_authenticated_insert ON public.banned_players;
CREATE POLICY gm_authenticated_insert ON public.banned_players
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.banned_players;
CREATE POLICY gm_authenticated_update ON public.banned_players
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_delete ON public.banned_players;
CREATE POLICY gm_authenticated_delete ON public.banned_players
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 12. GUILD TRANSFERS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.guild_transfers;
CREATE POLICY gm_authenticated_select ON public.guild_transfers
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(source_guild) OR public.gm_can_read_guild_data(target_guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.guild_transfers;
CREATE POLICY gm_authenticated_update ON public.guild_transfers
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(target_guild) AND public.is_subscription_active(target_guild))
    WITH CHECK (public.check_user_guild_write_access(target_guild) AND public.is_subscription_active(target_guild));

-- ============================================================================
-- 13. GUILD CONFIG POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.guild_config;
CREATE POLICY gm_authenticated_select ON public.guild_config
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_guild_config_insert ON public.guild_config;
CREATE POLICY gm_guild_config_insert ON public.guild_config
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_guild_config_update ON public.guild_config;
CREATE POLICY gm_guild_config_update ON public.guild_config
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_guild_config_delete ON public.guild_config;
CREATE POLICY gm_guild_config_delete ON public.guild_config
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 14. PLAYER ABSENCES POLICIES
-- ============================================================================
DROP POLICY IF EXISTS player_absences_select_policy ON public.player_absences;
CREATE POLICY player_absences_select_policy ON public.player_absences
    FOR SELECT TO authenticated
    USING (
        public.gm_can_admin_see_absences(guild) 
        OR (uid = (((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'account_id'::text))
    );

-- ============================================================================
-- 15. PLAYER PUSH PREFS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS player_push_prefs_own ON public.player_push_prefs;
CREATE POLICY player_push_prefs_own ON public.player_push_prefs
    FOR SELECT TO authenticated
    USING (guild = COALESCE((SELECT a.guild FROM public.accounts a WHERE a.auth_user_id = (SELECT auth.uid())), ''));

DROP POLICY IF EXISTS player_push_prefs_write ON public.player_push_prefs;
CREATE POLICY player_push_prefs_write ON public.player_push_prefs
    FOR INSERT TO authenticated
    WITH CHECK (guild = COALESCE((SELECT a.guild FROM public.accounts a WHERE a.auth_user_id = (SELECT auth.uid())), ''));

DROP POLICY IF EXISTS player_push_prefs_update ON public.player_push_prefs;
CREATE POLICY player_push_prefs_update ON public.player_push_prefs
    FOR UPDATE TO authenticated
    USING (guild = COALESCE((SELECT a.guild FROM public.accounts a WHERE a.auth_user_id = (SELECT auth.uid())), ''))
    WITH CHECK (guild = COALESCE((SELECT a.guild FROM public.accounts a WHERE a.auth_user_id = (SELECT auth.uid())), ''));

-- ============================================================================
-- 16. PLAYER NAME HISTORY POLICIES
-- ============================================================================
DROP POLICY IF EXISTS gm_authenticated_select ON public.player_name_history;
CREATE POLICY gm_authenticated_select ON public.player_name_history
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS gm_authenticated_insert ON public.player_name_history;
CREATE POLICY gm_authenticated_insert ON public.player_name_history
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_update ON public.player_name_history;
CREATE POLICY gm_authenticated_update ON public.player_name_history
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS gm_authenticated_delete ON public.player_name_history;
CREATE POLICY gm_authenticated_delete ON public.player_name_history
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 17. SYSTEM AUDIT LOGS POLICIES
-- ============================================================================
DROP POLICY IF EXISTS audit_logs_insert_policy ON public.system_audit_logs;
CREATE POLICY audit_logs_insert_policy ON public.system_audit_logs
    FOR INSERT TO service_role
    WITH CHECK (true);

DROP POLICY IF EXISTS audit_logs_super_admin_select ON public.system_audit_logs;
CREATE POLICY audit_logs_super_admin_select ON public.system_audit_logs
    FOR SELECT TO authenticated
    USING (public.is_super_admin());

NOTIFY pgrst, 'reload schema';
