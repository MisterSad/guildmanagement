-- Phase S5: the Event Deep-Dive, and the last caller of gm_stats_data.
--
-- The JavaScript this replaces, `computeEventLeaderboard`, was the third of the
-- five divergent attendance formulas and the least defensible of them: it
-- counted ROWS and divided by the member's OWN row count, so a member with
-- exactly one row scored 100%. It also keyed Shadowfront by `session_id` where
-- every other part of the page keys it by week, so a member in both squads of
-- one week counted twice here and once everywhere else.
--
-- The rate here is att/opp against the member's own opportunities, the same
-- rule as gm_stats_members and gm_stats_health: attendance is
-- `participated > 0 OR sub_present`, opportunities start at the member's roster
-- week, and sessions they were excused from leave their denominator.
--
-- `p_bucket` is validated against a fixed set. It could neither inject nor
-- widen the scan if it were not, but it could quietly select nothing and render
-- an empty table that looks like an absence of data rather than a bad argument.

CREATE OR REPLACE FUNCTION public.gm_stats_events(
    p_guild text,
    p_bucket text,
    p_weeks date[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_target text;
    v_bucket text;
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

    v_bucket := btrim(coalesce(p_bucket, ''));
    IF v_bucket NOT IN ('SvS', 'GvG', 'Shadowfront', 'DTR', 'Arms Race', 'Glory') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unknown_bucket');
    END IF;

    IF p_weeks IS NULL OR array_length(p_weeks, 1) IS NULL THEN
        SELECT array_agg(w ORDER BY w DESC) INTO v_weeks
        FROM (
            SELECT DISTINCT ep.week_start AS w
            FROM public.event_participants ep
            WHERE ep.guild = v_target
              AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
            ORDER BY w DESC LIMIT 1
        ) d;
    ELSE
        SELECT array_agg(w ORDER BY w DESC) INTO v_weeks
        FROM (SELECT DISTINCT unnest(p_weeks) AS w ORDER BY w DESC LIMIT 26) d;
    END IF;

    IF v_weeks IS NULL OR array_length(v_weeks, 1) IS NULL THEN
        v_weeks := ARRAY[(date_trunc('week', now() AT TIME ZONE 'UTC'))::date];
    END IF;

    WITH keyed AS MATERIALIZED (
        SELECT ep.pseudo, ep.week_start, ep.session_id, ep.event_name,
            CASE
              WHEN upper(ep.event_name) LIKE 'ARMS RACE%'      THEN 'Arms Race|'   || coalesce(ep.session_id, ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SHADOWFRONT'        THEN 'Shadowfront|' || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SVS'                THEN 'SvS|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'GVG'                THEN 'GvG|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'DEFEND TRADE ROUTE' THEN 'DTR|'         || coalesce(ep.session_id, ep.week_start::text, '')
              ELSE coalesce(ep.event_name, '') || '|' || coalesce(ep.session_id, ep.week_start::text, '')
            END AS skey,
            (coalesce(ep.participated, 0) > 0 OR ep.sub_present) AS present,
            coalesce(ep.score, 0)       AS score,
            coalesce(ep.score_prep, 0)  AS score_prep,
            coalesce(ep.score_pvp, 0)   AS score_pvp,
            coalesce(ep.late, false)    AS late,
            coalesce(ep.excused, false) AS excused,
            coalesce(ep.sub_present, false) AS sub
        FROM public.event_participants ep
        WHERE ep.guild = v_target
          AND ep.week_start = ANY (v_weeks)
          AND coalesce(ep.is_pending, false) = false
    ),
    scoped AS (
        SELECT * FROM keyed WHERE split_part(skey, '|', 1) = v_bucket
    ),
    per_key AS (
        SELECT pseudo, skey, week_start,
               bool_or(present) AS present,
               bool_or(excused) AS excused,
               bool_or(late)    AS late,
               bool_or(sub)     AS sub,
               max(score)       AS score,
               max(score_prep)  AS score_prep,
               max(score_pvp)   AS score_pvp,
               bool_or(upper(event_name) LIKE '%STAGE A%' OR coalesce(session_id, '') LIKE 'ARA-%') AS stage_a,
               bool_or(upper(event_name) LIKE '%STAGE B%' OR coalesce(session_id, '') LIKE 'ARB-%') AS stage_b
        FROM scoped GROUP BY pseudo, skey, week_start
    ),
    opportunities AS (SELECT DISTINCT skey, week_start FROM per_key),
    roster AS (
        SELECT gm.pseudo, gm.uid, gm.role, coalesce(gm.overall_power, 0) AS overall_power,
               date_trunc('week', gm.created_at)::date AS joined_week
        FROM public.guild_members gm WHERE gm.guild = v_target
    ),
    member_opp AS (
        SELECT r.pseudo, count(*) AS opp
        FROM roster r
        JOIN opportunities o ON o.week_start >= r.joined_week
        WHERE NOT EXISTS (
            SELECT 1 FROM per_key pk WHERE pk.pseudo = r.pseudo AND pk.skey = o.skey AND pk.excused
        )
        GROUP BY r.pseudo
    ),
    member_agg AS (
        SELECT pseudo,
               count(*) FILTER (WHERE present)              AS att,
               count(*) FILTER (WHERE excused)              AS excused_count,
               count(*) FILTER (WHERE late)                 AS late_count,
               count(*) FILTER (WHERE sub)                  AS sub_count,
               count(*) FILTER (WHERE present AND stage_a)  AS stage_a,
               count(*) FILTER (WHERE present AND stage_b)  AS stage_b,
               sum(score)      AS score,
               sum(score_prep) AS score_prep,
               sum(score_pvp)  AS score_pvp
        FROM per_key GROUP BY pseudo
    ),
    squads AS (
        SELECT sq.pseudo,
               count(*)                                                         AS assigned,
               count(*) FILTER (WHERE lower(coalesce(sq.role, '')) = 'reserve')  AS reserve,
               count(*) FILTER (WHERE lower(coalesce(sq.role, '')) <> 'reserve') AS participant,
               count(*) FILTER (WHERE sq.squad = 'squad1')                      AS squad1,
               count(*) FILTER (WHERE sq.squad = 'squad2')                      AS squad2,
               count(*) FILTER (WHERE sq.is_commander)                          AS commander
        FROM public.shadowfront_squads sq
        WHERE v_bucket = 'Shadowfront'
          AND sq.guild = v_target
          AND sq.week_start = ANY (v_weeks)
        GROUP BY sq.pseudo
    ),
    wars AS (
        SELECT ws.session_id,
               ws.opponent_snapshot ->> 'name' AS opponent,
               ws.start_at,
               jsonb_build_object('1', ws.day1_result, '2', ws.day2_result, '3', ws.day3_result,
                                  '4', ws.day4_result, '5', ws.day5_result, '6', ws.day6_result) AS results
        FROM public.war_sessions ws
        WHERE v_bucket IN ('SvS', 'GvG')
          AND ws.guild = v_target
          AND upper(ws.event_name) = upper(v_bucket)
    )
    SELECT jsonb_build_object(
        'ok', true,
        'guild', v_target,
        'bucket', v_bucket,
        'weeks', (SELECT coalesce(jsonb_agg(w ORDER BY w DESC), '[]'::jsonb) FROM unnest(v_weeks) w),
        'sessions', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                'key', o.skey,
                'week_start', o.week_start,
                'present', (SELECT count(*) FROM per_key pk WHERE pk.skey = o.skey AND pk.present)
            ) ORDER BY o.week_start DESC, o.skey), '[]'::jsonb)
            FROM opportunities o
        ),
        'war', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                'session_id', session_id, 'opponent', opponent,
                'start_at', start_at, 'results', results
            ) ORDER BY start_at DESC NULLS LAST), '[]'::jsonb) FROM wars
        ),
        'members', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                'pseudo', r.pseudo,
                'uid', r.uid,
                'role', r.role,
                'overall_power', r.overall_power,
                'att', coalesce(a.att, 0),
                'opp', coalesce(mo.opp, 0),
                'score', coalesce(a.score, 0),
                'score_prep', coalesce(a.score_prep, 0),
                'score_pvp', coalesce(a.score_pvp, 0),
                'late_count', coalesce(a.late_count, 0),
                'excused_count', coalesce(a.excused_count, 0),
                'sub_count', coalesce(a.sub_count, 0),
                'stage_a', coalesce(a.stage_a, 0),
                'stage_b', coalesce(a.stage_b, 0),
                'squad', CASE WHEN v_bucket = 'Shadowfront' THEN jsonb_build_object(
                    'assigned', coalesce(sq.assigned, 0),
                    'participant', coalesce(sq.participant, 0),
                    'reserve', coalesce(sq.reserve, 0),
                    'squad1', coalesce(sq.squad1, 0),
                    'squad2', coalesce(sq.squad2, 0),
                    'commander', coalesce(sq.commander, 0)
                ) ELSE NULL END
            ) ORDER BY r.pseudo), '[]'::jsonb)
            FROM roster r
            LEFT JOIN member_agg a ON a.pseudo = r.pseudo
            LEFT JOIN member_opp mo ON mo.pseudo = r.pseudo
            LEFT JOIN squads sq ON sq.pseudo = r.pseudo
        )
    ) INTO v_result;

    RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.gm_stats_events(text, text, date[]) IS
