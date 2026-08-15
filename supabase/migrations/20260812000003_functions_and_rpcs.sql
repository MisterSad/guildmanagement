-- ============================================================================
-- FGF GUILD MANAGEMENT — CANONICAL FUNCTIONS & RPCS (Migration 3 of 4)
-- Migration: 20260812000003_functions_and_rpcs.sql
-- Description: Consolidated SECURITY DEFINER functions, helpers, and business RPCs.
-- ============================================================================

-- ============================================================================
-- 1. ACCESS CONTROL HELPERS
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
    IF v_role = 'super_admin' THEN
        RETURN true;
    END IF;

    -- Check accounts table
    SELECT a.role INTO v_role
    FROM public.accounts a
    WHERE a.auth_user_id = v_auth_id AND a.status = 'active'
    LIMIT 1;

    RETURN (v_role = 'super_admin');
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
-- 2. UTILITY & SESSION ID FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.gm_session_id_base(p_event_name text, p_date date)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $$
DECLARE
    v_up text := UPPER(COALESCE(p_event_name, ''));
    v_iso_year int;
    v_iso_week int;
    v_d text := to_char(p_date, 'YYYYMMDD');
BEGIN
    IF v_up LIKE '%ARMS RACE%' THEN
        IF v_up LIKE '%STAGE A%' THEN RETURN 'ARA-' || v_d; END IF;
        IF v_up LIKE '%STAGE B%' THEN RETURN 'ARB-' || v_d; END IF;
        RETURN 'AR-' || v_d;
    END IF;
    IF v_up = 'SHADOWFRONT' THEN RETURN 'SF-' || v_d; END IF;
    IF v_up = 'DEFEND TRADE ROUTE' OR v_up = 'DTR' THEN RETURN 'DTR-' || v_d; END IF;

    v_iso_year := EXTRACT(isoyear FROM p_date);
    v_iso_week := EXTRACT(week FROM p_date);

    IF v_up = 'SVS' THEN RETURN 'SVS-' || v_iso_year || '-W' || LPAD(v_iso_week::text, 2, '0'); END IF;
    IF v_up = 'GVG' THEN RETURN 'GVG-' || v_iso_year || '-W' || LPAD(v_iso_week::text, 2, '0'); END IF;
    IF v_up = 'GLORY' THEN RETURN 'GLORY-' || v_iso_year || '-W' || LPAD(v_iso_week::text, 2, '0'); END IF;

    RETURN REGEXP_REPLACE(v_up, '[^A-Z0-9]+', '-', 'g') || '-' || v_d;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_event_session_id(p_event_name text, p_date date)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $$
BEGIN
    RETURN public.gm_session_id_base(p_event_name, p_date);
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_event_scoring_key(p_event_name text, p_session_id text, p_week_start date)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO ''
AS $$
DECLARE
    v_up text := UPPER(COALESCE(p_event_name, ''));
    v_ws text := to_char(p_week_start, 'YYYY-MM-DD');
BEGIN
    IF v_up LIKE '%ARMS RACE%' THEN RETURN 'Arms Race|' || COALESCE(p_session_id, v_ws); END IF;
    IF v_up = 'SHADOWFRONT' THEN RETURN 'Shadowfront|' || v_ws; END IF;
    IF v_up = 'SVS' THEN RETURN 'SvS|' || v_ws; END IF;
    IF v_up = 'GVG' THEN RETURN 'GvG|' || v_ws; END IF;
    IF v_up = 'DEFEND TRADE ROUTE' OR v_up = 'DTR' THEN RETURN 'DTR|' || COALESCE(p_session_id, v_ws); END IF;
    RETURN COALESCE(p_event_name, '') || '|' || COALESCE(p_session_id, v_ws);
END;
$$;

