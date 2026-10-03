-- The data-quality card reported a week that has not started.
--
-- 1,555 rows across 5 guilds sit in next week: events are populated ahead of
-- time. `weeks_with_data` and `last_week` counted them, so ALPHA's card read
-- "Last week 2026-09-28" on 2026-09-27 -- a Sunday, with the current week
-- being 2026-09-21. Every other part of this function already bounds on
-- `week_start <= date_trunc('week', now())`; these two counters did not.

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
    v_now    date;
    v_result jsonb;
BEGIN
    v_target := nullif(btrim(p_guild), '');
    IF v_target IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'guild_required');
    END IF;

    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
    END IF;

    v_n   := least(greatest(coalesce(p_weeks, 8), 1), 26);
    v_now := (date_trunc('week', now() AT TIME ZONE 'UTC'))::date;

    SELECT array_agg(w ORDER BY w DESC) INTO v_weeks
    FROM (
        SELECT DISTINCT date_trunc('week', ep.week_start)::date AS w
        FROM public.event_participants ep
        WHERE ep.guild = v_target
          AND ep.event_name <> 'Glory'
          AND ep.week_start <= v_now
        ORDER BY w DESC LIMIT v_n
    ) d;

    WITH keyed AS MATERIALIZED (
        SELECT ep.pseudo, date_trunc('week', ep.week_start)::date AS week_start,
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
          AND date_trunc('week', ep.week_start)::date = ANY (coalesce(v_weeks, ARRAY[]::date[]))
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
        SELECT date_trunc('week', h.week_start)::date AS week_start,
               count(*) AS players,
               round(avg(h.total_power))::bigint AS avg_power,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY h.total_power)::bigint AS median_power
        FROM public.player_metrics_history h
        WHERE h.guild = v_target AND coalesce(h.total_power, 0) > 0
          AND h.week_start <= v_now
        GROUP BY date_trunc('week', h.week_start)::date
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
            -- Bounded like everything else. Events are populated ahead of time
            -- -- 1,555 rows across 5 guilds sat in next week -- and counting
            -- them made the card announce a week that had not started.
            'weeks_with_data', (SELECT count(DISTINCT date_trunc('week', week_start)::date)
                                FROM public.event_participants
                                WHERE guild = v_target AND event_name <> 'Glory'
                                  AND week_start <= v_now),
            'last_week', (SELECT max(date_trunc('week', week_start)::date)
                          FROM public.event_participants
                          WHERE guild = v_target AND event_name <> 'Glory'
                            AND week_start <= v_now),
            'scheduled_ahead', (SELECT count(*) FROM public.event_participants
                                WHERE guild = v_target AND week_start > v_now)
        )
    ) INTO v_result;

    RETURN v_result;
END
$function$;

DO $verify$
DECLARE v_src text;
BEGIN
    v_src := pg_get_functiondef('public.gm_stats_health(text, integer)'::regprocedure);
    IF position('scheduled_ahead' in v_src) = 0 THEN
        RAISE EXCEPTION 'rows in future weeks must be reported separately, not counted as recorded history';
    END IF;
    IF position('AND week_start <= v_now' in v_src) = 0 THEN
        RAISE EXCEPTION 'the quality counters must be bounded to the current week';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
