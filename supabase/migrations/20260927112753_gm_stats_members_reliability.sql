-- Phase S3: one attendance rule, a denominator per member, and a trend.
--
-- WHAT WAS WRONG. The page measured every member against "everything the guild
-- ran". Measured on ALPHA, week of 2026-08-31: 7 Arms Race sessions, 3 DTR,
-- 1 Shadowfront, 1 SvS, 1 GvG. Arms Race is daily and structurally skipped --
-- 16.2% participation across production -- so it decided 54% of the score while
-- the SvS, the event the guild actually organises around, decided 7.7%. Real
-- rates on ALPHA ran from 9% to 57%, which is not a number anyone can act on.
--
-- WHAT REPLACES IT. A rate per bucket, then one weighted number:
--
--     reliability = 100 * SUM_b coeff(b) * att(m,b) / SUM_b coeff(b) * opp(m,b)
--
-- The coefficients are the tenant's own (guild_config: coeff_svs, coeff_gvg,
-- coeff_shadowfront, coeff_dtr, coeff_armsrace) and are applied in TypeScript,
-- not here -- see the note in 20260927150000 about finding B1.
--
-- THREE THINGS THIS FIXES, EACH MEASURED FIRST.
--
-- 1. ONE ATTENDANCE RULE. The codebase had five, and they disagreed. The rule
--    kept is `participated > 0 OR sub_present`. The variant that also counted
--    "any recorded score" is dropped, and that costs nothing at all: across all
--    49,701 non-Glory rows, the number that carry a score WITHOUT being marked
--    present is exactly ZERO. The clause could never add anyone. It only ever
--    made two boards disagree about the same member.
--
-- 2. A DENOMINATOR PER MEMBER. Opportunities now count from the week a member
--    appears on the roster, so a recruit is not marked absent for wars fought
--    before they existed. This is not hypothetical: over an 8-week window YARR
--    has 26 of 167 members who joined after it started, SEN 13, EXPO 13,
--    OMEGA 12, ALPHA 8. Honest caveat, recorded here because it will be asked:
--    guild_members.created_at is when the roster row was first scanned, not
--    when the player joined the guild. It is the best evidence in the schema
--    and it is strictly better than pretending everyone was always there.
--
-- 3. EXCUSED LEAVES THE DENOMINATOR. An excused absence is removed from that
--    member's opportunities rather than displayed in a column. Only 0.41% of
--    rows carry it today, so it moves almost nothing -- but it gives the flag a
--    job, and an admin no longer has to hold the exceptions in their head.
--
-- WHAT THE UI MUST DO WITH opp = 0: render an em dash, never "0%". A guild that
-- ran no Shadowfront this month must not make its members look absent from it.
-- That is the difference between "did not attend" and "was never asked".

