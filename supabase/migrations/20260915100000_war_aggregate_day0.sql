-- ============================================================================
-- FGF GUILD MANAGEMENT — SvS / GvG WAR AGGREGATE DAY-0 (Lot 1)
-- Migration: 20260915100000_war_aggregate_day0.sql
-- Description: enables the two prep entry modes (per-day D1..D5 vs cumulative
--              "Day 1 to 5 total") with ZERO double-counting by converging each
--              player to exactly ONE prep source per session, enforced in the
--              database (gm_upsert_daily_scores), not only in the UI:
--                * event_daily_scores.day accepts 0..6 (0 = aggregate total),
--                * event_chest_tiers.day accepts 0..6 (day 0 = cumulative tiers
--                  for the prep total, paramétrable comme les autres jours),
--                * gm_save_chest_tiers accepts the day-0 bucket,
--                * gm_upsert_daily_scores applies a transactional convergence
--                  rule (aggregate wins on conflict) and derives the
--                  event_participants cache from the grid
--                  (score_prep = day 0..5, score_pvp = day 6, score = NULL),
--                * aggregate chests use the day-0 tier slice, with a
--                  deterministic fallback to the day-1 slice when no day-0 tier
--                  has been frozen into the session,
--                * member-portal rejects any direct score_prep write against a
--                  session that owns a war_sessions row.
-- Invariants:  Zero-trust multi-tenant (SECURITY DEFINER, search_path=''),
--              no destructive ALTER of existing rows, retro-compatible with
--              every existing daily/granular session.
-- ============================================================================

-- ============================================================================
-- 1. WIDEN DAY CHECKS TO 0..6
-- ============================================================================

-- 1.1 event_daily_scores.day: 0 = aggregate "Day 1 to 5 total", 1..6 = days.
ALTER TABLE public.event_daily_scores
    DROP CONSTRAINT IF EXISTS event_daily_scores_day_check;
ALTER TABLE public.event_daily_scores
    ADD CONSTRAINT event_daily_scores_day_check CHECK (day BETWEEN 0 AND 6);

-- 1.2 event_chest_tiers.day: 0 = cumulative thresholds for the prep total.
ALTER TABLE public.event_chest_tiers
    DROP CONSTRAINT IF EXISTS event_chest_tiers_day_check;
ALTER TABLE public.event_chest_tiers
    ADD CONSTRAINT event_chest_tiers_day_check CHECK (day BETWEEN 0 AND 6);

-- ============================================================================
-- 2. RPC — gm_save_chest_tiers: accept the day-0 aggregate bucket (0..6).
--    Same validation/audit contract as before; the ascending-threshold check
--    for the day-0 bucket uses a dedicated accumulator (Postgres arrays are
--    1-indexed, so day 0 cannot reuse the v_last_min[] slots).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.gm_save_chest_tiers(p_guild text, p_event_name text, p_tiers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
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

    IF NOT public.is_subscription_active(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF jsonb_typeof(p_tiers) <> 'array' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
    END IF;

    IF jsonb_array_length(p_tiers) > 60 THEN
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
    WHERE a.auth_user_id = auth.uid() LIMIT 1;

    INSERT INTO public.system_audit_logs (
        level, service, guild, user_identifier, message, metadata, created_at
    ) VALUES (
        'info', 'war_chest_tiers', v_target,
        COALESCE(v_caller_id, auth.uid()::text, 'Admin'),
        'Saved chest tiers',
        jsonb_build_object('event_name', v_event, 'tiers_saved', v_n),
        now()
    );

    RETURN jsonb_build_object('ok', true, 'saved', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_save_chest_tiers(text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_save_chest_tiers(text, text, jsonb) TO authenticated;

-- ============================================================================
-- 3. RPC — gm_upsert_daily_scores: day 0..6 + transactional convergence.
--    ZERO double-counting guarantee: a player can NEVER hold both a day-0 row
--    and day 1..5 rows on the same session. When a batch mixes both for the
--    same pseudo, the aggregate (day 0) wins deterministically. Day 6 is never
--    touched by the convergence rule.
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
$$;

REVOKE ALL ON FUNCTION public.gm_upsert_daily_scores(text, text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_daily_scores(text, text, text, jsonb) TO authenticated;

-- ============================================================================
-- 4. MEMBER-PORTAL INTEGRITY GUARD (documentation of the paired Edge change)
--    Direct score_prep writes from the portal against a session that owns a
--    war_sessions row would be silently overwritten by the next
--    gm_upsert_daily_scores derivation. The paired client-side guard lives in
--    supabase/functions/member-portal/index.ts (submit-scores action) and
--    rejects such writes with error "granular_session_use_daily". No SQL is
--    required here: the DB invariant (never day 0 + days 1..5 together) is
--    guaranteed by the convergence logic in gm_upsert_daily_scores above, and
--    all writes to the grid flow through it.
-- ============================================================================

NOTIFY pgrst, 'reload schema';