-- Phase S4b: stop the past from being rewritten.
--
-- THE PROBLEM. Seven tables carry
--   FOREIGN KEY (guild, pseudo) REFERENCES guild_members(guild, pseudo) ON DELETE CASCADE
-- -- event_participants, player_metrics_history, event_daily_scores, sanctions,
-- shadowfront_squads, shadowfront_signups and weekly_scores. Removing a member
-- therefore erases their entire history, and every historical guild aggregate
-- shifts with it. Last month's participation rate changes when you kick someone
-- today. The retired "Weekly participation rate" card made it worse by dividing
-- each past week by TODAY's roster.
--
-- WHY THIS TABLE IS GUILD-GRAIN AND CARRIES NO MEMBER KEY. A member-grain
-- snapshot would need the same (guild, pseudo) foreign key to stay consistent,
-- and would then be destroyed by exactly the cascade it exists to survive.
-- Dropping that key instead was considered and rejected: `gm_erase_player`
-- (20260927100000) is built on ON UPDATE CASCADE propagating a rename across
-- all seven children atomically, and that migration records that an earlier
-- version was wrong precisely because it fought the cascade. So the personal
-- history still goes when a member goes -- which is what the Terms promise --
-- and the GUILD's record of that week does not. See ADR-019.
--
-- WHAT IS STORED. Counts, not scores. The per-tenant coefficients stay in
-- TypeScript (finding B1), so a past week can be re-weighted later without
-- re-reading event_participants.
--
-- HONEST LIMIT OF THE BACKFILL. Rows written for weeks that had already passed
-- are computed from TODAY's roster: anyone removed before the backfill ran is
-- already gone from event_participants and cannot appear. The backfill
-- therefore reproduces the bias it exists to stop, and is marked
-- `source = 'backfill'` so nobody mistakes it for a contemporaneous record.
-- Only weeks written by the Monday job from here on are clean.

CREATE TABLE IF NOT EXISTS public.guild_weekly_snapshots (
    guild             text NOT NULL REFERENCES public.guilds(id) ON UPDATE CASCADE ON DELETE CASCADE,
    week_start        date NOT NULL,
    roster_size       integer NOT NULL DEFAULT 0,
    opportunities     integer NOT NULL DEFAULT 0,
    present_members   integer NOT NULL DEFAULT 0,
    per_bucket        jsonb   NOT NULL DEFAULT '{}'::jsonb,
    median_power      bigint,
    power_players     integer NOT NULL DEFAULT 0,
    pending_rows      integer NOT NULL DEFAULT 0,
    source            text    NOT NULL DEFAULT 'cron',
    computed_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild, week_start),
    CONSTRAINT guild_weekly_snapshots_source_check CHECK (source IN ('cron', 'backfill', 'manual'))
);

COMMENT ON TABLE public.guild_weekly_snapshots IS
'One frozen row per guild per week. Deliberately GUILD-grain and carrying no (guild, pseudo) foreign key, so removing a member cannot rewrite the past. See ADR-019.';

COMMENT ON COLUMN public.guild_weekly_snapshots.per_bucket IS
'{"SvS": {"opp": sessions, "attendances": member-attendances, "members": distinct members}, ...} -- counts only, at GUILD grain. The per-tenant coefficients are applied in TypeScript so they stay declared once (finding B1); a past week can be re-weighted without re-reading event_participants.';

COMMENT ON COLUMN public.guild_weekly_snapshots.week_start IS
'ISO Monday. Source rows whose week_start is not a Monday (14 of 55,739) are folded into the week that contains them, rather than inventing a column per stray date.';

COMMENT ON COLUMN public.guild_weekly_snapshots.source IS
'cron = written by the Monday job from live data. backfill = recomputed from today''s roster for a week that had already passed, so it inherits the bias this table exists to stop. manual = written by hand.';

ALTER TABLE public.guild_weekly_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guild_weekly_snapshots FORCE ROW LEVEL SECURITY;

