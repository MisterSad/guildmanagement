-- Phase S2: move the Stats leaderboard aggregation into SQL.
--
-- `gm_stats_data` ships four unbounded raw arrays to the browser and is called
-- four times per visit with no sharing. For OMEGA that is 9,111 participant
-- rows + 744 glory + 176 squads + 142 members, about 10,000 rows per call, and
-- every count, sum and distinct is then done in JavaScript. The table grows
-- roughly 3,000 rows a week.
--
-- `gm_stats_members` answers the same questions with one row per member and a
-- handful of counters per bucket: OMEGA's 7,398 in-window rows collapse to 650
-- aggregated groups.
--
-- WHY THE BUCKET EXPRESSION IS INLINED HERE INSTEAD OF CALLING
-- gm_event_scoring_key(). Measured on OMEGA, 7,398 rows, buffers all cached:
--
--     calling the function .......... 605 ms
--     the same CASE inlined ..........  48 ms
--
-- A SQL function carrying a `SET` clause cannot be inlined by the planner, so
-- `SET search_path = ''` -- which this project applies to every function, and
-- should -- turns each call into a real invocation, twice per row, and the date
-- overload delegates to the text one for a third. That is the entire 12x.
--
-- Duplicating a definition is how this codebase ended up with five divergent
-- attendance formulas, so this copy is not silent: the DO block at the bottom
-- asserts, against every distinct (event_name, session_id, week_start) triple
-- in the live table, that the inlined CASE returns exactly what
-- gm_event_scoring_key returns. If someone edits one and not the other, the
-- next replay of this migration fails and says so. The same discipline
-- src/core/scoring/chests.ts uses against gm_chests_for_score.
--
-- WHAT THIS FUNCTION DELIBERATELY DOES NOT DO: apply the coefficients. They are
-- per tenant, live in `guild_config`, and `src/core/config/event-coeffs.ts`
-- documents finding B1 -- the same five numbers declared twice, drifting apart.
-- Declaring them in SQL as well would recreate B1 across a language boundary
-- where the type-checker cannot see it. SQL counts; TypeScript weights.

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

    -- Same gate as gm_stats_weeks: denies `member`, pins a guild_admin to their
    -- own guild, scopes a server_admin to their server, and refuses a revoked
    -- or suspended session. No tenant fallback (ADR-003).
    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'not_authorized');
    END IF;

    -- Bound the window. AGENTS.md security rule 3 is about Edge Function input,
    -- but an RPC argument is client input too: without this, one call can ask
    -- for every week that has ever existed.
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
            -- The client's definition of attendance for the weighted board:
            -- participation, a present substitute, OR any recorded score.
            (coalesce(ep.participated, 0) > 0
             OR ep.sub_present
             OR coalesce(ep.score, 0) > 0
             OR coalesce(ep.score_prep, 0) > 0
             OR coalesce(ep.score_pvp, 0) > 0) AS attended,
            -- The stricter definition the attendance-rate board uses. Two
            -- different rules were already live; both are returned rather than
            -- one being silently picked.
            (coalesce(ep.participated, 0) > 0 OR ep.sub_present) AS present,
            -- The performance bonus applies to the literal names 'SvS'/'GvG'
            -- only, matching the client's `evName === 'SvS'` test. DEMO's
            -- uppercase 'SVS' therefore earns the coefficient but not the
            -- bonus, which is today's behaviour, faithfully preserved. S3
            -- revisits it deliberately.
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
    -- Collapse to one row per (member, scoring key). `bool_or` replaces the
    -- client's order-dependent "first attended row wins": measured across all
    -- 55,739 rows, 20 keys have several attended rows and in NONE of them does
    -- the score verdict differ between those rows, so the two rules agree on
    -- every row that exists -- and this one does not depend on the order the
    -- database happened to return.
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
               count(*) FILTER (WHERE attended)           AS att,
               count(*) FILTER (WHERE attended AND scored) AS att_scored,
               count(*) FILTER (WHERE present)            AS present
        FROM per_key GROUP BY pseudo, bucket
    ),
    per_member AS (
        SELECT pk.pseudo,
               count(*) FILTER (WHERE pk.attended)                    AS attended,
               count(*) FILTER (WHERE pk.present)                     AS present,
               count(DISTINCT pk.week_start) FILTER (WHERE pk.attended) AS weeks_active,
               max(pk.week_start) FILTER (WHERE pk.attended)          AS last_seen_week
        FROM per_key pk GROUP BY pk.pseudo
    ),
    flags AS (
        SELECT pseudo,
               count(*) FILTER (WHERE late)    AS late_count,
               count(*) FILTER (WHERE excused) AS excused_count,
               count(*) FILTER (WHERE sub)     AS sub_count
        FROM keyed GROUP BY pseudo
    ),
    -- Glory is windowed like everything else. The caller filtered its glory
    -- rows to the selected weeks before scoring, so returning all of history
    -- here would silently widen the delta -- which showed up immediately as a
    -- golden test moving from "-" to "+500". Preserving the window keeps the
    -- displayed numbers identical; whether a delta should be able to see past
    -- the window at all is an S3 question, and the honest answer is that at a
    -- 1-week period it can never be anything but zero.
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
        -- Every roster member, including those with no rows at all: the
        -- leaderboard lists the whole roster, and "0 of 42" is information.
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
        -- Glory is scored on 78.9% of its rows, which makes it the best
        -- populated signal on the page. It stays whole (one row per member per
        -- week) because the delta is a week-on-week difference, not a total.
        'glory', (
            SELECT coalesce(jsonb_agg(jsonb_build_array(pseudo, week_start, score)), '[]'::jsonb)
            FROM glory
        )
    ) INTO v_result;

    RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.gm_stats_members(text, date[]) IS