CREATE OR REPLACE FUNCTION public.check_uid_exists_globally(p_uid text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    RETURN EXISTS (SELECT 1 FROM public.guild_members WHERE uid = TRIM(p_uid));
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_find_player_by_uid(p_uid text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_member record;
BEGIN
    SELECT m.uid, m.pseudo, m.guild, m.overall_power INTO v_member
    FROM public.guild_members m
    WHERE m.uid = TRIM(p_uid)
    LIMIT 1;

    IF v_member.uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_found');
    END IF;

    RETURN jsonb_build_object('ok', true, 'player', jsonb_build_object(
        'uid', v_member.uid,
        'pseudo', v_member.pseudo,
        'guild', v_member.guild,
        'overall_power', v_member.overall_power
    ));
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_cleanup_stale_reminder_locks()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_count integer := 0;
BEGIN
    DELETE FROM public.guild_config
    WHERE key LIKE 'sent_%'
      AND updated_at < (now() - interval '14 days');
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ============================================================================
-- 3. BUSINESS LOGIC & AUTH RPCS
-- ============================================================================

CREATE OR REPLACE FUNCTION public.gm_check_login(p_id text, p_password text)
RETURNS TABLE(valid boolean, role text, guild text, uid text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_account record;
BEGIN
    SELECT a.role, a.guild, a.uid, a.status, a.password_enc INTO v_account
    FROM public.accounts a
    WHERE a.id = TRIM(p_id) AND a.status = 'active';

    IF v_account IS NULL THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::text;
        RETURN;
    END IF;

    RETURN QUERY SELECT true, v_account.role, v_account.guild, v_account.uid;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_admin_upsert(
    p_id text,
    p_password text,
    p_role text,
    p_guild text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    IF NOT public.is_super_admin() AND NOT public.check_user_guild_write_access(p_guild) THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    INSERT INTO public.accounts (id, role, guild, status, created_at)
    VALUES (TRIM(p_id), COALESCE(p_role, 'R4'), p_guild, 'active', now())
    ON CONFLICT (id) DO UPDATE SET
        role = EXCLUDED.role,
        guild = EXCLUDED.guild,
        status = 'active';
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_admin_delete(p_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_account record;
BEGIN
    SELECT a.guild, a.auth_user_id INTO v_account
    FROM public.accounts a
    WHERE a.id = TRIM(p_id);

    IF v_account IS NULL THEN
        RETURN NULL;
    END IF;

    IF NOT public.is_super_admin() AND NOT public.check_user_guild_write_access(v_account.guild) THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    DELETE FROM public.accounts WHERE id = TRIM(p_id);
    RETURN v_account.auth_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_admin_list()
RETURNS TABLE(id text, role text, guild text, uid text, created_at timestamptz, has_password boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    IF public.is_super_admin() THEN
        RETURN QUERY
        SELECT a.id, a.role, a.guild, a.uid, a.created_at, (a.password_enc IS NOT NULL)
        FROM public.accounts a
        ORDER BY a.created_at DESC;
    ELSE
        RETURN QUERY
        SELECT a.id, a.role, a.guild, a.uid, a.created_at, (a.password_enc IS NOT NULL)
        FROM public.accounts a
        WHERE public.gm_can_read_guild_data(a.guild)
        ORDER BY a.created_at DESC;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_reset_account_password(
    p_id text,
    p_password text
)
RETURNS TABLE(ok boolean, auth_user_id uuid, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_acc record;
BEGIN
    SELECT a.id, a.guild, a.auth_user_id INTO v_acc
    FROM public.accounts a
    WHERE a.id = TRIM(p_id);

    IF v_acc.id IS NULL THEN
        RETURN QUERY SELECT false, NULL::uuid, 'account_not_found'::text;
        RETURN;
    END IF;

    IF NOT public.is_super_admin() AND NOT public.check_user_guild_write_access(v_acc.guild) THEN
        RETURN QUERY SELECT false, NULL::uuid, 'permission_denied'::text;
        RETURN;
    END IF;

    RETURN QUERY SELECT true, v_acc.auth_user_id, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_populate_event_participants(
    p_guild text,
    p_event_name text,
    p_session_id text,
    p_week_start date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_count integer := 0;
BEGIN
    IF NOT public.check_user_guild_write_access(p_guild) THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    INSERT INTO public.event_participants (
        guild, event_name, session_id, week_start, pseudo, participated, created_at
    )
    SELECT p_guild, p_event_name, p_session_id, p_week_start, m.pseudo, 0, now()
    FROM public.guild_members m
    WHERE m.guild = p_guild
    ON CONFLICT (guild, event_name, session_id, pseudo) DO NOTHING;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_add_member_to_active_events(p_guild text, p_pseudo text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_count integer := 0;
    v_event record;
BEGIN
    IF NOT public.check_user_guild_write_access(p_guild) THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    FOR v_event IN 
        SELECT s.event_name, s.session_id, COALESCE(s.start_at::date, now()::date) as dt
        FROM public.event_status s
        WHERE s.guild = p_guild AND s.is_active = true
    LOOP
        INSERT INTO public.event_participants (
            guild, event_name, session_id, week_start, pseudo, participated, created_at
        )
        VALUES (p_guild, v_event.event_name, v_event.session_id, v_event.dt, p_pseudo, 0, now())
        ON CONFLICT (guild, event_name, session_id, pseudo) DO NOTHING;
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_remove_member_from_active_events(p_guild text, p_pseudo text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_count integer := 0;
BEGIN
    IF NOT public.check_user_guild_write_access(p_guild) THEN
        RAISE EXCEPTION 'Access denied';
    END IF;

    DELETE FROM public.event_participants ep
    USING public.event_status s
    WHERE ep.guild = p_guild
      AND ep.pseudo = p_pseudo
      AND ep.event_name = s.event_name
      AND ep.session_id = s.session_id
      AND s.is_active = true;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_upsert_player_glory(
    p_guild text,
    p_pseudo text,
    p_week_start date,
    p_glory integer
)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    INSERT INTO public.event_participants (
        guild, event_name, session_id, week_start, pseudo, score, participated, created_at
    )
    VALUES (
        p_guild, 'Glory', 'GLORY-' || EXTRACT(isoyear FROM p_week_start) || '-W' || LPAD(EXTRACT(week FROM p_week_start)::text, 2, '0'),
        p_week_start, p_pseudo, p_glory, 1, now()
    )
    ON CONFLICT (guild, event_name, session_id, pseudo) DO UPDATE SET
        score = EXCLUDED.score,
        participated = 1;

    RETURN QUERY SELECT true, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_personal_kpis(p_uid text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_member record;
    v_total_attended int := 0;
    v_total_sessions int := 0;
    v_rate numeric := 0;
    v_current_week date := (date_trunc('week', CURRENT_DATE)::date);
BEGIN
    SELECT m.uid, m.pseudo, m.guild, m.overall_power, m.role, m.created_at
    INTO v_member
    FROM public.guild_members m
    WHERE m.uid = TRIM(p_uid)
    LIMIT 1;

    IF v_member.uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
    END IF;

    SELECT COUNT(DISTINCT public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text))
    INTO v_total_sessions
    FROM public.event_participants ep
    WHERE ep.guild = v_member.guild
      AND ep.week_start <= v_current_week
      AND LOWER(COALESCE(ep.event_name, '')) != 'glory'
      AND (ep.is_pending IS NOT TRUE);

    SELECT COUNT(DISTINCT public.gm_event_scoring_key(ep.event_name, ep.session_id, ep.week_start::text))
    INTO v_total_attended
    FROM public.event_participants ep
    WHERE ep.guild = v_member.guild
      AND ep.pseudo = v_member.pseudo
      AND ep.week_start <= v_current_week
      AND LOWER(COALESCE(ep.event_name, '')) != 'glory'
      AND (ep.is_pending IS NOT TRUE)
      AND (ep.participated > 0 OR ep.sub_present = true OR ep.score > 0 OR ep.score_prep > 0 OR ep.score_pvp > 0);

    IF v_total_sessions > 0 THEN
        v_rate := ROUND((v_total_attended::numeric / v_total_sessions::numeric) * 100, 1);
    END IF;

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_member.pseudo,
        'guild', v_member.guild,
        'overall_power', v_member.overall_power,
        'role', v_member.role,
        'attended', v_total_attended,
        'total_sessions', v_total_sessions,
        'participation_rate', v_rate
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_delete_guild(p_guild_id text)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    IF NOT public.is_super_admin() THEN
        RETURN QUERY SELECT false, 'unauthorized'::text;
        RETURN;
    END IF;

    DELETE FROM public.guilds WHERE id = p_guild_id;
    RETURN QUERY SELECT true, NULL::text;
END;
$$;

CREATE OR REPLACE FUNCTION public.gm_apply_subscription_payment(
    p_order_id text,
    p_token text DEFAULT NULL,
    p_provider text DEFAULT 'stripe',
    p_ext_ref text DEFAULT NULL
)
RETURNS TABLE(ok boolean, guild_id text, plan_key text, days_added integer, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_payment record;
    v_new_end timestamptz;
BEGIN
    SELECT * INTO v_payment
    FROM public.gm_payments
    WHERE order_id = p_order_id OR token = p_token OR merchant_order_ext_ref = p_ext_ref
    LIMIT 1;

    IF v_payment.id IS NULL THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::int, 'payment_not_found'::text;
        RETURN;
    END IF;

    IF v_payment.status = 'completed' THEN
        RETURN QUERY SELECT true, v_payment.guild_id, v_payment.plan_key, v_payment.days_added, NULL::text;
        RETURN;
    END IF;

    v_new_end := GREATEST(now(), COALESCE((SELECT subscription_end FROM public.guilds WHERE id = v_payment.guild_id), now())) + (v_payment.days_added || ' days')::interval;

    UPDATE public.guilds
    SET subscription_type = 'Premium', subscription_end = v_new_end
    WHERE id = v_payment.guild_id;

    UPDATE public.gm_payments
    SET status = 'completed', applied_at = now(), updated_at = now()
    WHERE id = v_payment.id;

    RETURN QUERY SELECT true, v_payment.guild_id, v_payment.plan_key, v_payment.days_added, NULL::text;
END;
$$;
