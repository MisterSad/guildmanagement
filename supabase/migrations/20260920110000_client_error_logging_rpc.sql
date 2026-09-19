-- 20260920110000_client_error_logging_rpc.sql
-- TICKET-04 [OBS-01]: Controlled client error reporting RPC
-- Replaces direct table inserts with a rate-limited, validated SECURITY DEFINER RPC.

CREATE OR REPLACE FUNCTION public.gm_report_client_error(
    p_level text,
    p_service text,
    p_correlation_id text,
    p_guild text DEFAULT NULL,
    p_user_identifier text DEFAULT NULL,
    p_message text DEFAULT '',
    p_metadata jsonb DEFAULT '{}'::jsonb,
    p_error_details jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_recent_count integer;
    v_level text;
    v_service text;
    v_msg text;
    v_corr text;
    v_guild text;
    v_user text;
BEGIN
    -- 1. Validate & normalize inputs
    v_level := UPPER(TRIM(COALESCE(p_level, 'ERROR')));
    IF v_level NOT IN ('ERROR', 'FATAL', 'WARN') THEN
        v_level := 'ERROR';
    END IF;

    v_service := SUBSTRING(TRIM(COALESCE(p_service, 'fgf-client')) FROM 1 FOR 64);
    v_corr := SUBSTRING(TRIM(COALESCE(p_correlation_id, '')) FROM 1 FOR 64);
    v_guild := SUBSTRING(TRIM(COALESCE(p_guild, '')) FROM 1 FOR 32);
    IF v_guild = '' THEN v_guild := NULL; END IF;
    v_user := SUBSTRING(TRIM(COALESCE(p_user_identifier, '')) FROM 1 FOR 128);
    IF v_user = '' THEN v_user := NULL; END IF;

    -- Bound message length to prevent storage exhaustion
    v_msg := SUBSTRING(TRIM(COALESCE(p_message, 'Unknown client error')) FROM 1 FOR 4000);

    -- 2. Rate-limiting: max 15 reports per 60 seconds per correlation_id
    IF v_corr <> '' THEN
        SELECT COUNT(*) INTO v_recent_count
        FROM public.system_audit_logs
        WHERE correlation_id = v_corr
          AND created_at > (now() - interval '1 minute');

        IF v_recent_count >= 15 THEN
            -- Throttled: drop silently to protect database
            RETURN false;
        END IF;
    END IF;

    -- 3. Insert audit log
    INSERT INTO public.system_audit_logs (
        level,
        service,
        correlation_id,
        guild,
        user_identifier,
        message,
        metadata,
        error_details,
        created_at
    ) VALUES (
        v_level,
        v_service,
        v_corr,
        v_guild,
        v_user,
        v_msg,
        COALESCE(p_metadata, '{}'::jsonb),
        p_error_details,
        now()
    );

    RETURN true;
EXCEPTION
    WHEN OTHERS THEN
        RETURN false;
END;
$$;

-- Revoke all by default, grant strictly to authenticated and anon
REVOKE ALL ON FUNCTION public.gm_report_client_error(text, text, text, text, text, text, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_report_client_error(text, text, text, text, text, text, jsonb, jsonb) TO authenticated, anon;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';