'Per-member, per-bucket participation counters for one tenant and a bounded set of weeks. Replaces shipping raw event_participants rows to the browser. Returns counts only: the per-tenant coefficients stay in TypeScript so they are declared once (finding B1).';

REVOKE ALL ON FUNCTION public.gm_stats_members(text, date[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_stats_members(text, date[]) TO authenticated, service_role;

-- `gm_leaderboard` is ACTIVE in production, granted to `authenticated`, has no
-- source in any migration in this repository, and no caller in src/. It also
-- resolves an unknown tenant with `coalesce(v_caller_guild, 'ALPHA')` in three
-- places, so today any authenticated caller whose guild does not resolve reads
-- ALPHA's leaderboard. It cannot be adopted -- writing a migration for a body
-- nobody reviewed means guessing at it -- and it cannot do the job anyway,
-- because it has no way to apply per-tenant coefficients. Same class as the
-- ghost Edge Functions in findings C3/C4.
DROP FUNCTION IF EXISTS public.gm_leaderboard(text, text, text);

DO $verify$
DECLARE
    v_mismatch bigint;
    v_checked  bigint;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = 'gm_stats_members'
    ) THEN
        RAISE EXCEPTION 'gm_stats_members was not created';
    END IF;

    IF has_function_privilege('anon', 'public.gm_stats_members(text, date[])', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_stats_members must not be callable by anon';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = 'gm_leaderboard'
    ) THEN
        RAISE EXCEPTION 'gm_leaderboard survived the drop';
    END IF;

    -- The inlined bucket CASE must agree with the canonical function, on real
    -- data, not on an example. This is the assertion that makes the copy safe.
    SELECT count(*), count(*) FILTER (
        WHERE d.inlined IS DISTINCT FROM public.gm_event_scoring_key(d.event_name, d.session_id, d.week_start)
    )
    INTO v_checked, v_mismatch
    FROM (
        SELECT DISTINCT ep.event_name, ep.session_id, ep.week_start,
            CASE
              WHEN upper(ep.event_name) LIKE 'ARMS RACE%'      THEN 'Arms Race|'   || coalesce(ep.session_id, ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SHADOWFRONT'        THEN 'Shadowfront|' || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'SVS'                THEN 'SvS|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'GVG'                THEN 'GvG|'         || coalesce(ep.week_start::text, '')
              WHEN upper(ep.event_name) = 'DEFEND TRADE ROUTE' THEN 'DTR|'         || coalesce(ep.session_id, ep.week_start::text, '')
              ELSE coalesce(ep.event_name, '') || '|' || coalesce(ep.session_id, ep.week_start::text, '')
            END AS inlined
        FROM public.event_participants ep
    ) d;

    IF v_mismatch > 0 THEN
        RAISE EXCEPTION 'the inlined bucket expression disagrees with gm_event_scoring_key on % of % distinct event triples', v_mismatch, v_checked;
    END IF;

    RAISE NOTICE 'bucket expression verified against gm_event_scoring_key on % distinct event triples', v_checked;
END
$verify$;

NOTIFY pgrst, 'reload schema';
