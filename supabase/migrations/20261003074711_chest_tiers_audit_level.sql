-- Saving chest tiers has never worked in production.
--
-- gm_save_chest_tiers (20260915120000_widen_chest_tiers_limit.sql) ends by
-- writing an audit line with level 'info'. system_audit_logs only accepts
-- upper case:
--
--   CHECK (level = ANY (ARRAY['DEBUG','INFO','WARN','ERROR','FATAL']))
--
-- so the INSERT raised 23514 and rolled back the whole call, tiers included --
-- AFTER every validation had passed. Every save returned an error. Measured live
-- on 2026-10-03: event_chest_tiers held 0 rows across all 35 guilds, and
-- system_audit_logs 0 lines from service 'war_chest_tiers'. A call as
-- super_admin on DEMO inside BEGIN ... ROLLBACK reproduced it:
-- "23514 new row for relation system_audit_logs violates check constraint
-- system_audit_logs_level_check".
--
-- The fix is the one literal. The body below is the live pg_get_functiondef
-- text, unchanged apart from 'info' -> 'INFO'. The other six functions that
-- write to system_audit_logs already use upper case (checked live the same day),
-- and tests/audit_log_levels.test.js now holds every migration to it.

DO $$
BEGIN
    IF position('''info'', ''war_chest_tiers''' IN
                pg_get_functiondef('public.gm_save_chest_tiers(text,text,jsonb)'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'gm_save_chest_tiers has drifted from the definition this migration was written against';
    END IF;
END;
$$;

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

    IF NOT public.is_subscription_active(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
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
    WHERE a.auth_user_id = auth.uid() LIMIT 1;

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

-- CREATE OR REPLACE keeps the ACL; restated so the intent is in the file.
REVOKE ALL ON FUNCTION public.gm_save_chest_tiers(text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_save_chest_tiers(text, text, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