'Per-member detail for ONE event bucket: attendance against the member own opportunities, scores, Shadowfront squad breakdown, Arms Race stage split, plus the sessions that ran and the war_sessions record for SvS/GvG. Same attendance rule as gm_stats_members (participated > 0 OR sub_present).';

REVOKE ALL ON FUNCTION public.gm_stats_events(text, text, date[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_stats_events(text, text, date[]) TO authenticated, service_role;

DO $verify$
DECLARE v_src text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'gm_stats_events') THEN
        RAISE EXCEPTION 'gm_stats_events was not created';
    END IF;
    IF has_function_privilege('anon', 'public.gm_stats_events(text, text, date[])', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_stats_events must not be callable by anon';
    END IF;
    v_src := pg_get_functiondef('public.gm_stats_events(text, text, date[])'::regprocedure);
    IF position('ALPHA' in v_src) > 0 THEN
        RAISE EXCEPTION 'gm_stats_events must not name a tenant (ADR-003)';
    END IF;
    IF position('o.week_start >= r.joined_week' in v_src) = 0 THEN
        RAISE EXCEPTION 'the denominator must start at the member roster week';
    END IF;
    IF position('unknown_bucket' in v_src) = 0 THEN
        RAISE EXCEPTION 'the bucket argument must be validated against a fixed set';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
