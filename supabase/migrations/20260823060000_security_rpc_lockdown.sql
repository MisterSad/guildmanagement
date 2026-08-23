-- 20260823060000_security_rpc_lockdown.sql
-- Workstream W6: Security Definer RPC authorization lockdown & RLS hardening
--
-- RPC Classification Summary:
-- | RPC Name | Caller Context | Grants | Internal Authorization Gate |
-- |---|---|---|---|
-- | gm_upsert_player_metrics | Browser (Admin) + Edge (Portal) | authenticated, service_role | is_super_admin() OR (check_user_guild_write_access(p_guild) AND is_subscription_active(p_guild)) |
-- | gm_reset_account_password | Edge (Admin Accounts) | authenticated, service_role | Super Admin, or Server Admin in-scope, or Guild Admin same guild |
-- | gm_admin_upsert | Browser (Setup) + Edge (Admin Accounts) | authenticated, service_role | Non-super_admin callers restricted to guild_admin/member in own guild |
-- | gm_get_player_metrics_history | Edge (Portal) + Browser | authenticated, service_role | Caller is self (p_uid) OR in-scope admin |
-- | gm_personal_kpis | Edge (Portal) + Browser | authenticated, service_role | Caller is self (p_uid) OR in-scope admin |
-- | request_guild_transfer | Edge (Portal) + Browser | authenticated, service_role | Caller is self (p_uid) OR in-scope admin |
-- | gm_transfer_guild_member | Browser (Admin) | authenticated, service_role | Super Admin, Server Admin (in-server), or Guild Admin (source guild) |
-- | transfer_guild_member | Browser (Admin) | authenticated, service_role | Wrapper delegating to gm_transfer_guild_member |
-- | check_user_guild_access | DB Helper / REST | authenticated, service_role | Strict tenant & server matching, zero hardcoded tenant fallback |
-- | check_uid_exists_globally | Browser (Admin UID check) | authenticated, service_role | Gated to Admin roles only (prevents member UID enumeration) |
-- | gm_find_player_by_uid | Browser (Admin lookup) | authenticated, service_role | Gated to Admin roles only |
-- | gm_log_player_audit | Edge (Portal / Logger) | service_role only | Service role restricted |
-- | system_audit_logs INSERT | Service Role | service_role only | Dropped public/anon insert policy |

