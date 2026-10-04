-- Retire public.is_subscription_active (owner request, 2026-10-04).
--
-- The app is free (ADR-015) and the function has been `SELECT true` since
-- v127.0; the payment tables went in 20260926153207_drop_payments, which kept
-- the stub on purpose because RLS still called it. It was a no-op that looked
-- like a control: 45 write policies ANDed it onto check_user_guild_write_access,
-- and 10 functions tested it to return 'subscription_expired', a branch that
-- could never run. Audit REC-07 flagged the compliance whitepaper for
-- presenting it as a guard.
--
-- No behaviour change: every expression and branch removed here evaluated to
-- true / was unreachable. The policies keep their name, command, roles and
-- the rest of their expression (ALTER POLICY, no drop); the functions keep
-- their signature, owner and grants (CREATE OR REPLACE). Their bodies are the
-- production definitions verbatim (md5-checked against a replay, 2026-10-04)
-- minus the stub. DROP FUNCTION without CASCADE is the final guard: it fails
-- if any policy still depends on it.

-- ── Write policies: drop the always-true conjunct ───────────────────────────

ALTER POLICY gm_authenticated_delete ON public.banned_players USING (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_insert ON public.banned_players WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_update ON public.banned_players USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY event_chest_tiers_delete ON public.event_chest_tiers USING (public.check_user_guild_write_access(guild));
ALTER POLICY event_chest_tiers_insert ON public.event_chest_tiers WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY event_chest_tiers_update ON public.event_chest_tiers USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY event_daily_scores_delete ON public.event_daily_scores USING (public.check_user_guild_write_access(guild));
ALTER POLICY event_daily_scores_insert ON public.event_daily_scores WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY event_daily_scores_update ON public.event_daily_scores USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_delete ON public.event_participants USING (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_insert ON public.event_participants WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_update ON public.event_participants USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_delete ON public.event_status USING (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_insert ON public.event_status WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_update ON public.event_status USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_guild_config_delete ON public.guild_config USING (public.check_user_guild_write_access(guild) AND (NOT public.gm_is_webhook_key(key)));
ALTER POLICY gm_guild_config_insert ON public.guild_config WITH CHECK (public.check_user_guild_write_access(guild) AND (NOT public.gm_is_webhook_key(key)));
ALTER POLICY gm_guild_config_update ON public.guild_config USING (public.check_user_guild_write_access(guild) AND (NOT public.gm_is_webhook_key(key))) WITH CHECK (public.check_user_guild_write_access(guild) AND (NOT public.gm_is_webhook_key(key)));
ALTER POLICY gm_authenticated_delete ON public.guild_members USING (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_insert ON public.guild_members WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_update ON public.guild_members USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY player_metrics_history_delete ON public.player_metrics_history USING (public.check_user_guild_write_access(guild));
ALTER POLICY player_metrics_history_update ON public.player_metrics_history USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY player_metrics_history_write ON public.player_metrics_history WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_delete ON public.player_name_history USING (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_insert ON public.player_name_history WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_update ON public.player_name_history USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_delete ON public.sanctions USING (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_insert ON public.sanctions WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_update ON public.sanctions USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_delete ON public.shadowfront_signups USING (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_insert ON public.shadowfront_signups WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_update ON public.shadowfront_signups USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_delete ON public.shadowfront_squads USING (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_insert ON public.shadowfront_squads WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_update ON public.shadowfront_squads USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY war_opponents_delete ON public.war_opponents USING (public.check_user_guild_write_access(guild));
ALTER POLICY war_opponents_insert ON public.war_opponents WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY war_opponents_update ON public.war_opponents USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY war_sessions_delete ON public.war_sessions USING (public.check_user_guild_write_access(guild));
ALTER POLICY war_sessions_insert ON public.war_sessions WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY war_sessions_update ON public.war_sessions USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_delete ON public.weekly_scores USING (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_insert ON public.weekly_scores WITH CHECK (public.check_user_guild_write_access(guild));
ALTER POLICY gm_authenticated_update ON public.weekly_scores USING (public.check_user_guild_write_access(guild)) WITH CHECK (public.check_user_guild_write_access(guild));

-- ── Functions: drop the unreachable subscription_expired branches ───────────

CREATE OR REPLACE FUNCTION public.gm_admin_request_transfer(p_uid text, p_target_guild text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
    v_new_id uuid;
BEGIN
    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid()) AND a.status = 'active';

    IF v_role IS NULL OR v_role = 'member' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    -- guild_admin requests into their own guild; super_admin and server_admin
    -- (who may not be bound to one guild) must pass an explicit target.
    IF v_role IN ('super_admin', 'server_admin') THEN
        IF p_target_guild IS NULL OR p_target_guild = '' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'missing_target_guild');
        END IF;
        v_target := UPPER(p_target_guild);
    ELSE
        -- No fallback: an account without a guild has no guild to pull into.
        -- This used to default to 'ALPHA', a real tenant.
        IF v_caller_guild IS NULL OR v_caller_guild = '' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
        v_target := v_caller_guild;
    END IF;

    -- Find the player's current guild.
    SELECT guild, pseudo INTO v_source_guild, v_pseudo
    FROM public.guild_members
    WHERE uid = p_uid
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    IF v_source_guild = v_target THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = v_target AND uid = p_uid) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'uid_already_in_target');
    END IF;

    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = v_target;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_role = 'server_admin' AND (
        v_caller_server IS NULL
        OR v_source_server <> v_caller_server
        OR (v_target_server <> v_caller_server AND NOT public.servers_in_open_migration_group(v_caller_server, v_target_server))
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL
       OR (v_source_server <> v_target_server AND NOT public.servers_in_open_migration_group(v_source_server, v_target_server)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    -- One pending request per player at a time.
    IF EXISTS (
        SELECT 1 FROM public.guild_transfers
        WHERE uid = p_uid AND status = 'pending'
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_pending');
    END IF;

    -- An admin pull: the guild the player is LEAVING approves it.
    INSERT INTO public.guild_transfers (uid, pseudo, source_guild, target_guild, status, requested_by)
    VALUES (p_uid, v_pseudo, v_source_guild, v_target, 'pending', 'admin')
    RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'ok', true,
        'transfer_id', v_new_id,
        'source_guild', v_source_guild,
        'target_guild', v_target
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_delete_war_session(p_guild text, p_event_name text, p_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_target  text := TRIM(p_guild);
    v_deleted boolean;
BEGIN
    IF NOT public.check_user_guild_write_access(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    WITH del AS (
        DELETE FROM public.war_sessions
        WHERE guild = v_target AND event_name = TRIM(p_event_name) AND session_id = TRIM(p_session_id)
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM del) INTO v_deleted;

    RETURN jsonb_build_object('ok', true, 'deleted', v_deleted);
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_require_guild_write(p_guild text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_guild text := NULLIF(btrim(p_guild), '');
BEGIN
    IF v_guild IS NULL
       OR NOT public.check_user_guild_write_access(v_guild) THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN v_guild;
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_save_chest_tiers(p_guild text, p_event_name text, p_tiers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_target    text := TRIM(p_guild);
    v_event     text := TRIM(p_event_name);
    v_seen      text[] := ARRAY[]::text[];
    v_last_min  bigint[] := ARRAY[NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint];
    v_last_agg  bigint := NULL;
    v_el        jsonb;
    v_day       int;
    v_tier      int;
    v_min_score bigint;
    v_chests    bigint;
    v_n         int := 0;
    v_key       text;
    v_caller_id text;
BEGIN
    IF v_event NOT IN ('SvS', 'GvG') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_event');
    END IF;

    IF NOT public.check_user_guild_write_access(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF jsonb_typeof(p_tiers) <> 'array' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
    END IF;

    IF jsonb_array_length(p_tiers) > 120 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'too_many_tiers');
    END IF;

    -- Pass 1: validate every tier (bounds, duplicates, ascending thresholds).
    FOR i IN 0 .. jsonb_array_length(p_tiers) - 1 LOOP
        v_el := p_tiers->i;

        IF jsonb_typeof(v_el) <> 'object'
           OR v_el->'day' IS NULL OR jsonb_typeof(v_el->'day') <> 'number'
           OR v_el->'tier' IS NULL OR jsonb_typeof(v_el->'tier') <> 'number'
           OR v_el->'min_score' IS NULL OR jsonb_typeof(v_el->'min_score') <> 'number'
           OR v_el->'chests' IS NULL OR jsonb_typeof(v_el->'chests') <> 'number'
           OR (v_el->>'day') !~ '^[0-9]+$'
           OR (v_el->>'tier') !~ '^[0-9]+$'
           OR (v_el->>'min_score') !~ '^[0-9]+$'
           OR (v_el->>'chests') !~ '^[0-9]+$' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_tier_shape');
        END IF;

        v_day       := (v_el->>'day')::int;
        v_tier      := (v_el->>'tier')::int;
        v_min_score := (v_el->>'min_score')::bigint;
        v_chests    := (v_el->>'chests')::bigint;

        IF v_day BETWEEN 0 AND 6
           AND v_tier >= 1
           AND v_min_score >= 0
           AND v_chests >= 1 THEN
            v_key := v_day::text || ':' || v_tier::text;
            IF v_seen @> ARRAY[v_key] THEN
                RETURN jsonb_build_object('ok', false, 'error', 'duplicate_tier');
            END IF;
            IF v_day = 0 THEN
                IF v_last_agg IS NOT NULL AND v_min_score < v_last_agg THEN
                    RETURN jsonb_build_object('ok', false, 'error', 'unsorted_thresholds');
                END IF;
                v_last_agg := v_min_score;
            ELSE
                IF v_last_min[v_day] IS NOT NULL AND v_min_score < v_last_min[v_day] THEN
                    RETURN jsonb_build_object('ok', false, 'error', 'unsorted_thresholds');
                END IF;
                v_last_min[v_day] := v_min_score;
            END IF;
            v_seen     := v_seen || ARRAY[v_key];
            v_n := v_n + 1;
        ELSE
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
        END IF;
    END LOOP;

    -- Pass 2: atomic replace.
    DELETE FROM public.event_chest_tiers
    WHERE guild = v_target AND event_name = v_event;

    FOR i IN 0 .. jsonb_array_length(p_tiers) - 1 LOOP
        v_el := p_tiers->i;
        INSERT INTO public.event_chest_tiers (guild, event_name, day, tier, min_score, chests, updated_at)
        VALUES (v_target, v_event,
                (v_el->>'day')::smallint, (v_el->>'tier')::smallint,
                (v_el->>'min_score')::bigint, (v_el->>'chests')::bigint,
                now());
    END LOOP;

    SELECT a.id INTO v_caller_id
    FROM public.accounts a
    WHERE a.auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid()) LIMIT 1;

    INSERT INTO public.system_audit_logs (
        level, service, guild, user_identifier, message, metadata, created_at
    ) VALUES (
        'INFO', 'war_chest_tiers', v_target,
        COALESCE(v_caller_id, auth.uid()::text, 'Admin'),
        'Saved chest tiers',
        jsonb_build_object('event_name', v_event, 'tiers_saved', v_n),
        now()
    );

    RETURN jsonb_build_object('ok', true, 'saved', v_n);
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_transfer_guild_member(p_uid text, p_target_guild text, p_pseudo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    WHERE a.auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid()) AND a.status = 'active';

    IF v_caller_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;
    -- Moving a player is an officer act; a member must use request_guild_transfer.
    IF v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin') THEN
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

    IF v_caller_role = 'server_admin' AND (
        v_caller_server IS NULL
        OR v_source_server <> v_caller_server
        OR (v_target_server <> v_caller_server AND NOT public.servers_in_open_migration_group(v_caller_server, v_target_server))
    ) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL
       OR (v_source_server <> v_target_server AND NOT public.servers_in_open_migration_group(v_source_server, v_target_server)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = p_target_guild AND uid = v_uid) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'uid_already_in_target');
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

    PERFORM public.gm_transfer_sync_related_rows(v_pseudo, v_source_guild, p_target_guild);

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_pseudo,
        'source_guild', v_source_guild,
        'target_guild', p_target_guild,
        'server_number', v_source_server
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_upsert_daily_scores(p_guild text, p_event_name text, p_session_id text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_target        text := TRIM(p_guild);
    v_event         text := TRIM(p_event_name);
    v_sid           text := TRIM(p_session_id);
    v_snapshot      jsonb;
    v_day_tiers     jsonb;
    v_pseudos       text[] := ARRAY[]::text[];
    v_agg_pseudos   text[] := ARRAY[]::text[];
    v_daily_pseudos text[] := ARRAY[]::text[];
    v_pseudo        text;
    v_day           int;
    v_score         bigint;
    v_chests        int;
    v_el            jsonb;
    v_updated       int := 0;
    v_week          date;
BEGIN
    IF v_event NOT IN ('SvS', 'GvG') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_event');
    END IF;

    -- Gate only when there is a JWT to gate. A browser is still checked; a
    -- service-role caller (member-portal, on a player's own submission) has no
    -- auth.uid(), for which check_user_guild_write_access always answers false.
    -- That caller authenticated the player itself and derives the guild and the
    -- pseudo from the player's own roster row, never from the request.
    IF auth.uid() IS NOT NULL THEN
        IF NOT public.check_user_guild_write_access(v_target) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
    END IF;

    IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'empty_rows');
    END IF;

    IF jsonb_array_length(p_rows) > 200 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'too_many_rows');
    END IF;

    SELECT chest_tiers_snapshot INTO v_snapshot
    FROM public.war_sessions
    WHERE guild = v_target AND event_name = v_event AND session_id = v_sid;

    IF v_snapshot IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
    END IF;

    SELECT COALESCE(
        (SELECT (date_trunc('week', ws.start_at AT TIME ZONE 'UTC'))::date
         FROM public.war_sessions ws
         WHERE ws.guild = v_target AND ws.event_name = v_event AND ws.session_id = v_sid),
        (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
    ) INTO v_week;

    -- Pass 1: validate every row and record the per-pseudo intent BEFORE any
    -- write, so the convergence rule is deterministic and total.
    FOR i IN 0 .. jsonb_array_length(p_rows) - 1 LOOP
        v_el := p_rows->i;

        IF jsonb_typeof(v_el) <> 'object' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_row_shape');
        END IF;

        v_pseudo := TRIM(COALESCE(v_el->>'pseudo', ''));
        IF v_pseudo = '' OR v_el->'day' IS NULL OR v_el->'score' IS NULL
           OR jsonb_typeof(v_el->'day') <> 'number' OR jsonb_typeof(v_el->'score') <> 'number'
           OR (v_el->>'day') !~ '^[0-9]+$'
           OR (v_el->>'score') !~ '^[0-9]+$'
           OR (v_el->'chests' IS NOT NULL AND jsonb_typeof(v_el->'chests') = 'number'
               AND (v_el->>'chests') !~ '^[0-9]+$') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
        END IF;

        v_day   := (v_el->>'day')::int;
        v_score := (v_el->>'score')::bigint;

        IF v_day BETWEEN 0 AND 6 AND v_score >= 0 AND v_score <= 9999999999 THEN
            NULL;
        ELSE
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
        END IF;

        IF NOT v_pseudos @> ARRAY[v_pseudo] THEN
            v_pseudos := v_pseudos || ARRAY[v_pseudo];
        END IF;

        IF v_day = 0 THEN
            IF NOT v_agg_pseudos @> ARRAY[v_pseudo] THEN
                v_agg_pseudos := v_agg_pseudos || ARRAY[v_pseudo];
            END IF;
        ELSIF v_day BETWEEN 1 AND 5 THEN
            IF NOT v_daily_pseudos @> ARRAY[v_pseudo] THEN
                v_daily_pseudos := v_daily_pseudos || ARRAY[v_pseudo];
            END IF;
        END IF;
    END LOOP;

    -- Pass 2: convergence (ONE prep source per player per session).
    -- A pseudo described as aggregate in this batch loses its historical
    -- day 1..5 rows (both pre-existing and the batch's own day 1..5 rows).
    IF CARDINALITY(v_agg_pseudos) > 0 THEN
        DELETE FROM public.event_daily_scores
        WHERE guild = v_target AND event_name = v_event AND session_id = v_sid
          AND pseudo = ANY(v_agg_pseudos)
          AND day BETWEEN 1 AND 5;
    END IF;

    -- A pseudo described as daily (but NOT aggregate) loses its aggregate row.
    IF CARDINALITY(v_daily_pseudos) > 0 THEN
        DELETE FROM public.event_daily_scores
        WHERE guild = v_target AND event_name = v_event AND session_id = v_sid
          AND pseudo = ANY(v_daily_pseudos)
          AND day = 0
          AND NOT (pseudo = ANY(v_agg_pseudos));
    END IF;

    -- Pass 3: upsert the batch (day 1..5 rows already superseded by an
    -- aggregate row for the same pseudo are skipped).
    FOR i IN 0 .. jsonb_array_length(p_rows) - 1 LOOP
        v_el := p_rows->i;

        v_pseudo := TRIM(COALESCE(v_el->>'pseudo', ''));
        v_day    := (v_el->>'day')::int;
        v_score  := (v_el->>'score')::bigint;

        IF v_day BETWEEN 1 AND 5 AND v_agg_pseudos @> ARRAY[v_pseudo] THEN
            CONTINUE;
        END IF;

        v_day_tiers := '[]'::jsonb;
        IF v_day = 0 THEN
            SELECT COALESCE(jsonb_agg(t ORDER BY (t->>'tier')::int), '[]'::jsonb) INTO v_day_tiers
            FROM jsonb_array_elements(v_snapshot) t
            WHERE (t->>'day')::int = 0;
            -- Deterministic fallback: no day-0 tier frozen into the session
            -- means we use the day-1 slice (mirror of aggregateTierSlice in
            -- src/core/scoring/chests.ts).
            IF jsonb_array_length(v_day_tiers) = 0 THEN
                SELECT COALESCE(jsonb_agg(t ORDER BY (t->>'tier')::int), '[]'::jsonb) INTO v_day_tiers
                FROM jsonb_array_elements(v_snapshot) t
                WHERE (t->>'day')::int = 1;
            END IF;
        ELSE
            SELECT COALESCE(jsonb_agg(t ORDER BY (t->>'tier')::int), '[]'::jsonb) INTO v_day_tiers
            FROM jsonb_array_elements(v_snapshot) t
            WHERE (t->>'day')::int = v_day;
        END IF;

        IF v_el->'chests' IS NOT NULL AND jsonb_typeof(v_el->'chests') = 'number' THEN
            v_chests := (v_el->>'chests')::int;
            IF v_chests < 0 THEN
                RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
            END IF;
        ELSE
            v_chests := public.gm_chests_for_score(v_day_tiers, v_score);
        END IF;

        INSERT INTO public.event_daily_scores (guild, event_name, session_id, pseudo, day, score, chests_unlocked, updated_at)
        VALUES (v_target, v_event, v_sid, v_pseudo, v_day, v_score, v_chests, now())
        ON CONFLICT (guild, event_name, session_id, pseudo, day) DO UPDATE SET
            score           = EXCLUDED.score,
            chests_unlocked = EXCLUDED.chests_unlocked,
            updated_at      = now();

        v_updated := v_updated + 1;
    END LOOP;

    -- Ensure a participant row exists for every touched pseudo (week-derived
    -- from the session), then maintain the legacy aggregate cache columns.
    INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated)
    SELECT v_target, v_event, v_sid, v_week, ps, 0
    FROM unnest(v_pseudos) ps
    WHERE EXISTS (
        SELECT 1 FROM public.guild_members gm
        WHERE gm.guild = v_target AND LOWER(gm.pseudo) = LOWER(ps)
    )
    ON CONFLICT (guild, event_name, session_id, pseudo) DO NOTHING;

    UPDATE public.event_participants ep
    SET score_prep   = COALESCE(d.prep, 0),
        score_pvp    = COALESCE(d.pvp, 0),
        score        = NULL,
        participated = CASE WHEN COALESCE(d.prep, 0) + COALESCE(d.pvp, 0) > 0
                            THEN 1 ELSE ep.participated END
    FROM (
        SELECT pseudo,
               SUM(CASE WHEN day IN (0, 1, 2, 3, 4, 5) THEN score ELSE 0 END)::bigint AS prep,
               SUM(CASE WHEN day = 6 THEN score ELSE 0 END)::bigint AS pvp
        FROM public.event_daily_scores
        WHERE guild = v_target AND event_name = v_event AND session_id = v_sid
          AND pseudo = ANY(v_pseudos)
        GROUP BY pseudo
    ) d
    WHERE ep.guild = v_target
      AND ep.event_name = v_event
      AND ep.session_id = v_sid
      AND ep.pseudo = d.pseudo;

    RETURN jsonb_build_object('ok', true, 'updated', v_updated, 'pseudos', jsonb_build_array(v_pseudos), 'week_start', v_week);
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_upsert_player_glory(p_guild text, p_pseudo text, p_week_start date, p_glory bigint)
 RETURNS TABLE(ok boolean, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_session text;
    v_safe_glory bigint := GREATEST(0, LEAST(9999999999, COALESCE(p_glory, 0)));
BEGIN
    IF p_guild IS NULL OR p_pseudo IS NULL OR p_week_start IS NULL THEN
        RETURN QUERY SELECT false, 'missing_parameters';
        RETURN;
    END IF;

    -- Internal authorization gate when called with an authenticated JWT, same
    -- idiom as gm_upsert_player_metrics. A service-role caller has no user to
    -- authorize; the Edge Function that holds that key authenticated the player
    -- before getting here and never accepts a caller-supplied guild.
    IF auth.uid() IS NOT NULL THEN
        IF NOT public.check_user_guild_write_access(p_guild) THEN
            RETURN QUERY SELECT false, 'permission_denied';
            RETURN;
        END IF;
    END IF;

    v_session := 'GLORY-' || EXTRACT(isoyear FROM p_week_start) || '-W' || LPAD(EXTRACT(week FROM p_week_start)::text, 2, '0');

    -- 1. Record / update weekly glory score in event_participants
    INSERT INTO public.event_participants (
        guild, event_name, session_id, week_start, pseudo, score, participated, created_at
    )
    VALUES (
        p_guild, 'Glory', v_session,
        p_week_start, p_pseudo, v_safe_glory, 1, now()
    )
    ON CONFLICT (guild, event_name, session_id, pseudo) DO UPDATE SET
        score = EXCLUDED.score,
        participated = 1;

    -- 2. Update member tactical force metric glory_score in guild_members
    UPDATE public.guild_members
    SET glory_score = v_safe_glory,
        metrics_updated_at = now()
    WHERE guild = p_guild
      AND pseudo = p_pseudo;

    -- 3. Snapshot into player_metrics_history for weekly time-series
    INSERT INTO public.player_metrics_history (
        guild, pseudo, week_start, glory_score, created_at
    )
    VALUES (
        p_guild, p_pseudo, p_week_start, v_safe_glory, now()
    )
    ON CONFLICT (guild, pseudo, week_start) DO UPDATE SET
        glory_score = EXCLUDED.glory_score;

    -- 4. Clean up legacy un-sessioned duplicate if one exists
    DELETE FROM public.event_participants
    WHERE guild = p_guild
      AND event_name = 'Glory'
      AND week_start = p_week_start
      AND pseudo = p_pseudo
      AND session_id IS NULL;

    RETURN QUERY SELECT true, NULL::text;
END;
$function$;

CREATE OR REPLACE FUNCTION public.gm_upsert_player_metrics(p_guild text, p_pseudo text, p_total_power bigint DEFAULT NULL::bigint, p_tech_power bigint DEFAULT NULL::bigint, p_champion_power bigint DEFAULT NULL::bigint, p_crew_power bigint DEFAULT NULL::bigint, p_flagship_power bigint DEFAULT NULL::bigint, p_fleet_rating bigint DEFAULT NULL::bigint, p_glory_score bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        IF NOT (public.is_super_admin() OR public.check_user_guild_write_access(p_guild)) THEN
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
$function$;

CREATE OR REPLACE FUNCTION public.gm_upsert_war_session(p_guild text, p_event_name text, p_session_id text, p_opponent jsonb DEFAULT NULL::jsonb, p_daily_results jsonb DEFAULT NULL::jsonb, p_start_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_target      text := TRIM(p_guild);
    v_event       text := TRIM(p_event_name);
    v_sid         text := TRIM(p_session_id);
    v_kind        text;
    v_name        text;
    v_server      text;
    v_guild_ref   text;
    v_opp_id      uuid;
    v_opp_snap    jsonb;
    v_chest_snap  jsonb;
    v_d1 text; v_d2 text; v_d3 text; v_d4 text; v_d5 text; v_d6 text;
    v_val         text;
    v_sess        public.war_sessions%ROWTYPE;
BEGIN
    IF v_sid = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'missing_parameters');
    END IF;
    IF v_event NOT IN ('SvS', 'GvG') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_event');
    END IF;

    IF NOT public.check_user_guild_write_access(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    -- Daily results (Day 1..6): only provided keys are applied; explicit
    -- null clears a result back to neutral (NULL); anything else is rejected.
    IF p_daily_results IS NOT NULL AND jsonb_typeof(p_daily_results) <> 'object' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
    END IF;

    IF p_daily_results IS NOT NULL THEN
        IF p_daily_results ? 'day1' THEN
            v_val := p_daily_results->>'day1';
            IF v_val IS NULL THEN v_d1 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d1 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day2' THEN
            v_val := p_daily_results->>'day2';
            IF v_val IS NULL THEN v_d2 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d2 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day3' THEN
            v_val := p_daily_results->>'day3';
            IF v_val IS NULL THEN v_d3 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d3 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day4' THEN
            v_val := p_daily_results->>'day4';
            IF v_val IS NULL THEN v_d4 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d4 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day5' THEN
            v_val := p_daily_results->>'day5';
            IF v_val IS NULL THEN v_d5 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d5 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day6' THEN
            v_val := p_daily_results->>'day6';
            IF v_val IS NULL THEN v_d6 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d6 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
    END IF;

    -- Opponent resolution (optional): kind in {server, guild}, name required.
    IF p_opponent IS NOT NULL AND jsonb_typeof(p_opponent) <> 'object' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
    END IF;

    IF p_opponent IS NOT NULL THEN
        v_kind := LOWER(COALESCE(p_opponent->>'kind', ''));
        IF v_kind NOT IN ('server', 'guild') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_opponent_kind');
        END IF;
        v_name := TRIM(COALESCE(p_opponent->>'name', ''));
        v_server := NULLIF(TRIM(COALESCE(p_opponent->>'server_number', '')), '');
        v_guild_ref := NULLIF(TRIM(COALESCE(p_opponent->>'guild_ref', '')), '');

        IF v_guild_ref IS NOT NULL THEN
            -- This read the guilds table's `name` column, which does not exist in
            -- production: the branch raised 42703 and saving a guild opponent
            -- was impossible. The identifier IS the name here.
            SELECT g.id, g.server_number INTO v_name, v_server
            FROM public.guilds g WHERE g.id = v_guild_ref LIMIT 1;
            IF v_name IS NULL THEN v_name := v_guild_ref; END IF;
        END IF;

        IF v_name = '' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'missing_opponent_name');
        END IF;

        SELECT o.id INTO v_opp_id
        FROM public.war_opponents o
        WHERE o.guild = v_target AND o.kind = v_kind AND LOWER(o.name) = LOWER(v_name)
        LIMIT 1;

        IF v_opp_id IS NULL THEN
            INSERT INTO public.war_opponents (guild, kind, name, server_number, guild_ref)
            VALUES (v_target, v_kind, v_name, v_server, v_guild_ref)
            RETURNING id INTO v_opp_id;
        ELSE
            UPDATE public.war_opponents
            SET server_number = COALESCE(v_server, server_number),
                guild_ref     = COALESCE(v_guild_ref, guild_ref),
                updated_at    = now()
            WHERE id = v_opp_id;
        END IF;

        v_opp_snap := jsonb_strip_nulls(jsonb_build_object(
            'kind', v_kind, 'name', v_name,
            'server_number', v_server, 'guild_ref', v_guild_ref
        ));
    END IF;

    -- Freeze the active chest grid (into INSERT branch on first creation).
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object('day', t.day, 'tier', t.tier,
                           'min_score', t.min_score, 'chests', t.chests)
        ORDER BY t.day, t.tier
    ), '[]'::jsonb) INTO v_chest_snap
    FROM public.event_chest_tiers t
    WHERE t.guild = v_target AND t.event_name = v_event;

    INSERT INTO public.war_sessions (
        guild, event_name, session_id, opponent_id, opponent_snapshot,
        day1_result, day2_result, day3_result, day4_result, day5_result, day6_result,
        chest_tiers_snapshot, start_at, updated_at
    ) VALUES (
        v_target, v_event, v_sid, v_opp_id, COALESCE(v_opp_snap, '{}'::jsonb),
        v_d1, v_d2, v_d3, v_d4, v_d5, v_d6,
        v_chest_snap, COALESCE(p_start_at, now()), now()
    )
    ON CONFLICT (guild, event_name, session_id) DO UPDATE SET
        opponent_id       = COALESCE(v_opp_id, war_sessions.opponent_id),
        opponent_snapshot = CASE WHEN v_opp_id IS NULL
                                 THEN war_sessions.opponent_snapshot ELSE EXCLUDED.opponent_snapshot END,
        day1_result       = CASE WHEN p_daily_results IS NOT NULL AND p_daily_results ? 'day1'
                                 THEN v_d1 ELSE war_sessions.day1_result END,
        day2_result       = CASE WHEN p_daily_results IS NOT NULL AND p_daily_results ? 'day2'
                                 THEN v_d2 ELSE war_sessions.day2_result END,
        day3_result       = CASE WHEN p_daily_results IS NOT NULL AND p_daily_results ? 'day3'
                                 THEN v_d3 ELSE war_sessions.day3_result END,
        day4_result       = CASE WHEN p_daily_results IS NOT NULL AND p_daily_results ? 'day4'
                                 THEN v_d4 ELSE war_sessions.day4_result END,
        day5_result       = CASE WHEN p_daily_results IS NOT NULL AND p_daily_results ? 'day5'
                                 THEN v_d5 ELSE war_sessions.day5_result END,
        day6_result       = CASE WHEN p_daily_results IS NOT NULL AND p_daily_results ? 'day6'
                                 THEN v_d6 ELSE war_sessions.day6_result END,
        start_at          = COALESCE(EXCLUDED.start_at, war_sessions.start_at),
        chest_tiers_snapshot = CASE
            WHEN jsonb_array_length(COALESCE(war_sessions.chest_tiers_snapshot, '[]'::jsonb)) = 0
            THEN EXCLUDED.chest_tiers_snapshot
            ELSE war_sessions.chest_tiers_snapshot END,
        updated_at = now()
    RETURNING * INTO v_sess;

    RETURN jsonb_build_object('ok', true, 'session', jsonb_build_object(
        'id', v_sess.id,
        'guild', v_sess.guild,
        'event_name', v_sess.event_name,
        'session_id', v_sess.session_id,
        'opponent_id', v_sess.opponent_id,
        'opponent_snapshot', v_sess.opponent_snapshot,
        'day1_result', v_sess.day1_result,
        'day2_result', v_sess.day2_result,
        'day3_result', v_sess.day3_result,
        'day4_result', v_sess.day4_result,
        'day5_result', v_sess.day5_result,
        'day6_result', v_sess.day6_result,
        'chest_tiers_snapshot', v_sess.chest_tiers_snapshot,
        'start_at', v_sess.start_at,
        'created_at', v_sess.created_at,
        'updated_at', v_sess.updated_at
    ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_guild_transfer(p_transfer_id uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_server text;
    v_transfer public.guild_transfers%ROWTYPE;
    v_approve_source_server text;
    v_approve_target_server text;
    v_approver_guild text;
    v_approver_server text;
    v_is_approver boolean;
    v_is_requester boolean;
BEGIN
    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid()) AND a.status = 'active';

    IF v_caller_role IS NULL OR v_caller_role NOT IN ('super_admin', 'server_admin', 'guild_admin') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    SELECT * INTO v_transfer FROM public.guild_transfers
    WHERE id = p_transfer_id AND status = 'pending';

    IF v_transfer.id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'transfer_not_found_or_resolved');
    END IF;

    -- Whoever asked for the move never decides it. A player's own request is
    -- decided by the guild RECEIVING them; an admin pull (requested_by =
    -- 'admin') by the guild the player is LEAVING. Before this, a guild admin
    -- could pull any player of another guild on the server and approve their
    -- own request, because the pull's target was always their own guild.
    v_approver_guild := CASE WHEN v_transfer.requested_by = 'admin'
                             THEN v_transfer.source_guild ELSE v_transfer.target_guild END;
    SELECT server_number INTO v_approver_server FROM public.guilds WHERE id = v_approver_guild;

    IF v_caller_role = 'super_admin' THEN
        v_is_approver := true;
        v_is_requester := false;
    ELSIF v_caller_role = 'server_admin' THEN
        v_is_approver := v_caller_server IS NOT NULL AND v_approver_server IS NOT NULL AND (
            v_approver_server = v_caller_server
            OR public.servers_in_open_migration_group(v_caller_server, v_approver_server));
        v_is_requester := false;
    ELSE
        v_is_approver := v_caller_guild = v_approver_guild;
        -- The pulling guild may withdraw its own request (reject), never approve it.
        v_is_requester := v_transfer.requested_by = 'admin' AND v_caller_guild = v_transfer.target_guild;
    END IF;

    IF NOT v_is_approver AND NOT (p_action = 'reject' AND v_is_requester) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF p_action = 'approve' THEN
        -- The player must still live in the source guild (stale approval guard).
        IF NOT EXISTS (
            SELECT 1 FROM public.guild_members
            WHERE uid = v_transfer.uid AND guild = v_transfer.source_guild
        ) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'member_no_longer_in_source');
        END IF;

        IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = v_transfer.target_guild AND uid = v_transfer.uid) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'uid_already_in_target');
        END IF;
        IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = v_transfer.target_guild AND LOWER(pseudo) = LOWER(v_transfer.pseudo)) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
        END IF;

        SELECT server_number INTO v_approve_source_server FROM public.guilds WHERE id = v_transfer.source_guild;
        SELECT server_number INTO v_approve_target_server FROM public.guilds WHERE id = v_transfer.target_guild;
        IF v_approve_source_server IS NULL OR v_approve_target_server IS NULL
           OR (v_approve_source_server <> v_approve_target_server AND NOT public.servers_in_open_migration_group(v_approve_source_server, v_approve_target_server)) THEN
            RETURN jsonb_build_object('ok', false, 'error', 'different_server');
        END IF;

        UPDATE public.guild_members
        SET guild = v_transfer.target_guild
        WHERE uid = v_transfer.uid
          AND guild = v_transfer.source_guild;

        UPDATE public.accounts
        SET guild = v_transfer.target_guild
        WHERE uid = v_transfer.uid
          AND role = 'member';

        PERFORM public.gm_transfer_sync_related_rows(v_transfer.pseudo, v_transfer.source_guild, v_transfer.target_guild);

        UPDATE public.guild_transfers
        SET status = 'approved',
            resolved_at = now(),
            resolved_by = auth.uid()
        WHERE id = p_transfer_id;

        RETURN jsonb_build_object('ok', true, 'status', 'approved');

    ELSIF p_action = 'reject' THEN
        UPDATE public.guild_transfers
        SET status = 'rejected',
            resolved_at = now(),
            resolved_by = auth.uid()
        WHERE id = p_transfer_id;

        RETURN jsonb_build_object('ok', true, 'status', 'rejected');
    ELSE
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_action');
    END IF;
END;
$function$;

-- ── The stub itself ──────────────────────────────────────────────────────────

DROP FUNCTION public.is_subscription_active(text);

DO $check$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_policies
                WHERE coalesce(qual, '') || coalesce(with_check, '') ILIKE '%is_subscription_active%') THEN
        RAISE EXCEPTION 'a policy still calls is_subscription_active';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
                  AND pg_get_functiondef(p.oid) ILIKE '%is_subscription_active%') THEN
        RAISE EXCEPTION 'a function still calls is_subscription_active';
    END IF;
END;
$check$;

NOTIFY pgrst, 'reload schema';
