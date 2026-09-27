-- Phase S4: the guild-level half of the Stats page.
--
-- Everything here is data the database already held and the page never asked
-- for. `war_sessions` has carried win/loss per day since it was created, and
-- only HistoryView ever read it, one session at a time.
-- `player_metrics_history` has carried a weekly power snapshot for six weeks
-- and nothing plotted it.
--
-- TWO PRESENTATION RULES ARE ENFORCED HERE RATHER THAN LEFT TO THE UI, because
-- getting either wrong produces a confident lie:
--
--   1. THE POWER SERIES IS A MEDIAN, NOT A SUM. A guild's first OCR week covers
--      only part of the roster -- CLAW went from 11 players scanned to 114 in
--      one week, ALPHA from 137 to 149 over six. A SUM would draw a tenfold
--      jump that never happened. Every point carries `players`, so the card can
--      say what the number is based on.
--
--   2. THE WAR DENOMINATOR IS DAYS ACTUALLY RECORDED, never assumed to be six.
--      Fill across production is 12/12/10/10/10/10 for days 1 to 6.
--
-- `roster_size` is returned ONCE, not per week. The schema keeps no roster
-- history, and repeating today's count against past weeks would look like one.
-- That is precisely the defect in the card this replaces: it divided each
-- historical week by TODAY's roster, so every removal silently rewrote every
-- past bar.
--
-- Written to the repository after the fact. This function was applied to
-- production first, and `tests/rpc_names_exist.test.js` -- added in phase S1
-- for exactly this class of drift -- failed the build until the file existed.
-- The body below is `pg_get_functiondef` of what is deployed.

CREATE OR REPLACE FUNCTION public.gm_stats_health(p_guild text, p_weeks integer DEFAULT 8)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_target text;
    v_n      integer;
    v_weeks  date[];
    v_result jsonb;
