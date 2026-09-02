-- 20260902210000_draft_activity_and_combat_density.sql
-- Reweights public.gm_cross_guild_ranking()'s Draft Score toward active PvP
-- participation and adds a Combat Density signal (power composition quality,
-- ported from gm-utils.js calculateCombatDensity() used by the Tactical Force
-- Matrix in the Members tab).
--
-- Changes vs 20260817190000_draft_scouting_and_combat_scoring.sql:
-- 1. New combat_density_raw / combat_density_score columns (0-100, benchmarked
--    against the 95th percentile of the candidate pool, same technique as the
--    existing pvp/glory benchmarks).
-- 2. Day 6 PvP internal blend: 50% attendance / 50% raw combat points
--    -> 65% attendance / 35% raw combat points (favor showing up over raw
--    score on the PvP battle day).
-- 3. Composite Draft Score weights: 30/25/15/15/10/5 (Shadowfront/Day6/SvS/
--    GvG/Glory/Other) -> 28/25/14/14/10/6/3 (Shadowfront/Day6/SvS/GvG/
--    Combat Density/Glory/Other).

DROP FUNCTION IF EXISTS public.gm_cross_guild_ranking();

CREATE OR REPLACE FUNCTION public.gm_cross_guild_ranking()
RETURNS TABLE(
    pseudo TEXT,
    guild TEXT,
    server_number TEXT,
    power BIGINT,
    combat_density_raw NUMERIC,
    combat_density_score NUMERIC,
    draft_score NUMERIC,
    day6_score NUMERIC,
    day6_pvp_score BIGINT,
    svs_attended INTEGER,
    svs_total INTEGER,
    svs_rate NUMERIC,
    svs_avg_prep BIGINT,
    svs_avg_pvp BIGINT,
    gvg_attended INTEGER,
    gvg_total INTEGER,
    gvg_rate NUMERIC,
    gvg_avg_prep BIGINT,
    gvg_avg_pvp BIGINT,
    shadow_attended INTEGER,
    shadow_total INTEGER,
    shadow_rate NUMERIC,
    dtr_attended INTEGER,
    dtr_total INTEGER,
    dtr_rate NUMERIC,
    arms_attended INTEGER,
    arms_total INTEGER,
    arms_rate NUMERIC,
    glory_score NUMERIC,
    glory_total BIGINT,
    glory_attended INTEGER,
    glory_total_weeks INTEGER,
    glory_rate NUMERIC,
    global_attended INTEGER,
    global_total INTEGER,
    global_rate NUMERIC,
    scouting_tier TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
    v_super BOOLEAN;
BEGIN
    SELECT public.is_super_admin() INTO v_super;
    IF NOT v_super THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH ep AS (
        SELECT ep0.guild AS guild_id,
               ep0.pseudo,
               ep0.event_name,
               ep0.session_id,
               ep0.week_start,
               public.gm_event_scoring_key(ep0.event_name, ep0.session_id, ep0.week_start::text) AS skey,
               (ep0.participated > 0 OR ep0.sub_present = true OR ep0.score > 0 OR ep0.score_prep > 0 OR ep0.score_pvp > 0) AS attended,
               COALESCE(ep0.score_prep, 0)::BIGINT AS prep,
               COALESCE(NULLIF(ep0.score_pvp, 0), CASE WHEN ep0.event_name IN ('SvS', 'GvG') THEN NULLIF(ep0.score, 0) ELSE NULL END, 0)::BIGINT AS pvp,
               COALESCE(ep0.score, 0)::BIGINT AS general_score,
               (ep0.event_name = 'Glory') AS is_glory
        FROM public.event_participants ep0
        WHERE ep0.is_pending = false
          AND ep0.guild <> 'DEMO'
          AND public.gm_event_scoring_key(ep0.event_name, ep0.session_id, ep0.week_start::text) IS NOT NULL
    ),
    es_sess AS (
        SELECT DISTINCT es0.guild AS guild_id,
               public.gm_event_scoring_key(es0.event_name, es0.session_id, NULL) AS skey
        FROM public.event_status es0
        WHERE es0.guild <> 'DEMO'
          AND public.gm_event_scoring_key(es0.event_name, es0.session_id, NULL) IS NOT NULL
    ),
    ep_sess AS (
        SELECT DISTINCT e.guild_id, e.skey FROM ep e
    ),
    sess AS (
        SELECT es_sess.guild_id, es_sess.skey FROM es_sess
        UNION
        SELECT ep_sess.guild_id, ep_sess.skey FROM ep_sess
    ),
    sess_totals AS (
        SELECT s.guild_id,
               COUNT(*) FILTER (WHERE s.skey LIKE 'SvS|%')          AS svs_tot,
               COUNT(*) FILTER (WHERE s.skey LIKE 'GvG|%')          AS gvg_tot,
               COUNT(*) FILTER (WHERE s.skey LIKE 'Shadowfront|%')  AS sh_tot,
               COUNT(*) FILTER (WHERE s.skey LIKE 'DTR|%')          AS dtr_tot,
               COUNT(*) FILTER (WHERE s.skey LIKE 'Arms Race|%')    AS ar_tot,
               COUNT(*) FILTER (WHERE s.skey LIKE 'Glory|%')        AS gl_tot,
               COUNT(*) FILTER (WHERE s.skey NOT LIKE 'Glory|%')    AS g_tot
        FROM sess s
        GROUP BY s.guild_id
    ),
    player_stats AS (
        SELECT e.guild_id,
               lower(btrim(e.pseudo)) AS nkey,
               -- SvS
               COUNT(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'SvS|%' AND e.attended) AS svs_att,
               COALESCE(ROUND(AVG(NULLIF(e.prep, 0)) FILTER (WHERE e.skey LIKE 'SvS|%'))::BIGINT, 0) AS svs_avg_prep,
               COALESCE(ROUND(AVG(NULLIF(e.pvp, 0)) FILTER (WHERE e.skey LIKE 'SvS|%'))::BIGINT, 0) AS svs_avg_pvp,
               -- GvG
               COUNT(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'GvG|%' AND e.attended) AS gvg_att,
               COALESCE(ROUND(AVG(NULLIF(e.prep, 0)) FILTER (WHERE e.skey LIKE 'GvG|%'))::BIGINT, 0) AS gvg_avg_prep,
               COALESCE(ROUND(AVG(NULLIF(e.pvp, 0)) FILTER (WHERE e.skey LIKE 'GvG|%'))::BIGINT, 0) AS gvg_avg_pvp,
               -- Shadowfront
               COUNT(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Shadowfront|%' AND e.attended) AS sh_att,
               -- DTR
               COUNT(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'DTR|%' AND e.attended) AS dtr_att,
               -- Arms Race
               COUNT(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Arms Race|%' AND e.attended) AS ar_att,
               -- Glory: Total accumulated points and attended weeks
               COALESCE(SUM(e.general_score) FILTER (WHERE e.skey LIKE 'Glory|%'), 0)::BIGINT AS gl_total,
               GREATEST(COUNT(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Glory|%' AND e.attended)
                        - CASE WHEN COUNT(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Glory|%' AND e.attended) > 0 THEN 1 ELSE 0 END, 0) AS gl_att,
               -- Overall attendance excluding Glory
               COUNT(DISTINCT e.skey) FILTER (WHERE NOT e.is_glory AND e.attended) AS g_att
        FROM ep e
        GROUP BY e.guild_id, lower(btrim(e.pseudo))
    ),
    benchmarks AS (
        SELECT
            COALESCE(
                NULLIF(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY (2 * ps.svs_avg_pvp + 2 * ps.gvg_avg_pvp)), 0)::NUMERIC,
                NULLIF(MAX(2 * ps.svs_avg_pvp + 2 * ps.gvg_avg_pvp), 0)::NUMERIC,
                1::NUMERIC
            ) AS pvp_benchmark,
            COALESCE(
                NULLIF(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ps.gl_total), 0)::NUMERIC,
                NULLIF(MAX(ps.gl_total), 0)::NUMERIC,
                1::NUMERIC
            ) AS glory_benchmark
        FROM player_stats ps
    ),
    roster AS (
        SELECT DISTINCT ON (m.guild, lower(btrim(m.pseudo)))
               m.guild AS guild_id,
               g.server_number,
               m.pseudo,
               m.overall_power AS power,
               -- Combat Density (power composition quality): same formula as
               -- gm-utils.js calculateCombatDensity() for the Tactical Force
               -- Matrix -- Fleet (80x) > Flagship (18x) > Crew (8x) > Tech (6x)
               -- > Champion (0.8x) > Glory (0.05x), scaled against total power.
               -- NULL (not 0) when none of the 5 breakdown fields were ever
               -- captured for this player (~43% of the roster today, per a
               -- live production check) -- otherwise the composite score
               -- silently punishes a missing-OCR-data player as if they had
               -- a bad power composition, which is not what "no data" means.
               CASE WHEN COALESCE(m.overall_power, 0) > 0
                     AND (COALESCE(m.fleet_rating, 0) > 0 OR COALESCE(m.flagship_power, 0) > 0 OR COALESCE(m.crew_power, 0) > 0 OR COALESCE(m.tech_power, 0) > 0 OR COALESCE(m.champion_power, 0) > 0)
                    THEN
                 ROUND(
                   (
                     (COALESCE(m.fleet_rating, 0)::NUMERIC * 80.0) +
                     (COALESCE(m.flagship_power, 0)::NUMERIC * 18.0) +
                     (COALESCE(m.crew_power, 0)::NUMERIC * 8.0) +
                     (COALESCE(m.tech_power, 0)::NUMERIC * 6.0) +
                     (COALESCE(m.champion_power, 0)::NUMERIC * 0.8) +
                     (COALESCE(m.glory_score, 0)::NUMERIC * 0.05)
                   ) / m.overall_power::NUMERIC * 100.0,
                   1
                 )
               ELSE NULL::NUMERIC END AS raw_density
        FROM public.guild_members m
        LEFT JOIN public.guilds g ON g.id = m.guild
        WHERE m.guild <> 'DEMO'
        ORDER BY m.guild, lower(btrim(m.pseudo)), m.created_at DESC, m.id DESC
    ),
    density_benchmarks AS (
        SELECT
            COALESCE(
                NULLIF(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.raw_density), 0)::NUMERIC,
                NULLIF(MAX(r.raw_density), 0)::NUMERIC,
                1::NUMERIC
            ) AS density_benchmark
        FROM roster r
    ),
    calc AS (
        SELECT r.pseudo,
               r.guild_id AS guild,
               COALESCE(r.server_number, '')::TEXT AS server_number,
               COALESCE(r.power, 0)::BIGINT AS power,
               -- Combat Density (NULL propagated -- see roster CTE comment)
               r.raw_density AS combat_density_raw,
               CASE WHEN r.raw_density IS NOT NULL THEN
                 ROUND(
                   LEAST(
                     100.0::NUMERIC,
                     (r.raw_density / NULLIF((SELECT db.density_benchmark FROM density_benchmarks db), 0::NUMERIC)) * 100.0::NUMERIC
                   )::NUMERIC,
                   1
                 )
               ELSE NULL END AS combat_density_score,
               -- SvS
               COALESCE(ps.svs_att, 0)::INTEGER AS svs_attended,
               COALESCE(st.svs_tot, 0)::INTEGER AS svs_total,
               CASE WHEN COALESCE(st.svs_tot, 0) > 0 THEN ROUND((100.0 * COALESCE(ps.svs_att, 0) / st.svs_tot)::NUMERIC, 1) END AS svs_rate,
               COALESCE(ps.svs_avg_prep, 0)::BIGINT AS svs_avg_prep,
               COALESCE(ps.svs_avg_pvp, 0)::BIGINT AS svs_avg_pvp,
               -- GvG
               COALESCE(ps.gvg_att, 0)::INTEGER AS gvg_attended,
               COALESCE(st.gvg_tot, 0)::INTEGER AS gvg_total,
               CASE WHEN COALESCE(st.gvg_tot, 0) > 0 THEN ROUND((100.0 * COALESCE(ps.gvg_att, 0) / st.gvg_tot)::NUMERIC, 1) END AS gvg_rate,
               COALESCE(ps.gvg_avg_prep, 0)::BIGINT AS gvg_avg_prep,
               COALESCE(ps.gvg_avg_pvp, 0)::BIGINT AS gvg_avg_pvp,
               -- Raw Day 6 PvP combat points
               (
                 (2 * COALESCE(ps.svs_avg_pvp, 0)) +
                 (2 * COALESCE(ps.gvg_avg_pvp, 0))
               )::BIGINT AS day6_pvp_score,
               -- Day 6 Score (0 to 100 scale) -- weighted toward battle
               -- presence (65%) over raw combat points (35%), so a player who
               -- shows up to every Day 6 outranks one who skips days but
               -- posts big numbers when they do attend.
               CASE
                 WHEN (COALESCE(st.svs_tot, 0) + COALESCE(st.gvg_tot, 0)) > 0 THEN
                   ROUND(
                     (
                       LEAST(
                         100.0::NUMERIC,
                         (
                           (0.65::NUMERIC * (
                             (COALESCE(ps.svs_att, 0)::NUMERIC + COALESCE(ps.gvg_att, 0)::NUMERIC) /
                             NULLIF(COALESCE(st.svs_tot, 0)::NUMERIC + COALESCE(st.gvg_tot, 0)::NUMERIC, 0::NUMERIC)
                           ) * 100.0::NUMERIC) +
                           (0.35::NUMERIC * (
                             ((2 * COALESCE(ps.svs_avg_pvp, 0)::NUMERIC) + (2 * COALESCE(ps.gvg_avg_pvp, 0)::NUMERIC)) /
                             NULLIF((SELECT bm.pvp_benchmark FROM benchmarks bm), 0::NUMERIC)
                           ) * 100.0::NUMERIC)
                         )
                       )
                     )::NUMERIC,
                     1
                   )
                 ELSE NULL
               END AS day6_score,
               -- Shadowfront
               COALESCE(ps.sh_att, 0)::INTEGER AS shadow_attended,
               COALESCE(st.sh_tot, 0)::INTEGER AS shadow_total,
               CASE WHEN COALESCE(st.sh_tot, 0) > 0 THEN ROUND((100.0 * COALESCE(ps.sh_att, 0) / st.sh_tot)::NUMERIC, 1) END AS shadow_rate,
               -- DTR
               COALESCE(ps.dtr_att, 0)::INTEGER AS dtr_attended,
               COALESCE(st.dtr_tot, 0)::INTEGER AS dtr_total,
               CASE WHEN COALESCE(st.dtr_tot, 0) > 0 THEN ROUND((100.0 * COALESCE(ps.dtr_att, 0) / st.dtr_tot)::NUMERIC, 1) END AS dtr_rate,
               -- Arms Race
               COALESCE(ps.ar_att, 0)::INTEGER AS arms_attended,
               COALESCE(st.ar_tot, 0)::INTEGER AS arms_total,
               CASE WHEN COALESCE(st.ar_tot, 0) > 0 THEN ROUND((100.0 * COALESCE(ps.ar_att, 0) / st.ar_tot)::NUMERIC, 1) END AS arms_rate,
               -- Glory totals & Glory Score (0 to 100 scale)
               COALESCE(ps.gl_total, 0)::BIGINT AS glory_total,
               COALESCE(ps.gl_att, 0)::INTEGER AS glory_attended,
               COALESCE(st.gl_tot, 0)::INTEGER AS glory_total_weeks,
               CASE WHEN COALESCE(st.gl_tot, 0) > 0 THEN ROUND((100.0 * COALESCE(ps.gl_att, 0) / st.gl_tot)::NUMERIC, 1) END AS glory_rate,
               -- Glory Score (0 to 100 scale)
               CASE
                 WHEN COALESCE(st.gl_tot, 0) > 0 THEN
                   ROUND(
                     (
                       LEAST(
                         100.0::NUMERIC,
                         (
                           (0.50::NUMERIC * (COALESCE(ps.gl_att, 0)::NUMERIC / NULLIF(st.gl_tot::NUMERIC, 0::NUMERIC)) * 100.0::NUMERIC) +
                           (0.50::NUMERIC * (COALESCE(ps.gl_total, 0)::NUMERIC / NULLIF((SELECT bm.glory_benchmark FROM benchmarks bm), 0::NUMERIC)) * 100.0::NUMERIC)
                         )
                       )
                     )::NUMERIC,
                     1
                   )
                 ELSE NULL
               END AS glory_score,
               -- Global attendance totals
               COALESCE(ps.g_att, 0)::INTEGER AS global_attended,
               COALESCE(st.g_tot, 0)::INTEGER AS global_total,
               -- Weighted attendance rate
               CASE
                 WHEN (
                   (CASE WHEN COALESCE(st.svs_tot, 0) > 0 THEN 5 ELSE 0 END) +
                   (CASE WHEN COALESCE(st.gvg_tot, 0) > 0 THEN 5 ELSE 0 END) +
                   (CASE WHEN COALESCE(st.sh_tot, 0)  > 0 THEN 4 ELSE 0 END) +
                   (CASE WHEN COALESCE(st.dtr_tot, 0) > 0 THEN 2 ELSE 0 END) +
                   (CASE WHEN COALESCE(st.ar_tot, 0)  > 0 THEN 2 ELSE 0 END)
                 ) > 0 THEN
                   ROUND(
                     (
                       (
                         (CASE WHEN COALESCE(st.svs_tot, 0) > 0 THEN 5.0::NUMERIC * COALESCE(ps.svs_att, 0)::NUMERIC / st.svs_tot::NUMERIC ELSE 0::NUMERIC END) +
                         (CASE WHEN COALESCE(st.gvg_tot, 0) > 0 THEN 5.0::NUMERIC * COALESCE(ps.gvg_att, 0)::NUMERIC / st.gvg_tot::NUMERIC ELSE 0::NUMERIC END) +
                         (CASE WHEN COALESCE(st.sh_tot, 0)  > 0 THEN 4.0::NUMERIC * COALESCE(ps.sh_att, 0)::NUMERIC  / st.sh_tot::NUMERIC  ELSE 0::NUMERIC END) +
                         (CASE WHEN COALESCE(st.dtr_tot, 0) > 0 THEN 2.0::NUMERIC * COALESCE(ps.dtr_att, 0)::NUMERIC / st.dtr_tot::NUMERIC ELSE 0::NUMERIC END) +
                         (CASE WHEN COALESCE(st.ar_tot, 0)  > 0 THEN 2.0::NUMERIC * COALESCE(ps.ar_att, 0)::NUMERIC  / st.ar_tot::NUMERIC  ELSE 0::NUMERIC END)
                       ) * 100.0::NUMERIC / (
                         (CASE WHEN COALESCE(st.svs_tot, 0) > 0 THEN 5.0::NUMERIC ELSE 0::NUMERIC END) +
                         (CASE WHEN COALESCE(st.gvg_tot, 0) > 0 THEN 5.0::NUMERIC ELSE 0::NUMERIC END) +
                         (CASE WHEN COALESCE(st.sh_tot, 0)  > 0 THEN 4.0::NUMERIC ELSE 0::NUMERIC END) +
                         (CASE WHEN COALESCE(st.dtr_tot, 0) > 0 THEN 2.0::NUMERIC ELSE 0::NUMERIC END) +
                         (CASE WHEN COALESCE(st.ar_tot, 0)  > 0 THEN 2.0::NUMERIC ELSE 0::NUMERIC END)
                       )
                     )::NUMERIC,
                     1
                   )
                 ELSE NULL
               END AS global_rate
        FROM roster r
        LEFT JOIN player_stats ps ON ps.guild_id = r.guild_id AND ps.nkey = lower(btrim(r.pseudo))
        LEFT JOIN sess_totals st ON st.guild_id = r.guild_id
    ),
    scored AS (
        SELECT c.*,
               -- Draft Composite Master Score (0-100 scale):
               -- 28% Shadowfront attendance (Priority 20v20 pillar)
               -- 25% Day 6 PvP combat rating (65% presence / 35% raw points)
               -- 14% SvS attendance (Days 1-5)
               -- 14% GvG attendance (Days 1-5)
               -- 10% Combat Density (power composition quality)
               -- 6% Glory score (Accumulated points & presence)
               -- 3% Other events (DTR & Arms Race)
               CASE
                 WHEN c.global_total > 0 OR c.shadow_total > 0 OR c.svs_total > 0 OR c.gvg_total > 0 THEN
                   ROUND(
                     (
                       COALESCE(c.shadow_rate, 0::NUMERIC) * 0.28::NUMERIC +
                       COALESCE(c.day6_score, 0::NUMERIC)  * 0.25::NUMERIC +
                       COALESCE(c.svs_rate, 0::NUMERIC)    * 0.14::NUMERIC +
                       COALESCE(c.gvg_rate, 0::NUMERIC)    * 0.14::NUMERIC +
                       COALESCE(c.combat_density_score, 0::NUMERIC) * 0.10::NUMERIC +
                       COALESCE(c.glory_score, 0::NUMERIC) * 0.06::NUMERIC +
                       COALESCE(c.global_rate, 0::NUMERIC) * 0.03::NUMERIC
                     )::NUMERIC,
                     1
                   )
                 ELSE NULL
               END AS draft_score
        FROM calc c
    )
    SELECT s.pseudo,
           s.guild,
           s.server_number,
           s.power,
           s.combat_density_raw,
           s.combat_density_score,
           s.draft_score,
           s.day6_score,
           s.day6_pvp_score,
           s.svs_attended,
           s.svs_total,
           s.svs_rate,
           s.svs_avg_prep,
           s.svs_avg_pvp,
           s.gvg_attended,
           s.gvg_total,
           s.gvg_rate,
           s.gvg_avg_prep,
           s.gvg_avg_pvp,
           s.shadow_attended,
           s.shadow_total,
           s.shadow_rate,
           s.dtr_attended,
           s.dtr_total,
           s.dtr_rate,
           s.arms_attended,
           s.arms_total,
           s.arms_rate,
           s.glory_score,
           s.glory_total,
           s.glory_attended,
           s.glory_total_weeks,
           s.glory_rate,
           s.global_attended,
           s.global_total,
           s.global_rate,
           CASE
             WHEN COALESCE(s.draft_score, 0) >= 80 THEN 'ELITE'
             WHEN COALESCE(s.draft_score, 0) >= 60 THEN 'WARRIOR'
             WHEN COALESCE(s.draft_score, 0) >= 35 THEN 'PILLAR'
             ELSE 'RECRUIT'
           END AS scouting_tier
    FROM scored s
    ORDER BY s.draft_score DESC NULLS LAST, s.day6_score DESC NULLS LAST, s.power DESC;
END;
$fn$;

REVOKE ALL ON FUNCTION public.gm_cross_guild_ranking() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_cross_guild_ranking() TO authenticated;

NOTIFY pgrst, 'reload schema';
