-- Migration: 20260814180000_audit_remediation_p0_p1.sql
-- Description: Comprehensive database remediation based on 360 Technical & Security Audit.
--   1. System Audit Logs table for real-time observability.
--   2. Missing Foreign Key covering indexes on high-volume tables.
--   3. Removal of duplicate index on event_status.
--   4. Single optimized SELECT policy on player_absences.
--   5. InitPlan performance optimization on player_push_prefs.
--   6. Automated cleanup helper for guild_config reminder locks.
--   7. Least privilege RPC permission hardening on SECURITY DEFINER helpers.

-- ============================================================================
-- 1. Real-time System Audit Logs Table
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.system_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL CHECK (level IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL')),
  service text NOT NULL,
  correlation_id text,
  guild text,
  user_identifier text,
  message text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  error_details jsonb,
  duration_ms numeric
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_service_level 
  ON public.system_audit_logs (service, level, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_guild 
  ON public.system_audit_logs (guild, created_at DESC);

ALTER TABLE public.system_audit_logs ENABLE ROW LEVEL SECURITY;

-- Only super_admin can query system audit logs via API
DROP POLICY IF EXISTS audit_logs_super_admin_select ON public.system_audit_logs;
CREATE POLICY audit_logs_super_admin_select ON public.system_audit_logs
  FOR SELECT TO authenticated
  USING (
    COALESCE(
      (SELECT auth.jwt() -> 'app_metadata' ->> 'app_role'),
      (SELECT auth.jwt() -> 'user_metadata' ->> 'app_role')
    ) = 'super_admin'
  );

-- Authenticated users and services can insert logs via security definer or insert policy
DROP POLICY IF EXISTS audit_logs_insert_policy ON public.system_audit_logs;
CREATE POLICY audit_logs_insert_policy ON public.system_audit_logs
  FOR INSERT TO authenticated, anon
  WITH CHECK (true);

-- ============================================================================
-- 2. Foreign Key Covering Indexes (SEV-06)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_event_participants_guild_pseudo
  ON public.event_participants (guild, pseudo);

CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_guild_pseudo
  ON public.shadowfront_squads (guild, pseudo);

CREATE INDEX IF NOT EXISTS idx_sanctions_guild_pseudo
  ON public.sanctions (guild, pseudo);

CREATE INDEX IF NOT EXISTS idx_guild_transfers_fkeys
  ON public.guild_transfers (source_guild, target_guild, resolved_by);

CREATE INDEX IF NOT EXISTS idx_shadowfront_signups_pseudo_guild
  ON public.shadowfront_signups (pseudo, guild);

-- ============================================================================
-- 3. Drop Redundant Duplicate Index on event_status (SEV-11)
-- ============================================================================
ALTER TABLE public.event_status 
  DROP CONSTRAINT IF EXISTS event_status_guild_event_name_key;

-- ============================================================================
-- 4. Consolidate Permissive Policies on player_absences (SEV-11)
-- ============================================================================
DROP POLICY IF EXISTS abs_admin_select ON public.player_absences;
DROP POLICY IF EXISTS gm_authenticated_select ON public.player_absences;
DROP POLICY IF EXISTS player_absences_select_policy ON public.player_absences;

CREATE POLICY player_absences_select_policy ON public.player_absences
  FOR SELECT TO authenticated
  USING (
    public.gm_can_admin_see_absences(guild)
    OR uid = (SELECT auth.jwt() -> 'app_metadata' ->> 'account_id')
  );

-- ============================================================================
-- 5. Optimize InitPlan on player_push_prefs (SEV-11)
-- ============================================================================
DROP POLICY IF EXISTS player_push_prefs_own ON public.player_push_prefs;
DROP POLICY IF EXISTS player_push_prefs_write ON public.player_push_prefs;
DROP POLICY IF EXISTS player_push_prefs_update ON public.player_push_prefs;

CREATE POLICY player_push_prefs_own ON public.player_push_prefs
  FOR SELECT TO authenticated
  USING (guild = coalesce((select guild from public.accounts a where a.auth_user_id = (select auth.uid())), ''));

CREATE POLICY player_push_prefs_write ON public.player_push_prefs
  FOR INSERT TO authenticated
  WITH CHECK (guild = coalesce((select guild from public.accounts a where a.auth_user_id = (select auth.uid())), ''));

CREATE POLICY player_push_prefs_update ON public.player_push_prefs
  FOR UPDATE TO authenticated
  USING (guild = coalesce((select guild from public.accounts a where a.auth_user_id = (select auth.uid())), ''))
  WITH CHECK (guild = coalesce((select guild from public.accounts a where a.auth_user_id = (select auth.uid())), ''));

-- ============================================================================
-- 6. Automated Cleanup of Stale guild_config Reminder Locks (SEV-08)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.gm_cleanup_stale_reminder_locks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.guild_config
  WHERE key LIKE 'sent_%'
    AND updated_at < (now() - interval '14 days');
    
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_cleanup_stale_reminder_locks() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_cleanup_stale_reminder_locks() TO authenticated, service_role;

-- ============================================================================
-- 7. Restrict SECURITY DEFINER RPC Privileges (SEV-04)
-- ============================================================================
REVOKE EXECUTE ON FUNCTION public.check_user_guild_access(text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.check_user_guild_write_access(text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.is_subscription_active(text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.gm_can_read_guild_data(text) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.gm_can_read_guilds() FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.prevent_duplicate_member_uid() FROM public, anon;
