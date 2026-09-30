-- A player can submit their SvS/GvG scores from the Player Portal again.
--
-- The portal's submission path has never recorded anything. Measured on
-- 2026-09-30: `system_audit_logs` holds 8 `score_submission` entries since
-- 2026-08-19, and not one of them has a matching `event_participants` row --
-- each updated zero rows and reported success. Every other attempt was refused:
-- an SvS/GvG war session rejected the Days 1-5 score as
-- `granular_session_use_daily`, and any pre-created row was refused as
-- "already validated". Those are fixed in member-portal.
--
-- This migration is the database half. A war session's daily grid is the single
-- source of truth for prep/PvP scores, so the portal now records a player's
-- scores through `gm_upsert_daily_scores`, as the officers' grid and the OCR
-- already do. That function gated on `check_user_guild_write_access`
-- unconditionally, which answers false whenever `auth.uid()` is NULL -- i.e. for
-- every Edge Function, which calls with the service-role key. Same trap as
-- `gm_upsert_player_glory` (20260928100000), same idiom as
-- `gm_upsert_player_metrics`: gate only when there is a JWT to gate.
--
-- Exposure does not change: EXECUTE is held by `authenticated` and
-- `service_role` only (no `anon`), and an `authenticated` caller always has an
-- `auth.uid()`, so every browser call is still checked.
--
-- The body below is production's definition as of 2026-09-30, with only the
-- gate changed.

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
$function$;

NOTIFY pgrst, 'reload schema';