CREATE OR REPLACE FUNCTION public.gm_stats_members(
    p_guild text,
    p_weeks date[] DEFAULT NULL,
    p_trend boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_target        text;
    v_weeks         date[];
    v_trend_recent  date[];
    v_trend_prior   date[];
    v_result        jsonb;
BEGIN
    v_target := nullif(btrim(p_guild), '');
    IF v_target IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'guild_required');
    END IF;

    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
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

    -- Trend windows: the four most recent weeks that have data, against the
    -- four before them. Derived from weeks that EXIST, not from the calendar,
    -- so a guild that skipped a week is not compared against an empty one.
    IF p_trend THEN
        WITH w AS (
            SELECT DISTINCT ep.week_start AS ws
            FROM public.event_participants ep
            WHERE ep.guild = v_target
              AND ep.event_name <> 'Glory'
              AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
        ), ranked AS (
            SELECT ws, row_number() OVER (ORDER BY ws DESC) AS rn FROM w
        )
        SELECT array_agg(ws) FILTER (WHERE rn <= 4),
               array_agg(ws) FILTER (WHERE rn > 4 AND rn <= 8)
          INTO v_trend_recent, v_trend_prior
        FROM ranked;
    END IF;

    WITH keyed AS MATERIALIZED (
        SELECT
            ep.pseudo,
            ep.week_start,
            CASE
              WHEN upper(ep.event_name) LIKE 'ARMS RACE%'      THEN 'Arms Race|'   || coalesce(ep.session_id, ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SHADOWFRONT'        THEN 'Shadowfront|' || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SVS'                THEN 'SvS|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'GVG'                THEN 'GvG|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'DEFEND TRADE ROUTE' THEN 'DTR|'         || coalesce(ep.session_id, ep.week_start::text, '')
              ELSE coalesce(ep.event_name, '') || '|' || coalesce(ep.session_id, ep.week_start::text, '')
            END AS skey,
            -- The one rule. See note 1 in the header.
            (coalesce(ep.participated, 0) > 0 OR ep.sub_present) AS present,
            (ep.event_name IN ('SvS', 'GvG')
             AND (coalesce(ep.score, 0) + coalesce(ep.score_prep, 0) + coalesce(ep.score_pvp, 0)) > 0) AS scored,
            coalesce(ep.late, false)        AS late,
            coalesce(ep.excused, false)     AS excused,
            coalesce(ep.sub_present, false) AS sub
        FROM public.event_participants ep
        WHERE ep.guild = v_target
          AND ep.week_start = ANY (v_weeks)
          AND coalesce(ep.is_pending, false) = false
          AND ep.event_name <> 'Glory'
    ),
    per_key AS (
        SELECT pseudo, skey, split_part(skey, '|', 1) AS bucket, week_start,
               bool_or(present) AS present,
               bool_or(scored)  AS scored,
               bool_or(excused) AS excused
        FROM keyed GROUP BY pseudo, skey, week_start
    ),
    -- Everything the guild ran in the window, once each.
    opportunities AS (
        SELECT DISTINCT skey, bucket, week_start FROM per_key
    ),
    roster AS (
        SELECT gm.pseudo, gm.uid, gm.role, coalesce(gm.overall_power, 0) AS overall_power,
               date_trunc('week', gm.created_at)::date AS joined_week
        FROM public.guild_members gm
        WHERE gm.guild = v_target
    ),
    -- The denominator, per member: opportunities from their joining week
    -- onward, minus the ones they were excused from.
    member_opp AS (
        SELECT r.pseudo, o.bucket, count(*) AS opp
        FROM roster r
        JOIN opportunities o ON o.week_start >= r.joined_week
        WHERE NOT EXISTS (
            SELECT 1 FROM per_key pk
            WHERE pk.pseudo = r.pseudo AND pk.skey = o.skey AND pk.excused
        )
        GROUP BY r.pseudo, o.bucket
    ),
    member_att AS (
        SELECT pseudo, bucket,
               count(*) FILTER (WHERE present)            AS att,
               count(*) FILTER (WHERE present AND scored) AS att_scored,
               count(*) FILTER (WHERE excused)            AS exc
        FROM per_key GROUP BY pseudo, bucket
    ),
    per_member AS (
        SELECT pk.pseudo,
               count(*) FILTER (WHERE pk.present)                      AS attended,
               count(DISTINCT pk.week_start) FILTER (WHERE pk.present) AS weeks_active,
               max(pk.week_start) FILTER (WHERE pk.present)            AS last_seen_week
        FROM per_key pk GROUP BY pk.pseudo
    ),
    flags AS (
        SELECT pseudo,
               count(*) FILTER (WHERE late)    AS late_count,
               count(*) FILTER (WHERE excused) AS excused_count,
               count(*) FILTER (WHERE sub)     AS sub_count
        FROM keyed GROUP BY pseudo
    ),
    glory AS (
        SELECT ep.pseudo, ep.week_start, max(coalesce(ep.score, 0)) AS score
        FROM public.event_participants ep
        WHERE ep.guild = v_target
          AND ep.event_name = 'Glory'
          AND ep.week_start = ANY (v_weeks)
          AND coalesce(ep.score, 0) > 0
        GROUP BY ep.pseudo, ep.week_start
    ),
    -- The trend runs over its own windows, independent of p_weeks.
    trend_keyed AS (
        SELECT ep.pseudo, ep.week_start,
            CASE
              WHEN upper(ep.event_name) LIKE 'ARMS RACE%'      THEN 'Arms Race|'   || coalesce(ep.session_id, ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SHADOWFRONT'        THEN 'Shadowfront|' || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SVS'                THEN 'SvS|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'GVG'                THEN 'GvG|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'DEFEND TRADE ROUTE' THEN 'DTR|'         || coalesce(ep.session_id, ep.week_start::text, '')
              ELSE coalesce(ep.event_name, '') || '|' || coalesce(ep.session_id, ep.week_start::text, '')
            END AS skey,
            (coalesce(ep.participated, 0) > 0 OR ep.sub_present) AS present,
            coalesce(ep.excused, false) AS excused,
            CASE WHEN ep.week_start = ANY (coalesce(v_trend_recent, ARRAY[]::date[])) THEN 'recent'
                 WHEN ep.week_start = ANY (coalesce(v_trend_prior,  ARRAY[]::date[])) THEN 'prior' END AS win
        FROM public.event_participants ep
        WHERE p_trend
          AND ep.guild = v_target
          AND coalesce(ep.is_pending, false) = false
          AND ep.event_name <> 'Glory'
          AND (ep.week_start = ANY (coalesce(v_trend_recent, ARRAY[]::date[]))
            OR ep.week_start = ANY (coalesce(v_trend_prior,  ARRAY[]::date[])))
    ),
    trend_key AS (
        SELECT pseudo, skey, split_part(skey, '|', 1) AS bucket, week_start, win,
               bool_or(present) AS present, bool_or(excused) AS excused
        FROM trend_keyed WHERE win IS NOT NULL
        GROUP BY pseudo, skey, week_start, win
    ),
    trend_opp_all AS (SELECT DISTINCT skey, bucket, week_start, win FROM trend_key),
    trend_opp AS (
        SELECT r.pseudo, o.win, o.bucket, count(*) AS opp
        FROM roster r JOIN trend_opp_all o ON o.week_start >= r.joined_week
        WHERE NOT EXISTS (
            SELECT 1 FROM trend_key tk
            WHERE tk.pseudo = r.pseudo AND tk.skey = o.skey AND tk.excused
        )
        GROUP BY r.pseudo, o.win, o.bucket
    ),
    trend_att AS (
        SELECT pseudo, win, bucket, count(*) FILTER (WHERE present) AS att
        FROM trend_key GROUP BY pseudo, win, bucket
    )
    SELECT jsonb_build_object(
        'ok', true,
        'guild', v_target,
        'weeks', (SELECT coalesce(jsonb_agg(w ORDER BY w DESC), '[]'::jsonb) FROM unnest(v_weeks) w),
        'tenant', jsonb_build_object(
            'total_events', (SELECT count(*) FROM opportunities),
            'buckets', (SELECT coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
                        FROM (SELECT bucket, count(*) AS n FROM opportunities GROUP BY bucket) b)
        ),
        'trend', CASE WHEN p_trend THEN jsonb_build_object(
            'weeks_recent', coalesce(array_length(v_trend_recent, 1), 0),
            'weeks_prior',  coalesce(array_length(v_trend_prior, 1), 0)
        ) ELSE NULL END,
        'members', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                'pseudo', r.pseudo,
                'uid', r.uid,
                'role', r.role,
                'overall_power', r.overall_power,
                'joined_week', r.joined_week,
                'attended', coalesce(pm.attended, 0),
                'weeks_active', coalesce(pm.weeks_active, 0),
                'last_seen_week', pm.last_seen_week,
                'late_count', coalesce(f.late_count, 0),
                'excused_count', coalesce(f.excused_count, 0),
                'sub_count', coalesce(f.sub_count, 0),
                'buckets', coalesce((
                    SELECT jsonb_object_agg(mo.bucket, jsonb_build_object(
                        'att', coalesce(ma.att, 0),
                        'opp', mo.opp,
                        'exc', coalesce(ma.exc, 0),
                        'att_scored', coalesce(ma.att_scored, 0)))
                    FROM member_opp mo
                    LEFT JOIN member_att ma ON ma.pseudo = mo.pseudo AND ma.bucket = mo.bucket
                    WHERE mo.pseudo = r.pseudo
                ), '{}'::jsonb),
                'trend', CASE WHEN p_trend THEN jsonb_build_object(
                    'recent', coalesce((
                        SELECT jsonb_object_agg(t.bucket, jsonb_build_object('att', coalesce(ta.att, 0), 'opp', t.opp))
                        FROM trend_opp t
                        LEFT JOIN trend_att ta ON ta.pseudo = t.pseudo AND ta.win = t.win AND ta.bucket = t.bucket
                        WHERE t.pseudo = r.pseudo AND t.win = 'recent'
                    ), '{}'::jsonb),
                    'prior', coalesce((
                        SELECT jsonb_object_agg(t.bucket, jsonb_build_object('att', coalesce(ta.att, 0), 'opp', t.opp))
                        FROM trend_opp t
                        LEFT JOIN trend_att ta ON ta.pseudo = t.pseudo AND ta.win = t.win AND ta.bucket = t.bucket
                        WHERE t.pseudo = r.pseudo AND t.win = 'prior'
                    ), '{}'::jsonb)
                ) ELSE NULL END
            ) ORDER BY r.pseudo), '[]'::jsonb)
            FROM roster r
            LEFT JOIN per_member pm ON pm.pseudo = r.pseudo
            LEFT JOIN flags f       ON f.pseudo  = r.pseudo
        ),
        'glory', (
            SELECT coalesce(jsonb_agg(jsonb_build_array(pseudo, week_start, score)), '[]'::jsonb)
            FROM glory
        )
    ) INTO v_result;

    RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.gm_stats_members(text, date[], boolean) IS
