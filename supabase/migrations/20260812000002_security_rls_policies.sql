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
-- 2. GUILDS POLICIES
-- ============================================================================
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

-- ============================================================================
-- 3. ACCOUNTS POLICIES
-- ============================================================================
CREATE POLICY gm_accounts_select ON public.accounts
    FOR SELECT TO authenticated
    USING (public.gm_can_read_account(id));

CREATE POLICY gm_accounts_update ON public.accounts
    FOR UPDATE TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());

-- ============================================================================
-- 4. GUILD MEMBERS POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.guild_members
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_authenticated_insert ON public.guild_members
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_update ON public.guild_members
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_delete ON public.guild_members
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 5. EVENT STATUS POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.event_status
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_authenticated_insert ON public.event_status
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_update ON public.event_status
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_delete ON public.event_status
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 6. EVENT PARTICIPANTS POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.event_participants
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_authenticated_insert ON public.event_participants
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_update ON public.event_participants
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_delete ON public.event_participants
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 7. SHADOWFRONT SQUADS POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.shadowfront_squads
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_authenticated_insert ON public.shadowfront_squads
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_update ON public.shadowfront_squads
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_delete ON public.shadowfront_squads
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 8. SHADOWFRONT SIGNUPS POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.shadowfront_signups
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_authenticated_insert ON public.shadowfront_signups
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_update ON public.shadowfront_signups
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_delete ON public.shadowfront_signups
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 9. WEEKLY SCORES POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.weekly_scores
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_authenticated_insert ON public.weekly_scores
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_update ON public.weekly_scores
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_delete ON public.weekly_scores
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 10. SANCTIONS POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.sanctions
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_authenticated_insert ON public.sanctions
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_update ON public.sanctions
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_delete ON public.sanctions
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 11. BANNED PLAYERS POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.banned_players
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_authenticated_insert ON public.banned_players
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_update ON public.banned_players
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_delete ON public.banned_players
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 12. GUILD TRANSFERS POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.guild_transfers
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(source_guild) OR public.gm_can_read_guild_data(target_guild));

CREATE POLICY gm_authenticated_update ON public.guild_transfers
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(target_guild) AND public.is_subscription_active(target_guild))
    WITH CHECK (public.check_user_guild_write_access(target_guild) AND public.is_subscription_active(target_guild));

-- ============================================================================
-- 13. GUILD CONFIG POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.guild_config
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_guild_config_insert ON public.guild_config
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_guild_config_update ON public.guild_config
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_guild_config_delete ON public.guild_config
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 14. PLAYER ABSENCES POLICIES
-- ============================================================================
CREATE POLICY player_absences_select_policy ON public.player_absences
    FOR SELECT TO authenticated
    USING (
        public.gm_can_admin_see_absences(guild) 
        OR (uid = (((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'account_id'::text))
    );

-- ============================================================================
-- 15. PLAYER PUSH PREFS POLICIES
-- ============================================================================
CREATE POLICY player_push_prefs_own ON public.player_push_prefs
    FOR SELECT TO authenticated
    USING (guild = COALESCE((SELECT a.guild FROM public.accounts a WHERE a.auth_user_id = (SELECT auth.uid())), ''));

CREATE POLICY player_push_prefs_write ON public.player_push_prefs
    FOR INSERT TO authenticated
    WITH CHECK (guild = COALESCE((SELECT a.guild FROM public.accounts a WHERE a.auth_user_id = (SELECT auth.uid())), ''));

CREATE POLICY player_push_prefs_update ON public.player_push_prefs
    FOR UPDATE TO authenticated
    USING (guild = COALESCE((SELECT a.guild FROM public.accounts a WHERE a.auth_user_id = (SELECT auth.uid())), ''))
    WITH CHECK (guild = COALESCE((SELECT a.guild FROM public.accounts a WHERE a.auth_user_id = (SELECT auth.uid())), ''));

-- ============================================================================
-- 16. PLAYER NAME HISTORY POLICIES
-- ============================================================================
CREATE POLICY gm_authenticated_select ON public.player_name_history
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

CREATE POLICY gm_authenticated_insert ON public.player_name_history
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_update ON public.player_name_history
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

CREATE POLICY gm_authenticated_delete ON public.player_name_history
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 17. SYSTEM AUDIT LOGS POLICIES
-- ============================================================================
CREATE POLICY audit_logs_insert_policy ON public.system_audit_logs
    FOR INSERT TO anon, authenticated
    WITH CHECK (true);

CREATE POLICY audit_logs_super_admin_select ON public.system_audit_logs
    FOR SELECT TO authenticated
    USING (
        COALESCE(
            (((SELECT auth.jwt()) -> 'app_metadata'::text) ->> 'app_role'::text),
            (((SELECT auth.jwt()) -> 'user_metadata'::text) ->> 'app_role'::text)
        ) = 'super_admin'
    );
