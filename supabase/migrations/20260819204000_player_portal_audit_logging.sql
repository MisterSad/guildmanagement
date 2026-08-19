-- 20260819204000_player_portal_audit_logging.sql
-- Enhance public.system_audit_logs for Player Portal submission auditing and real-time observability

-- 1. Add structured player columns to system_audit_logs if not already present
ALTER TABLE public.system_audit_logs 
  ADD COLUMN IF NOT EXISTS pseudo text,
  ADD COLUMN IF NOT EXISTS uid text,
  ADD COLUMN IF NOT EXISTS server_number text,
  ADD COLUMN IF NOT EXISTS action_type text;

-- 2. Create high-performance B-tree indexes for multi-tenant filtering and search
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.system_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_guild_created ON public.system_audit_logs (guild, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_pseudo ON public.system_audit_logs (pseudo);
CREATE INDEX IF NOT EXISTS idx_audit_logs_uid ON public.system_audit_logs (uid);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_type ON public.system_audit_logs (action_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_service ON public.system_audit_logs (service);

-- 3. Update RLS policies on system_audit_logs
DROP POLICY IF EXISTS audit_logs_super_admin_select ON public.system_audit_logs;
CREATE POLICY audit_logs_super_admin_select ON public.system_audit_logs
    FOR SELECT TO authenticated
    USING (public.is_super_admin());

DROP POLICY IF EXISTS audit_logs_insert_policy ON public.system_audit_logs;
CREATE POLICY audit_logs_insert_policy ON public.system_audit_logs
    FOR INSERT TO authenticated, service_role, anon
    WITH CHECK (true);

-- 4. Centralized SECURITY DEFINER helper function for logging player audit events
CREATE OR REPLACE FUNCTION public.gm_log_player_audit(
    p_action_type text,
    p_pseudo text,
    p_uid text,
    p_guild text,
    p_server_number text DEFAULT NULL,
    p_message text DEFAULT '',
    p_metadata jsonb DEFAULT '{}'::jsonb,
    p_level text DEFAULT 'INFO',
    p_service text DEFAULT 'member-portal'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id uuid;
    v_server text := p_server_number;
BEGIN
    IF v_server IS NULL AND p_guild IS NOT NULL THEN
        SELECT server_number INTO v_server FROM public.guilds WHERE id = p_guild;
    END IF;

    INSERT INTO public.system_audit_logs (
        level, service, action_type, pseudo, uid, server_number, guild, message, metadata, created_at
    )
    VALUES (
        COALESCE(p_level, 'INFO'),
        COALESCE(p_service, 'member-portal'),
        p_action_type,
        p_pseudo,
        p_uid,
        v_server,
        p_guild,
        p_message,
        COALESCE(p_metadata, '{}'::jsonb),
        now()
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_log_player_audit(text, text, text, text, text, text, jsonb, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_log_player_audit(text, text, text, text, text, text, jsonb, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