-- 1. gm_upsert_player_metrics
CREATE OR REPLACE FUNCTION public.gm_upsert_player_metrics(
    p_guild text,
    p_pseudo text,
    p_total_power bigint DEFAULT NULL,
    p_tech_power bigint DEFAULT NULL,
    p_champion_power bigint DEFAULT NULL,
    p_crew_power bigint DEFAULT NULL,
    p_flagship_power bigint DEFAULT NULL,
    p_fleet_rating bigint DEFAULT NULL,
    p_glory_score bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_member record;
    v_week_start date := (date_trunc('week', CURRENT_DATE)::date);
    v_tot bigint;
    v_tech bigint;
    v_champ bigint;
    v_crew bigint;
    v_flag bigint;
    v_fleet bigint;
    v_glory bigint;
BEGIN
    -- Internal authorization gate when called with authenticated JWT
    IF auth.uid() IS NOT NULL THEN
        IF NOT (public.is_super_admin() OR (public.check_user_guild_write_access(p_guild) AND public.is_subscription_active(p_guild))) THEN
            RAISE EXCEPTION 'forbidden';
        END IF;
    END IF;

    -- Locate member
    SELECT pseudo, guild, overall_power, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score
    INTO v_member
    FROM public.guild_members
    WHERE guild = TRIM(p_guild) AND pseudo = TRIM(p_pseudo)
    LIMIT 1;

    IF v_member.pseudo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    v_tot   := COALESCE(p_total_power, v_member.overall_power, 0);
    v_tech  := COALESCE(p_tech_power, v_member.tech_power, 0);
    v_champ := COALESCE(p_champion_power, v_member.champion_power, 0);
    v_crew  := COALESCE(p_crew_power, v_member.crew_power, 0);
    v_flag  := COALESCE(p_flagship_power, v_member.flagship_power, 0);
    v_fleet := COALESCE(p_fleet_rating, v_member.fleet_rating, 0);
    v_glory := COALESCE(p_glory_score, v_member.glory_score, 0);

    UPDATE public.guild_members
    SET overall_power      = v_tot,
        tech_power         = v_tech,
        champion_power     = v_champ,
        crew_power         = v_crew,
        flagship_power     = v_flag,
        fleet_rating       = v_fleet,
        glory_score        = v_glory,
        power_updated_at   = now(),
        metrics_updated_at = now()
    WHERE guild = v_member.guild AND pseudo = v_member.pseudo;

    INSERT INTO public.player_metrics_history (
        guild, pseudo, week_start,
        total_power, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score,
        created_at
    )
    VALUES (
        v_member.guild, v_member.pseudo, v_week_start,
        v_tot, v_tech, v_champ, v_crew, v_flag, v_fleet, v_glory,
        now()
    )
    ON CONFLICT (guild, pseudo, week_start)
    DO UPDATE SET
        total_power    = EXCLUDED.total_power,
        tech_power     = EXCLUDED.tech_power,
        champion_power = EXCLUDED.champion_power,
        crew_power     = EXCLUDED.crew_power,
        flagship_power = EXCLUDED.flagship_power,
        fleet_rating   = EXCLUDED.fleet_rating,
        glory_score    = EXCLUDED.glory_score,
        created_at     = now();

    RETURN jsonb_build_object(
        'ok', true,
        'guild', v_member.guild,
        'pseudo', v_member.pseudo,
        'total_power', v_tot,
        'tech_power', v_tech,
        'champion_power', v_champ,
        'crew_power', v_crew,
        'flagship_power', v_flag,
        'fleet_rating', v_fleet,
        'glory_score', v_glory
    );
END;
$$;

-- 2. gm_reset_account_password
CREATE OR REPLACE FUNCTION public.gm_reset_account_password(
    p_id text,
    p_password text
)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_role text;
    v_target_guild text;
    v_target_server text;
BEGIN
    IF p_id IS NULL OR p_password IS NULL OR length(p_password) < 6 THEN
        RETURN QUERY SELECT false, 'invalid_password'::text;
        RETURN;
    END IF;

    IF auth.uid() IS NOT NULL THEN
        SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
        INTO v_caller_role, v_caller_guild, v_caller_server
        FROM public.accounts a
        LEFT JOIN public.guilds g ON g.id = a.guild
        WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
        LIMIT 1;

        IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
            RETURN QUERY SELECT false, 'forbidden'::text;
            RETURN;
        END IF;

        IF v_caller_role <> 'super_admin' THEN
            SELECT a2.role, a2.guild, COALESCE(a2.server_number, g2.server_number)
            INTO v_target_role, v_target_guild, v_target_server
            FROM public.accounts a2
            LEFT JOIN public.guilds g2 ON g2.id = a2.guild
            WHERE LOWER(a2.id) = LOWER(p_id)
            LIMIT 1;

            IF v_target_role = 'super_admin' THEN
                RETURN QUERY SELECT false, 'forbidden'::text;
                RETURN;
            END IF;

            IF v_caller_role = 'server_admin' THEN
                IF v_caller_server IS NULL OR v_target_server IS NULL OR v_caller_server <> v_target_server THEN
                    RETURN QUERY SELECT false, 'forbidden'::text;
                    RETURN;
                END IF;
            ELSIF v_caller_role = 'guild_admin' THEN
                IF v_target_role = 'server_admin' OR v_caller_guild IS NULL OR v_target_guild IS NULL OR v_caller_guild <> v_target_guild THEN
                    RETURN QUERY SELECT false, 'forbidden'::text;
                    RETURN;
                END IF;
            END IF;
        END IF;
    END IF;

    UPDATE public.accounts
    SET password_enc = extensions.pgp_sym_encrypt(
          p_password,
          (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')
        )
    WHERE LOWER(id) = LOWER(p_id);

    IF NOT FOUND THEN
        RETURN QUERY SELECT false, 'account_not_found'::text;
        RETURN;
    END IF;

    RETURN QUERY SELECT true, NULL::text;
END;
$$;

-- 3. gm_admin_upsert
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
    IF NOT public.is_super_admin() THEN
        IF p_role IN ('super_admin', 'server_admin') THEN
            RAISE EXCEPTION 'forbidden';
        END IF;
        IF NOT public.check_user_guild_write_access(p_guild) THEN
            RAISE EXCEPTION 'Access denied';
        END IF;
    END IF;

    INSERT INTO public.accounts (id, role, password_enc, guild, status, created_at)
    VALUES (
        TRIM(p_id),
        COALESCE(p_role, 'guild_admin'),
        extensions.pgp_sym_encrypt(p_password, (SELECT s.decrypted_secret FROM vault.decrypted_secrets s WHERE s.name = 'gm_accounts_key')),
        p_guild,
        'active',
        now()
    )
    ON CONFLICT (id) DO UPDATE SET
        role = EXCLUDED.role,
        password_enc = EXCLUDED.password_enc,
        guild = EXCLUDED.guild,
        status = 'active';
END;
$$;

-- 4. gm_get_player_metrics_history
CREATE OR REPLACE FUNCTION public.gm_get_player_metrics_history(
    p_uid text,
    p_limit int DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_member record;
    v_history jsonb;
BEGIN
    SELECT pseudo, guild INTO v_member
    FROM public.guild_members
    WHERE uid = TRIM(p_uid)
    LIMIT 1;

    IF v_member.pseudo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
    END IF;

    IF auth.uid() IS NOT NULL THEN
        IF NOT (
            public.is_super_admin() OR
            public.check_user_guild_access(v_member.guild) OR
            EXISTS (
                SELECT 1 FROM public.accounts a
                WHERE a.auth_user_id = auth.uid() AND (a.uid = p_uid OR a.id = p_uid) AND a.status = 'active'
            )
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
    END IF;

    SELECT jsonb_agg(h ORDER BY h.week_start DESC)
    INTO v_history
    FROM (
        SELECT week_start, total_power, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score, created_at
        FROM public.player_metrics_history
        WHERE guild = v_member.guild AND pseudo = v_member.pseudo
        ORDER BY week_start DESC
        LIMIT LEAST(p_limit, 52)
    ) h;

    RETURN jsonb_build_object(
        'ok', true,
        'guild', v_member.guild,
        'pseudo', v_member.pseudo,
        'history', COALESCE(v_history, '[]'::jsonb)
    );
END;
$$;

-- 5. gm_personal_kpis
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
    v_density_index numeric := 0;
    v_combativity_index numeric := 0;
    v_residual_power bigint := 0;
BEGIN
    SELECT m.uid, m.pseudo, m.guild, m.overall_power, m.role, m.created_at,
           COALESCE(m.tech_power, 0) as tech_power,
           COALESCE(m.champion_power, 0) as champion_power,
           COALESCE(m.crew_power, 0) as crew_power,
           COALESCE(m.flagship_power, 0) as flagship_power,
           COALESCE(m.fleet_rating, 0) as fleet_rating,
           COALESCE(m.glory_score, 0) as glory_score,
           m.metrics_updated_at
    INTO v_member
    FROM public.guild_members m
    WHERE m.uid = TRIM(p_uid)
    LIMIT 1;

    IF v_member.uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'player_not_found');
    END IF;

    IF auth.uid() IS NOT NULL THEN
        IF NOT (
            public.is_super_admin() OR
            public.check_user_guild_access(v_member.guild) OR
            EXISTS (
                SELECT 1 FROM public.accounts a
                WHERE a.auth_user_id = auth.uid() AND (a.uid = p_uid OR a.id = p_uid) AND a.status = 'active'
            )
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
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

    IF v_member.overall_power > 0 THEN
        v_density_index := ROUND(
            ((v_member.tech_power + v_member.champion_power + v_member.crew_power + v_member.flagship_power)::numeric / v_member.overall_power::numeric) * 100,
            1
        );
        v_combativity_index := ROUND(
            (v_member.glory_score::numeric / v_member.overall_power::numeric),
            2
        );
    END IF;

    v_residual_power := GREATEST(
        0,
        v_member.overall_power - (v_member.tech_power + v_member.champion_power + v_member.crew_power)
    );

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_member.pseudo,
        'guild', v_member.guild,
        'overall_power', v_member.overall_power,
        'tech_power', v_member.tech_power,
        'champion_power', v_member.champion_power,
        'crew_power', v_member.crew_power,
        'flagship_power', v_member.flagship_power,
        'fleet_rating', v_member.fleet_rating,
        'glory_score', v_member.glory_score,
        'metrics_updated_at', v_member.metrics_updated_at,
        'density_index', v_density_index,
        'combativity_index', v_combativity_index,
        'residual_power', v_residual_power,
        'role', v_member.role,
        'attended', v_total_attended,
        'total_sessions', v_total_sessions,
        'participation_rate', v_rate
    );
END;
$$;

-- 6. request_guild_transfer
CREATE OR REPLACE FUNCTION public.request_guild_transfer(p_uid text, p_target_guild text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
BEGIN
    SELECT guild, pseudo INTO v_source_guild, v_pseudo
    FROM public.guild_members
    WHERE uid = p_uid;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    IF auth.uid() IS NOT NULL THEN
        IF NOT (
            public.is_super_admin() OR
            public.check_user_guild_access(v_source_guild) OR
            EXISTS (
                SELECT 1 FROM public.accounts a
                WHERE a.auth_user_id = auth.uid() AND (a.uid = p_uid OR a.id = p_uid) AND a.status = 'active'
            )
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
    END IF;

    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_transfers WHERE uid = p_uid AND status = 'pending') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_pending');
    END IF;

    INSERT INTO public.guild_transfers (uid, pseudo, source_guild, target_guild, status)
    VALUES (p_uid, v_pseudo, v_source_guild, p_target_guild, 'pending');

    RETURN jsonb_build_object('ok', true, 'message', 'transfer_requested');
END;
$$;

-- 7. gm_transfer_guild_member & transfer_guild_member
CREATE OR REPLACE FUNCTION public.gm_transfer_guild_member(p_uid text, p_target_guild text, p_pseudo text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
    v_uid text;
BEGIN
    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    IF v_caller_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_caller_role = 'super_admin' THEN
        IF p_pseudo IS NOT NULL AND p_pseudo <> '' THEN
            SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
            FROM public.guild_members
            WHERE uid = p_uid AND LOWER(pseudo) = LOWER(p_pseudo)
            ORDER BY created_at DESC
            LIMIT 1;
        ELSE
            SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
            FROM public.guild_members
            WHERE uid = p_uid
            ORDER BY created_at DESC
            LIMIT 1;
        END IF;
    ELSIF v_caller_role = 'server_admin' THEN
        SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
        FROM public.guild_members
        WHERE uid = p_uid
        ORDER BY created_at DESC
        LIMIT 1;
    ELSE
        -- guild_admin: source guild must match own guild strictly (no fallback)
        IF v_caller_guild IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
        END IF;
        SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
        FROM public.guild_members
        WHERE uid = p_uid
          AND guild = v_caller_guild;
    END IF;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    -- Verify caller scope over source guild
    IF v_caller_role = 'guild_admin' AND v_caller_guild <> v_source_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    IF v_caller_role = 'server_admin' AND (v_caller_server IS NULL OR v_source_server <> v_caller_server OR v_target_server <> v_caller_server) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_caller_role <> 'super_admin' AND NOT public.is_subscription_active(v_source_guild) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = p_target_guild AND LOWER(pseudo) = LOWER(v_pseudo)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
    END IF;

    UPDATE public.guild_members
    SET guild = p_target_guild
    WHERE uid = v_uid
      AND pseudo = v_pseudo
      AND guild = v_source_guild;

    UPDATE public.accounts
    SET guild = p_target_guild
    WHERE uid = v_uid
      AND role = 'member';

    PERFORM public.gm_remove_member_from_active_events(v_pseudo, v_source_guild);
    PERFORM public.gm_add_member_to_active_events(v_pseudo, p_target_guild);

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_pseudo,
        'source_guild', v_source_guild,
        'target_guild', p_target_guild,
        'server_number', v_source_server
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.transfer_guild_member(p_uid text, p_target_guild text, p_pseudo text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT public.gm_transfer_guild_member(p_uid, p_target_guild, p_pseudo);
$$;

-- 8. check_user_guild_access
CREATE OR REPLACE FUNCTION public.check_user_guild_access(p_guild text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text;
  v_guild text;
  v_server text;
  v_target_server text;
BEGIN
  IF p_guild IS NULL OR p_guild = '' THEN
    RETURN false;
  END IF;

  SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
  INTO v_role, v_guild, v_server
  FROM public.accounts a
  LEFT JOIN public.guilds g ON g.id = a.guild
  WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
  LIMIT 1;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  IF v_role = 'server_admin' THEN
    IF v_server IS NOT NULL THEN
      SELECT g2.server_number INTO v_target_server FROM public.guilds g2 WHERE g2.id = p_guild;
      RETURN (v_target_server IS NOT NULL AND v_target_server = v_server);
    END IF;
    RETURN false;
  END IF;

  IF v_role = 'guild_admin' THEN
    RETURN (v_guild IS NOT NULL AND v_guild = p_guild);
  END IF;

  RETURN false;
END;
$$;

-- 9. check_uid_exists_globally & gm_find_player_by_uid
CREATE OR REPLACE FUNCTION public.check_uid_exists_globally(p_uid text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_exists boolean;
    v_role text;
BEGIN
    IF auth.uid() IS NOT NULL THEN
        SELECT a.role INTO v_role
        FROM public.accounts a
        WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
        LIMIT 1;

        IF v_role IS NULL OR v_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R4', 'R5', 'admin') THEN
            RAISE EXCEPTION 'forbidden';
        END IF;
    END IF;

    SELECT EXISTS(
        SELECT 1 FROM public.guild_members WHERE uid = TRIM(p_uid)
    ) INTO v_exists;
    RETURN v_exists;
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
    v_role text;
    v_player record;
    v_server text;
    v_history jsonb;
BEGIN
    IF auth.uid() IS NOT NULL THEN
        SELECT a.role INTO v_role
        FROM public.accounts a
        WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
        LIMIT 1;

        IF v_role IS NULL OR v_role NOT IN ('super_admin', 'server_admin', 'guild_admin', 'R4', 'R5', 'admin') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
    END IF;

    SELECT pseudo, uid, guild, role, overall_power, created_at INTO v_player
    FROM public.guild_members
    WHERE uid = TRIM(p_uid)
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_player.uid IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'found', false);
    END IF;

    SELECT g.server_number INTO v_server
    FROM public.guilds g
    WHERE g.id = v_player.guild;

    SELECT jsonb_agg(h ORDER BY h.week_start DESC)
    INTO v_history
    FROM (
        SELECT pseudo, week_start, total_power, created_at
        FROM public.player_metrics_history
        WHERE guild = v_player.guild AND pseudo = v_player.pseudo
        ORDER BY week_start DESC
        LIMIT 6
    ) h;

    RETURN jsonb_build_object(
        'ok', true,
        'found', true,
        'player', jsonb_build_object(
            'pseudo', v_player.pseudo,
            'uid', v_player.uid,
            'guild', v_player.guild,
            'server_number', v_server,
            'role', v_player.role,
            'overall_power', v_player.overall_power,
            'created_at', v_player.created_at
        ),
        'name_history', COALESCE(v_history, '[]'::jsonb)
    );
END;
$$;

-- 10. Audit logs security: drop public insert policy, restrict to service_role
DROP POLICY IF EXISTS audit_logs_insert_policy ON public.system_audit_logs;
CREATE POLICY audit_logs_insert_policy ON public.system_audit_logs
    FOR INSERT TO service_role
    WITH CHECK (true);

-- gm_log_player_audit executable by service_role only
REVOKE ALL ON FUNCTION public.gm_log_player_audit(text, text, text, text, text, text, jsonb, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_log_player_audit(text, text, text, text, text, text, jsonb, text, text) TO service_role;

-- Grants sweep
REVOKE ALL ON FUNCTION public.gm_upsert_player_metrics(text, text, bigint, bigint, bigint, bigint, bigint, bigint, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_metrics(text, text, bigint, bigint, bigint, bigint, bigint, bigint, bigint) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_reset_account_password(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_reset_account_password(text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_admin_upsert(text, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_admin_upsert(text, text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_get_player_metrics_history(text, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_get_player_metrics_history(text, int) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_personal_kpis(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_personal_kpis(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_guild_transfer(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_guild_transfer(text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_transfer_guild_member(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_transfer_guild_member(text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.transfer_guild_member(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.transfer_guild_member(text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.check_user_guild_access(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.check_user_guild_access(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.check_uid_exists_globally(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.check_uid_exists_globally(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_find_player_by_uid(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_find_player_by_uid(text) TO authenticated, service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
-- In case of emergency rollback:
GRANT EXECUTE ON FUNCTION public.gm_log_player_audit(text, text, text, text, text, text, jsonb, text, text) TO authenticated, service_role;
CREATE POLICY audit_logs_insert_policy ON public.system_audit_logs FOR INSERT TO authenticated, service_role, anon WITH CHECK (true);
*/
