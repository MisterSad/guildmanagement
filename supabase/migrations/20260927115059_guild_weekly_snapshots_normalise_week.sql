CREATE OR REPLACE FUNCTION public.gm_stats_snapshot_upsert(
    p_guild text,
    p_week_start date,
    p_source text DEFAULT 'cron'
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_guild text;
    v_week  date;
    v_src   text;
BEGIN
    v_guild := nullif(btrim(p_guild), '');
    IF v_guild IS NULL OR p_week_start IS NULL THEN
        RETURN false;
    END IF;

    -- Normalise to the ISO Monday. 14 rows out of 55,739 carry a week_start
    -- that is not a Monday (a Friday, a Sunday, two Tuesdays, a Wednesday),
    -- and grouping on them raw invents six extra "weeks" made of one or two
    -- rows each. A snapshot keyed on those would be 156 junk rows across the
    -- estate, and a chart with six near-empty columns in it.
    v_week := date_trunc('week', p_week_start)::date;
    v_src  := CASE WHEN p_source IN ('cron', 'backfill', 'manual') THEN p_source ELSE 'manual' END;

    WITH keyed AS (
        SELECT ep.pseudo,
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
        WHERE ep.guild = v_guild
          AND date_trunc('week', ep.week_start)::date = v_week
          AND coalesce(ep.is_pending, false) = false
          AND ep.event_name <> 'Glory'
    ),
    per_key AS (
        SELECT pseudo, skey, split_part(skey, '|', 1) AS bucket, bool_or(present) AS present
        FROM keyed GROUP BY pseudo, skey
    ),
    opps AS (SELECT DISTINCT skey, bucket FROM per_key),
    buckets AS (
        SELECT o.bucket,
               count(*) AS opp,
               (SELECT count(*) FROM per_key pk WHERE pk.bucket = o.bucket AND pk.present) AS attendances,
               (SELECT count(DISTINCT pk.pseudo) FROM per_key pk WHERE pk.bucket = o.bucket AND pk.present) AS members
        FROM opps o GROUP BY o.bucket
    ),
    pwr AS (
        SELECT count(*) AS players,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY h.total_power)::bigint AS median_power
        FROM public.player_metrics_history h
        WHERE h.guild = v_guild
          AND date_trunc('week', h.week_start)::date = v_week
          AND coalesce(h.total_power, 0) > 0
    )
    INSERT INTO public.guild_weekly_snapshots AS s (
        guild, week_start, roster_size, opportunities, present_members,
        per_bucket, median_power, power_players, pending_rows, source, computed_at
    )
    SELECT
        v_guild,
        v_week,
        (SELECT count(*) FROM public.guild_members gm WHERE gm.guild = v_guild),
        (SELECT count(*) FROM opps),
        (SELECT count(DISTINCT pseudo) FROM per_key WHERE present),
        -- Guild grain, so the names differ from gm_stats_members on purpose:
        --   opp         = sessions of this bucket that week
        --   attendances = member-attendances across them
        --   members     = distinct members who made at least one
        coalesce((SELECT jsonb_object_agg(bucket, jsonb_build_object(
            'opp', opp, 'attendances', attendances, 'members', members)) FROM buckets), '{}'::jsonb),
        (SELECT median_power FROM pwr),
        coalesce((SELECT players FROM pwr), 0),
        (SELECT count(*) FROM public.event_participants ep
          WHERE ep.guild = v_guild
            AND date_trunc('week', ep.week_start)::date = v_week
            AND coalesce(ep.is_pending, false)),
        v_src,
        now()
    ON CONFLICT (guild, week_start) DO UPDATE SET
        roster_size     = excluded.roster_size,
        opportunities   = excluded.opportunities,
        present_members = excluded.present_members,
        per_bucket      = excluded.per_bucket,
        median_power    = excluded.median_power,
        power_players   = excluded.power_players,
        pending_rows    = excluded.pending_rows,
        source          = excluded.source,
        computed_at     = now();

    RETURN true;
END
$function$;

COMMENT ON COLUMN public.guild_weekly_snapshots.per_bucket IS
'{"SvS": {"opp": sessions, "attendances": member-attendances, "members": distinct members}, ...} -- counts only, at GUILD grain. The per-tenant coefficients are applied in TypeScript so they stay declared once (finding B1); a past week can be re-weighted without re-reading event_participants.';

COMMENT ON COLUMN public.guild_weekly_snapshots.week_start IS
'ISO Monday. Source rows whose week_start is not a Monday (14 of 55,739) are folded into the week that contains them, rather than inventing a column per stray date.';

-- The rows written before the normalisation are keyed on stray dates and carry
-- the old `att` key. Rebuild rather than migrate: the source data is right
-- there and the table is a derived cache.
DELETE FROM public.guild_weekly_snapshots;

DO $verify$
DECLARE v_bad bigint;
BEGIN
    IF position('attendances' in pg_get_functiondef('public.gm_stats_snapshot_upsert(text, date, text)'::regprocedure)) = 0 THEN
        RAISE EXCEPTION 'the guild-grain bucket counts must be named unambiguously';
    END IF;

    SELECT count(*) INTO v_bad FROM public.guild_weekly_snapshots
     WHERE extract(isodow from week_start) <> 1;
    IF v_bad > 0 THEN
        RAISE EXCEPTION '% snapshot rows are not keyed on a Monday', v_bad;
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
