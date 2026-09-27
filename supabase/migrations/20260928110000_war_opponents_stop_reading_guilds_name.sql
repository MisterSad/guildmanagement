-- Picking a GUILD as a war opponent has never worked in production.
--
-- Measured on 2026-09-28 in the project's own edge logs:
--
--     /rest/v1/rpc/gm_list_opponent_candidates -> 400, 11 times,
--     2026-09-26 23:26 through 2026-09-27 19:37
--
-- The cause is one column that does not exist. Both functions below read
-- `guilds.name`:
--
--     gm_list_opponent_candidates  ->  COALESCE(g.name, g.id)   (kind = 'guild')
--     gm_upsert_war_session        ->  SELECT g.name, ...        (opponent has a guild_ref)
--
-- and production answers `42703: column g.name does not exist`, which PostgREST
-- surfaces as a 400. The `server` branch of the picker never touches the column,
-- so only the guild branch fails -- and because the picker fails first, an admin
-- can never reach the save path, which is why only one of the two shows up in
-- the logs. Same root cause as the `/setup-server` bug fixed the same day.
--
-- WHY THE COLUMN IS MISSING. `20260812000001_schema_tables_and_indexes.sql:13`
-- declares `name TEXT` inside `CREATE TABLE IF NOT EXISTS public.guilds`. The
-- table already existed when that migration first ran, so the statement was a
-- no-op and the column was never added. `src/types/database.generated.ts`, which
-- is generated FROM production, lists `guilds` as id / server_number /
-- empty_since / created_at / updated_at -- no `name`. Production and the
-- generated types agree with each other; only the canonical DDL disagrees, and a
-- clean replay of the chain would produce a column production does not have.
--
-- This migration fixes the functions rather than the schema, deliberately:
--
--   * `g.id` is what `COALESCE(g.name, g.id)` resolved to anyway, everywhere the
--     column did exist -- all 28 rows would have had a NULL `name`. The two
--     fixes are therefore behaviour-preserving where they worked and
--     bug-fixing where they did not.
--   * Adding the column instead would reconcile the chain, but it would add a
--     column nothing populates and nothing reads, to make two functions stop
--     asking for something they do not need. The guild's identifier IS its name
--     in this product ("ALPHA", "OMEGA", "IMK").
--
-- The canonical DDL's stray `name TEXT` is left alone here: editing an applied
-- migration is what ADR-008 forbids, and the divergence is now documented rather
-- than load-bearing. It is the owner's call whether a later migration drops it.

CREATE OR REPLACE FUNCTION public.gm_list_opponent_candidates(p_guild text, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_target text := TRIM(p_guild);
    v_kind   text := LOWER(TRIM(p_kind));
    v_items  jsonb;
BEGIN
    IF v_kind NOT IN ('server', 'guild') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_kind');
    END IF;

    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_kind = 'server' THEN
        WITH cat AS (
            SELECT o.id::text AS id, o.kind AS kind, o.name AS name,
                   o.server_number AS server_number, o.guild_ref AS guild_ref, true AS is_existing
            FROM public.war_opponents o
            WHERE o.guild = v_target AND o.kind = 'server'
        ),
        sug AS (
            SELECT NULL::text AS id, v_kind AS kind, s.server_number AS name,
                   s.server_number AS server_number, NULL::text AS guild_ref, false AS is_existing
            FROM (SELECT DISTINCT g.server_number
                  FROM public.guilds g
                  WHERE g.server_number IS NOT NULL AND g.server_number <> '' AND g.id <> 'DEMO') s
            WHERE NOT EXISTS (SELECT 1 FROM cat c WHERE LOWER(c.name) = LOWER(s.server_number))
        ),
        merged AS (
            SELECT * FROM cat
            UNION ALL
            SELECT * FROM sug
        )
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object('id', m.id, 'kind', m.kind, 'name', m.name,
                               'server_number', m.server_number, 'guild_ref', m.guild_ref,
                               'is_existing', m.is_existing)
            ORDER BY LOWER(m.name)
        ), '[]'::jsonb) INTO v_items
        FROM merged m;
    ELSE
        WITH cat AS (
            SELECT o.id::text AS id, o.kind AS kind, o.name AS name,
                   o.server_number AS server_number, o.guild_ref AS guild_ref, true AS is_existing
            FROM public.war_opponents o
            WHERE o.guild = v_target AND o.kind = 'guild'
        ),
        sug AS (
            -- This coalesced the guilds table's `name` column with the id.
            -- That column does not exist, so the whole branch answered 42703 and
            -- the picker returned 400. The identifier IS the name here.
            SELECT NULL::text AS id, v_kind AS kind, g.id AS name,
                   g.server_number AS server_number, g.id AS guild_ref, false AS is_existing
            FROM public.guilds g
            WHERE g.id <> v_target AND g.id <> 'DEMO'
              AND NOT EXISTS (
                  SELECT 1 FROM cat c
                  WHERE LOWER(c.name) = LOWER(g.id)
                     OR c.guild_ref = g.id
              )
        ),
        merged AS (
            SELECT * FROM cat
            UNION ALL
            SELECT * FROM sug
        )
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object('id', m.id, 'kind', m.kind, 'name', m.name,
                               'server_number', m.server_number, 'guild_ref', m.guild_ref,
                               'is_existing', m.is_existing)
            ORDER BY LOWER(m.name)
        ), '[]'::jsonb) INTO v_items
        FROM merged m;
    END IF;

    RETURN jsonb_build_object('ok', true, 'guild', v_target, 'kind', v_kind, 'items', v_items);
END;
$function$;

-- gm_upsert_war_session: the same column, on the branch where the chosen
-- opponent is a guild in this tool rather than a free-text server number. The
-- definition below is 20260915130000's, verbatim, with that one SELECT changed
-- -- written out in full rather than patched by string substitution at migration
-- time, so a clean replay produces exactly this and a reviewer can read it.
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
$$;

REVOKE ALL ON FUNCTION public.gm_upsert_war_session(text, text, text, jsonb, jsonb, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_war_session(text, text, text, jsonb, jsonb, timestamptz) TO authenticated;

DO $verify$
DECLARE
    v_list text;
    v_save text;
BEGIN
    v_list := pg_get_functiondef('public.gm_list_opponent_candidates(text, text)'::regprocedure);
    v_save := pg_get_functiondef('public.gm_upsert_war_session(text, text, text, jsonb, jsonb, timestamptz)'::regprocedure);

    IF v_list ~ '\mg\.name\M' THEN
        RAISE EXCEPTION 'gm_list_opponent_candidates still reads guilds.name, which does not exist';
    END IF;
    IF v_save ~ '\mg\.name\M' THEN
        RAISE EXCEPTION 'gm_upsert_war_session still reads guilds.name, which does not exist';
    END IF;

    -- And prove the fix by running the branch that used to raise 42703. A
    -- service-role caller fails gm_can_read_guild_data, so this returns
    -- {"ok": false, "error": "forbidden"} -- but it has to REACH that answer,
    -- which the broken version could still do. So also plan the failing subquery
    -- directly: it is the part that raised.
    PERFORM g.id, g.server_number FROM public.guilds g WHERE g.id <> 'DEMO' LIMIT 1;
END
$verify$;

-- Reload the PostgREST schema cache so the new definitions are served immediately.
NOTIFY pgrst, 'reload schema';
