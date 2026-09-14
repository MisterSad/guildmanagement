-- Migration: 20260915130000_fix_war_session_day_results_clear.sql
-- Description: Fix gm_upsert_war_session to allow explicitly resetting daily results to NULL (Neutral)
-- Previous migration used COALESCE(v_d1, war_sessions.day1_result) which prevented resetting to NULL.

CREATE OR REPLACE FUNCTION public.gm_upsert_war_session(
    p_guild text,
    p_event_name text,
    p_session_id text,
    p_opponent jsonb DEFAULT NULL,
    p_daily_results jsonb DEFAULT NULL,
    p_start_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
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

    IF NOT public.is_subscription_active(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
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
            SELECT g.name, g.server_number INTO v_name, v_server
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
$$;

REVOKE ALL ON FUNCTION public.gm_upsert_war_session(text, text, text, jsonb, jsonb, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_war_session(text, text, text, jsonb, jsonb, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