BEGIN
    v_target := nullif(btrim(p_guild), '');
    IF v_target IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'guild_required');
    END IF;

    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
    END IF;

    v_n := least(greatest(coalesce(p_weeks, 8), 1), 26);

    SELECT array_agg(w ORDER BY w DESC) INTO v_weeks
    FROM (
        SELECT DISTINCT ep.week_start AS w
        FROM public.event_participants ep
        WHERE ep.guild = v_target
          AND ep.event_name <> 'Glory'
          AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
        ORDER BY w DESC LIMIT v_n
    ) d;

    WITH keyed AS MATERIALIZED (
        SELECT ep.pseudo, ep.week_start,
            CASE
              WHEN upper(ep.event_name) LIKE 'ARMS RACE%'      THEN 'Arms Race|'   || coalesce(ep.session_id, ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SHADOWFRONT'        THEN 'Shadowfront|' || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SVS'                THEN 'SvS|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'GVG'                THEN 'GvG|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'DEFEND TRADE ROUTE' THEN 'DTR|'         || coalesce(ep.session_id, ep.week_start::text, '')
              ELSE coalesce(ep.event_name, '') || '|' || coalesce(ep.session_id, ep.week_start::text, '')
            END AS skey,
            (coalesce(ep.participated, 0) > 0 OR ep.sub_present) AS present
        FROM public.event_participants ep
        WHERE ep.guild = v_target
          AND ep.week_start = ANY (coalesce(v_weeks, ARRAY[]::date[]))
          AND coalesce(ep.is_pending, false) = false
          AND ep.event_name <> 'Glory'
    ),
    per_week AS (
        SELECT week_start,
               count(DISTINCT skey) AS opportunities,
               count(DISTINCT pseudo) FILTER (WHERE present) AS present_members
        FROM keyed GROUP BY week_start
    ),
    power AS (
        SELECT h.week_start,
               count(*) AS players,
               round(avg(h.total_power))::bigint AS avg_power,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY h.total_power)::bigint AS median_power
        FROM public.player_metrics_history h
        WHERE h.guild = v_target AND coalesce(h.total_power, 0) > 0
        GROUP BY h.week_start
    ),
    war_days AS (
        SELECT ws.event_name, ws.session_id, v.day, v.result
        FROM public.war_sessions ws,
             LATERAL (VALUES (1, ws.day1_result), (2, ws.day2_result), (3, ws.day3_result),
                             (4, ws.day4_result), (5, ws.day5_result), (6, ws.day6_result)) AS v(day, result)
        WHERE ws.guild = v_target AND v.result IN ('won', 'lost')
    ),
    war AS (
        SELECT event_name,
               count(DISTINCT session_id) AS sessions,
               count(*) FILTER (WHERE result = 'won')  AS day_wins,
               count(*) FILTER (WHERE result = 'lost') AS day_losses,
               jsonb_object_agg(day::text, per_day) AS per_day
        FROM (
            SELECT event_name, session_id, day, result,
                   jsonb_build_object(
                     'won',  count(*) FILTER (WHERE result = 'won')  OVER (PARTITION BY event_name, day),
                     'lost', count(*) FILTER (WHERE result = 'lost') OVER (PARTITION BY event_name, day)
                   ) AS per_day
            FROM war_days
        ) x
        GROUP BY event_name
    ),
    roster AS (SELECT * FROM public.guild_members WHERE guild = v_target)
    SELECT jsonb_build_object(
        'ok', true,
        'guild', v_target,
        'weeks', coalesce(array_length(v_weeks, 1), 0),
        'roster_size', (SELECT count(*) FROM roster),
        'participation', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                'week_start', week_start,
                'opportunities', opportunities,
                'present_members', present_members
            ) ORDER BY week_start), '[]'::jsonb) FROM per_week
        ),
        'war', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                'event_name', event_name,
                'sessions', sessions,
                'day_wins', day_wins,
                'day_losses', day_losses,
                'per_day', per_day
            ) ORDER BY event_name), '[]'::jsonb) FROM war
        ),
        'power', jsonb_build_object(
            'series', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'week_start', week_start, 'players', players,
                    'median', median_power, 'avg', avg_power
                ) ORDER BY week_start), '[]'::jsonb) FROM power),
            'weeks', (SELECT count(*) FROM power)
        ),
        'coverage', (
            SELECT jsonb_build_object(
                'members', count(*),
                'overall_power',  count(*) FILTER (WHERE coalesce(overall_power, 0)  > 0),
                'tech_power',     count(*) FILTER (WHERE coalesce(tech_power, 0)     > 0),
                'champion_power', count(*) FILTER (WHERE coalesce(champion_power, 0) > 0),
                'crew_power',     count(*) FILTER (WHERE coalesce(crew_power, 0)     > 0),
                'flagship_power', count(*) FILTER (WHERE coalesce(flagship_power, 0) > 0),
                'fleet_rating',   count(*) FILTER (WHERE coalesce(fleet_rating, 0)   > 0),
                'glory_score',    count(*) FILTER (WHERE coalesce(glory_score, 0)    > 0)
            ) FROM roster
        ),
        'quality', jsonb_build_object(
            'pending_rows', (SELECT count(*) FROM public.event_participants
                             WHERE guild = v_target AND coalesce(is_pending, false)),
            'weeks_with_data', (SELECT count(DISTINCT week_start) FROM public.event_participants
                                WHERE guild = v_target AND event_name <> 'Glory'),
            'last_week', (SELECT max(week_start) FROM public.event_participants
                          WHERE guild = v_target AND event_name <> 'Glory')
        )
    ) INTO v_result;

    RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.gm_stats_health(text, integer) IS
'Guild-level health for the Stats page: participation per week, war win/loss per event and per day, the power series (median, with its sample size), per-metric OCR coverage, and data-quality counters. Read-only, admin-gated through gm_can_read_guild_data, no tenant fallback.';

REVOKE ALL ON FUNCTION public.gm_stats_health(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_stats_health(text, integer) TO authenticated, service_role;

DO $verify$
DECLARE v_src text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'gm_stats_health') THEN
        RAISE EXCEPTION 'gm_stats_health was not created';
    END IF;
    IF has_function_privilege('anon', 'public.gm_stats_health(text, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_stats_health must not be callable by anon';
    END IF;
    v_src := pg_get_functiondef('public.gm_stats_health(text, integer)'::regprocedure);
    IF position('ALPHA' in v_src) > 0 THEN
        RAISE EXCEPTION 'gm_stats_health must not name a tenant (ADR-003)';
    END IF;
    IF position('percentile_cont(0.5)' in v_src) = 0 THEN
        RAISE EXCEPTION 'the power series must report a median; a sum misreads partial OCR coverage as growth';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
