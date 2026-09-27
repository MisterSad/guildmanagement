-- The Player Portal was telling members a different number from their admin.
--
-- Measured on ALPHA, same guild, same data, same day:
--
--     the Portal said the guild attends ....... 48.1%
--     the admin's Stats page said .............. 31.6%
--
-- The Portal's figure came from `getGuildAverages` in member-portal, which
-- counted attended ROWS over ALL rows of the guild: no session
-- de-duplication, no week window, Glory included -- and Glory is 100%
-- "participated" by construction, 6,038 rows of it -- and rows still awaiting
-- approval included. It also fetched every participation row of the tenant to
-- count two things, on three separate actions.
--
-- A number a guild leader and a guild member read differently is worse than no
-- number at all, because it makes both of them wrong in an argument.
--
-- `gm_player_stats` answers on exactly the rules the admin side uses since
-- phase S3: attendance is `participated > 0 OR sub_present`, Glory and pending
-- rows are excluded, and opportunities are counted from the member's own
-- roster week minus the sessions they were excused from.
--
-- PRIVACY. It returns NO per-member row for anyone but the caller, and
-- computes no rank. A player sees their own breakdown and their guild's
-- pooled total, never a peer's attendance. The guild side is a genuine pooled
-- rate -- attendances over the SUM of every member's own opportunities -- not
-- `attendances / (sessions x roster)`, which would pretend everyone was on the
-- roster for every session.
--
-- service_role only: member-portal derives the identity from the JWT and never
-- accepts a caller-supplied uid, pseudo or guild, so the function is never
-- reachable from a browser.