-- Deny-all by construction: RLS enabled and forced with zero policies, so the
-- table is reachable only through SECURITY DEFINER functions and service_role.
-- Same posture as login_throttle and the Discord ephemera tables, stated here
-- rather than left as an unexplained silence (finding M4).
REVOKE ALL ON TABLE public.guild_weekly_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guild_weekly_snapshots TO service_role;

CREATE INDEX IF NOT EXISTS idx_guild_weekly_snapshots_week
    ON public.guild_weekly_snapshots (week_start DESC);

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
    -- that is not a Monday, and grouping on them raw invents six extra "weeks"
    -- of one or two rows each.
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

COMMENT ON FUNCTION public.gm_stats_snapshot_upsert(text, date, text) IS
'Freezes one guild-week into guild_weekly_snapshots. Idempotent: re-running overwrites the row, so catch-ups and manual reruns are safe.';

CREATE OR REPLACE FUNCTION public.gm_stats_snapshot_run()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_week date;
    v_n    integer := 0;
    v_g    record;
BEGIN
    v_week := (date_trunc('week', now() AT TIME ZONE 'UTC'))::date - 7;

    FOR v_g IN SELECT id FROM public.guilds LOOP
        PERFORM public.gm_stats_snapshot_upsert(v_g.id, v_week, 'cron');
        v_n := v_n + 1;
    END LOOP;

    RETURN v_n;
END
$function$;

COMMENT ON FUNCTION public.gm_stats_snapshot_run() IS
'Snapshots the week that just closed, for every guild. Iterates public.guilds, never a list. A guild with no events gets a row with opportunities = 0, which is data -- it distinguishes a quiet week from a missing one.';

REVOKE ALL ON FUNCTION public.gm_stats_snapshot_upsert(text, date, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.gm_stats_snapshot_run() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_stats_snapshot_upsert(text, date, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.gm_stats_snapshot_run() TO service_role;

-- Monday, because week_start is Monday-based. 03:20 and not earlier: the DEMO
-- tenant is rebuilt at 03:00 by gm_reset_demo_tenant_data, and a job at 02:40
-- would photograph rows that reset is about to delete. It also sits before the
-- empty-guild expiry at 03:30, so a guild about to be removed still gets its
-- last week recorded.
SELECT cron.unschedule('weekly-stats-snapshot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-stats-snapshot');

SELECT cron.schedule('weekly-stats-snapshot', '20 3 * * 1', $cron$ SELECT public.gm_stats_snapshot_run(); $cron$);

-- Backfill every week that already exists. Marked 'backfill': see the honest
-- limit stated in the header.
SELECT public.gm_stats_snapshot_upsert(g.id, w.wk, 'backfill')
FROM public.guilds g
CROSS JOIN (
    SELECT DISTINCT date_trunc('week', week_start)::date AS wk
    FROM public.event_participants
    WHERE event_name <> 'Glory'
      AND week_start <= (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
) w;

DO $verify$
DECLARE v_bad bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-stats-snapshot' AND schedule = '20 3 * * 1') THEN
        RAISE EXCEPTION 'the weekly snapshot job was not scheduled';
    END IF;

    -- The point of the table. If someone adds a (guild, pseudo) foreign key
    -- later, ON DELETE CASCADE starts erasing snapshots when a member is
    -- removed, and the table stops doing the one job it exists for.
    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.guild_weekly_snapshots'::regclass
          AND c.contype = 'f'
          AND c.confrelid = 'public.guild_members'::regclass
    ) THEN
        RAISE EXCEPTION 'guild_weekly_snapshots must not reference guild_members; a kick would rewrite history again';
    END IF;

    IF has_table_privilege('authenticated', 'public.guild_weekly_snapshots', 'SELECT') THEN
        RAISE EXCEPTION 'guild_weekly_snapshots must stay service_role only';
    END IF;

    SELECT count(*) INTO v_bad FROM public.guild_weekly_snapshots
     WHERE extract(isodow from week_start) <> 1;
    IF v_bad > 0 THEN
        RAISE EXCEPTION '% snapshot rows are not keyed on a Monday', v_bad;
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
