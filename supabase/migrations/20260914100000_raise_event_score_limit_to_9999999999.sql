-- ============================================================================
-- FGF GUILD MANAGEMENT — Raise max glory/score tracking to 9,999,999,999
-- Migration: 20260914100000_raise_event_score_limit_to_9999999999.sql
-- Description: widens the INT4 score columns (which cap at ~2.147B) to BIGINT
--              and raises every hard-coded 500_000_000 bound to 9_999_999_999
--              so weekly Glory / SvS / GvG scores up to 9.99B can be stored and
--              validated end-to-end (Edge Zod schemas, daily grid RPC, glory RPC).
-- Invariants:  Multi-tenant, search_path='', non-destructive widening (BIGINT
--              is a strict superset of INTEGER — existing rows keep their values).
-- ============================================================================

-- ============================================================================
-- 1. WIDEN SCORE COLUMNS TO BIGINT
-- ============================================================================

-- event_participants: attendance ledger (score = Glory/total, score_prep = D1-5,
-- score_pvp = D6). INT4 would overflow at 2.147B.
ALTER TABLE public.event_participants
    ALTER COLUMN score      TYPE BIGINT,
    ALTER COLUMN score_prep TYPE BIGINT,
    ALTER COLUMN score_pvp  TYPE BIGINT;

-- event_daily_scores: granular day grid (Day 1..6), added by the war migration.
ALTER TABLE public.event_daily_scores
    ALTER COLUMN score TYPE BIGINT;

-- weekly_scores: weekly rollup (glory_score snapshot) — INT4 would overflow.
ALTER TABLE public.weekly_scores
    ALTER COLUMN glory_score TYPE BIGINT;

-- NOTE: guild_members.glory_score and player_metrics_history.glory_score are
-- already BIGINT (20260817203000) — no ALTER required.

-- ============================================================================
-- 2. RPC — gm_upsert_daily_scores: raise the per-day bound to 9,999,999,999
--    (redefinition of the war-migration version; identical behavior otherwise,
--    plus BIGINT-safe aggregates for the derived score_prep / score_pvp).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.gm_upsert_daily_scores(
    p_guild text,
    p_event_name text,
    p_session_id text,
    p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target       text := TRIM(p_guild);
    v_event        text := TRIM(p_event_name);
    v_sid          text := TRIM(p_session_id);
    v_snapshot     jsonb;
    v_day_tiers    jsonb;
    v_pseudos      text[] := ARRAY[]::text[];
    v_pseudo       text;
    v_day          int;
    v_score        bigint;
    v_chests       int;
    v_el           jsonb;
    v_updated      int := 0;
    v_week         date;
BEGIN
    IF v_event NOT IN ('SvS', 'GvG') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_event');
    END IF;

    IF NOT public.check_user_guild_write_access(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF NOT public.is_subscription_active(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
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

        IF v_day BETWEEN 1 AND 6 AND v_score >= 0 AND v_score <= 9999999999 THEN
            NULL;
        ELSE
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
        END IF;

        v_day_tiers := '[]'::jsonb;
        SELECT COALESCE(jsonb_agg(t ORDER BY (t->>'tier')::int), '[]'::jsonb) INTO v_day_tiers
        FROM jsonb_array_elements(v_snapshot) t
        WHERE (t->>'day')::int = v_day;

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
        IF NOT v_pseudos @> ARRAY[v_pseudo] THEN
            v_pseudos := v_pseudos || ARRAY[v_pseudo];
        END IF;
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
               SUM(CASE WHEN day <= 5 THEN score ELSE 0 END)::bigint AS prep,
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
$$;

REVOKE ALL ON FUNCTION public.gm_upsert_daily_scores(text, text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_daily_scores(text, text, text, jsonb) TO authenticated;

-- ============================================================================
-- 3. RPC — gm_upsert_player_glory: BIGINT parameter + cap raised to 9,999,999,999
--    The old INTEGER signature capped at INT4 max (~2.147B) and its ::integer
--    write-path cast would have silently rounded/overflowed beyond it.
-- ============================================================================
DROP FUNCTION IF EXISTS public.gm_upsert_player_glory(text, text, date, integer);
DROP FUNCTION IF EXISTS public.gm_upsert_player_glory(text, text, text, integer);

CREATE OR REPLACE FUNCTION public.gm_upsert_player_glory(
    p_guild text,
    p_pseudo text,
    p_week_start date,
    p_glory bigint
)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_session text;
    v_safe_glory bigint := GREATEST(0, LEAST(9999999999, COALESCE(p_glory, 0)));
BEGIN
    IF p_guild IS NULL OR p_pseudo IS NULL OR p_week_start IS NULL THEN
        RETURN QUERY SELECT false, 'missing_parameters';
        RETURN;
    END IF;

    IF NOT public.check_user_guild_write_access(p_guild) THEN
        RETURN QUERY SELECT false, 'permission_denied';
        RETURN;
    END IF;

    IF NOT public.is_subscription_active(p_guild) THEN
        RETURN QUERY SELECT false, 'subscription_expired';
        RETURN;
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
$$;

-- text-overload wrapper (same signature shape as before, bigint now)
CREATE OR REPLACE FUNCTION public.gm_upsert_player_glory(
    p_guild text,
    p_pseudo text,
    p_week_start text,
    p_glory bigint
)
RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    RETURN QUERY SELECT * FROM public.gm_upsert_player_glory(p_guild, p_pseudo, p_week_start::date, p_glory);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_upsert_player_glory(text, text, date, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_glory(text, text, date, bigint) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_upsert_player_glory(text, text, text, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_player_glory(text, text, text, bigint) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';