CREATE OR REPLACE FUNCTION public.gm_player_stats(
    p_guild text,
    p_pseudo text,
    p_weeks integer DEFAULT 4
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_guild  text;
    v_pseudo text;
    v_n      integer;
    v_weeks  date[];
    v_result jsonb;
BEGIN
    v_guild  := nullif(btrim(p_guild), '');
    v_pseudo := nullif(btrim(p_pseudo), '');
    IF v_guild IS NULL OR v_pseudo IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'guild_and_pseudo_required');
    END IF;

    v_n := least(greatest(coalesce(p_weeks, 4), 1), 26);

    SELECT array_agg(w ORDER BY w DESC) INTO v_weeks
    FROM (
        SELECT DISTINCT ep.week_start AS w
        FROM public.event_participants ep
        WHERE ep.guild = v_guild
          AND ep.event_name <> 'Glory'
          AND ep.week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
        ORDER BY w DESC LIMIT v_n
    ) d;

    IF v_weeks IS NULL OR array_length(v_weeks, 1) IS NULL THEN
        v_weeks := ARRAY[(date_trunc('week', now() AT TIME ZONE 'UTC'))::date];
    END IF;

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
            (coalesce(ep.participated, 0) > 0 OR ep.sub_present) AS present,
            coalesce(ep.excused, false) AS excused
        FROM public.event_participants ep
        WHERE ep.guild = v_guild
          AND ep.week_start = ANY (v_weeks)
          AND coalesce(ep.is_pending, false) = false
          AND ep.event_name <> 'Glory'
    ),
    per_key AS (
        SELECT pseudo, skey, split_part(skey, '|', 1) AS bucket, week_start,
               bool_or(present) AS present, bool_or(excused) AS excused
        FROM keyed GROUP BY pseudo, skey, week_start
    ),
    opportunities AS (SELECT DISTINCT skey, bucket, week_start FROM per_key),
    roster AS (
        SELECT gm.pseudo, date_trunc('week', gm.created_at)::date AS joined_week
        FROM public.guild_members gm WHERE gm.guild = v_guild
    ),
    member_opp AS (
        SELECT r.pseudo, o.bucket, count(*) AS opp
        FROM roster r
        JOIN opportunities o ON o.week_start >= r.joined_week
        WHERE NOT EXISTS (
            SELECT 1 FROM per_key pk WHERE pk.pseudo = r.pseudo AND pk.skey = o.skey AND pk.excused
        )
        GROUP BY r.pseudo, o.bucket
    ),
    guild_buckets AS (
        SELECT mo.bucket,
               sum(mo.opp) AS member_opportunities,
               (SELECT count(*) FROM per_key pk WHERE pk.bucket = mo.bucket AND pk.present) AS attendances,
               (SELECT count(DISTINCT skey) FROM opportunities o WHERE o.bucket = mo.bucket) AS sessions
        FROM member_opp mo GROUP BY mo.bucket
    ),
    player_buckets AS (
        SELECT mo.bucket,
               mo.opp,
               coalesce((SELECT count(*) FROM per_key pk
                          WHERE pk.pseudo = v_pseudo AND pk.bucket = mo.bucket AND pk.present), 0) AS att,
               coalesce((SELECT count(*) FROM per_key pk
                          WHERE pk.pseudo = v_pseudo AND pk.bucket = mo.bucket AND pk.excused), 0) AS exc
        FROM member_opp mo WHERE mo.pseudo = v_pseudo
    ),
    glory AS (
        SELECT max(coalesce(ep.score, 0))  AS best,
               count(*)                    AS weeks_recorded,
               max(ep.week_start)          AS last_week
        FROM public.event_participants ep
        WHERE ep.guild = v_guild AND ep.pseudo = v_pseudo
          AND ep.event_name = 'Glory' AND coalesce(ep.score, 0) > 0
    )
    SELECT jsonb_build_object(
        'ok', true,
        'guild', v_guild,
        'pseudo', v_pseudo,
        'weeks', coalesce(array_length(v_weeks, 1), 0),
        'player', jsonb_build_object(
            'buckets', coalesce((
                SELECT jsonb_object_agg(bucket, jsonb_build_object('att', att, 'opp', opp, 'exc', exc))
                FROM player_buckets), '{}'::jsonb)
        ),
        'guild_totals', jsonb_build_object(
            'roster_size', (SELECT count(*) FROM roster),
            'max_power', coalesce((SELECT max(coalesce(overall_power, 0)) FROM public.guild_members WHERE guild = v_guild), 0),
            'buckets', coalesce((
                SELECT jsonb_object_agg(bucket, jsonb_build_object(
                    'sessions', sessions, 'attendances', attendances, 'member_opportunities', member_opportunities))
                FROM guild_buckets), '{}'::jsonb)
        ),
        'glory', (SELECT jsonb_build_object(
            'best', coalesce(best, 0), 'weeks_recorded', coalesce(weeks_recorded, 0), 'last_week', last_week
        ) FROM glory)
    ) INTO v_result;

    RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.gm_player_stats(text, text, integer) IS
'One player''s per-bucket attendance plus their guild''s pooled totals, on the same rules as gm_stats_members: participated > 0 OR sub_present, Glory and pending excluded, opportunities counted from the member own roster week minus their excused. Returns NO per-member data for anyone else and computes no rank, so a player cannot read a peer. service_role only: member-portal derives the identity from the JWT before calling it.';

REVOKE ALL ON FUNCTION public.gm_player_stats(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_player_stats(text, text, integer) TO service_role;

DO $verify$
DECLARE v_src text;
BEGIN
    IF has_function_privilege('authenticated', 'public.gm_player_stats(text, text, integer)', 'EXECUTE') THEN
        RAISE EXCEPTION 'gm_player_stats must not be reachable from a browser; member-portal authenticates first';
    END IF;
    v_src := pg_get_functiondef('public.gm_player_stats(text, text, integer)'::regprocedure);
    IF position('ALPHA' in v_src) > 0 THEN
        RAISE EXCEPTION 'gm_player_stats must not name a tenant (ADR-003)';
    END IF;
    IF position('o.week_start >= r.joined_week' in v_src) = 0 THEN
        RAISE EXCEPTION 'the denominator must start at the member roster week, as it does on the admin side';
    END IF;
    IF position($$ep.event_name <> 'Glory'$$ in v_src) = 0 THEN
        RAISE EXCEPTION 'Glory must be excluded from attendance; it is 100 percent participated by construction';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