'Per-member, per-bucket attendance for one tenant: att and a denominator (opp) computed from the member own roster start, excluding their excused sessions. One attendance rule: participated > 0 OR sub_present. Counts only -- the tenant coefficients are applied in TypeScript (finding B1). p_trend adds a 4-week vs previous-4-week comparison.';

REVOKE ALL ON FUNCTION public.gm_stats_members(text, date[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_stats_members(text, date[], boolean) TO authenticated, service_role;

-- The two-argument signature from phase S2 would otherwise stay resolvable and
-- keep serving the old shape to any caller that did not pass p_trend.
DROP FUNCTION IF EXISTS public.gm_stats_members(text, date[]);

DO $verify$
DECLARE
    v_src text;
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'gm_stats_members'
          AND pg_get_function_identity_arguments(p.oid) = 'p_guild text, p_weeks date[]'
    ) THEN
        RAISE EXCEPTION 'the two-argument gm_stats_members survived; two shapes would be resolvable';
    END IF;

    IF has_function_privilege('anon', 'public.gm_stats_members(text, date[], boolean)', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_stats_members must not be callable by anon';
    END IF;

    v_src := pg_get_functiondef('public.gm_stats_members(text, date[], boolean)'::regprocedure);

    IF position('ALPHA' in v_src) > 0 THEN
        RAISE EXCEPTION 'gm_stats_members must not name a tenant (ADR-003)';
    END IF;

    -- The single attendance rule. If a future edit reintroduces "or a score
    -- counts as attendance", the five-formulas problem starts again -- and the
    -- measurement says it would add nobody: zero rows in 49,701 carry a score
    -- without being marked present.
    IF position('coalesce(ep.score, 0) > 0
             OR coalesce(ep.score_prep, 0) > 0' in v_src) > 0 THEN
        RAISE EXCEPTION 'score-based attendance is back in the presence rule';
    END IF;

    IF position('o.week_start >= r.joined_week' in v_src) = 0 THEN
        RAISE EXCEPTION 'the denominator must start at the member roster week';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
