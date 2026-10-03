CREATE OR REPLACE FUNCTION public.gm_stats_members(
    p_guild text,
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

    IF p_weeks IS NULL OR array_length(p_weeks, 1) IS NULL THEN
        SELECT array_agg(w ORDER BY w DESC)
          INTO v_weeks
          FROM (
            SELECT DISTINCT ep.week_start AS w
            FROM public.event_participants ep
            WHERE ep.guild = v_target
              AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
            ORDER BY w DESC
            LIMIT 1
          ) d;
    ELSE
        SELECT array_agg(w ORDER BY w DESC)
          INTO v_weeks
          FROM (SELECT DISTINCT unnest(p_weeks) AS w ORDER BY w DESC LIMIT 26) d;
    END IF;

    IF v_weeks IS NULL OR array_length(v_weeks, 1) IS NULL THEN
        v_weeks := ARRAY[(date_trunc('week', now() AT TIME ZONE 'UTC'))::date];
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
            (coalesce(ep.participated, 0) > 0
             OR ep.sub_present
             OR coalesce(ep.score, 0) > 0
             OR coalesce(ep.score_prep, 0) > 0
             OR coalesce(ep.score_pvp, 0) > 0) AS attended,
            (coalesce(ep.participated, 0) > 0 OR ep.sub_present) AS present,
            (ep.event_name IN ('SvS', 'GvG')
             AND (coalesce(ep.score, 0) + coalesce(ep.score_prep, 0) + coalesce(ep.score_pvp, 0)) > 0) AS scored,
            coalesce(ep.late, false)    AS late,
            coalesce(ep.excused, false) AS excused,
            coalesce(ep.sub_present, false) AS sub
        FROM public.event_participants ep
        WHERE ep.guild = v_target
          AND ep.week_start = ANY (v_weeks)
          AND coalesce(ep.is_pending, false) = false
          AND ep.event_name <> 'Glory'
    ),
    per_key AS (
        SELECT pseudo, skey, split_part(skey, '|', 1) AS bucket, week_start,
               bool_or(attended) AS attended,
               bool_or(present)  AS present,
               bool_or(scored)   AS scored
        FROM keyed
        GROUP BY pseudo, skey, week_start
    ),
    tenant_buckets AS (
        SELECT bucket, count(DISTINCT skey) AS opp
        FROM per_key GROUP BY bucket
    ),
    per_member_bucket AS (
        SELECT pseudo, bucket,
               count(*) FILTER (WHERE attended)            AS att,
               count(*) FILTER (WHERE attended AND scored) AS att_scored,
               count(*) FILTER (WHERE present)             AS present
        FROM per_key GROUP BY pseudo, bucket
    ),
    per_member AS (
        SELECT pk.pseudo,
               count(*) FILTER (WHERE pk.attended)                      AS attended,
               count(*) FILTER (WHERE pk.present)                       AS present,
               count(DISTINCT pk.week_start) FILTER (WHERE pk.attended) AS weeks_active,
               max(pk.week_start) FILTER (WHERE pk.attended)            AS last_seen_week
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
    )
    SELECT jsonb_build_object(
        'ok', true,
        'guild', v_target,
        'weeks', (SELECT coalesce(jsonb_agg(w ORDER BY w DESC), '[]'::jsonb) FROM unnest(v_weeks) w),
        'tenant', jsonb_build_object(
            'total_events', (SELECT coalesce(sum(opp), 0) FROM tenant_buckets),
            'buckets', (SELECT coalesce(jsonb_object_agg(bucket, opp), '{}'::jsonb) FROM tenant_buckets)
        ),
        'members', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
                'pseudo', gm.pseudo,
                'uid', gm.uid,
                'role', gm.role,
                'overall_power', coalesce(gm.overall_power, 0),
                'attended', coalesce(pm.attended, 0),
                'present', coalesce(pm.present, 0),
                'weeks_active', coalesce(pm.weeks_active, 0),
                'last_seen_week', pm.last_seen_week,
                'late_count', coalesce(f.late_count, 0),
                'excused_count', coalesce(f.excused_count, 0),
                'sub_count', coalesce(f.sub_count, 0),
                'buckets', coalesce((
                    SELECT jsonb_object_agg(b.bucket, jsonb_build_object(
                        'att', b.att, 'att_scored', b.att_scored, 'present', b.present))
                    FROM per_member_bucket b WHERE b.pseudo = gm.pseudo
                ), '{}'::jsonb)
            ) ORDER BY gm.pseudo), '[]'::jsonb)
            FROM public.guild_members gm
            LEFT JOIN per_member pm ON pm.pseudo = gm.pseudo
            LEFT JOIN flags f       ON f.pseudo  = gm.pseudo
            WHERE gm.guild = v_target
        ),
        'glory', (
            SELECT coalesce(jsonb_agg(jsonb_build_array(pseudo, week_start, score)), '[]'::jsonb)
            FROM glory
        )
    ) INTO v_result;

    RETURN v_result;
END
$function$;

DO $verify$
DECLARE v_src text;
BEGIN
    v_src := pg_get_functiondef('public.gm_stats_members(text, date[])'::regprocedure);
    IF position('ep.event_name = ''Glory''' in v_src) = 0
       OR position('AND ep.week_start = ANY (v_weeks)
          AND coalesce(ep.score, 0) > 0' in v_src) = 0 THEN
        RAISE EXCEPTION 'the glory CTE must be windowed by v_weeks, or the delta silently widens';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
