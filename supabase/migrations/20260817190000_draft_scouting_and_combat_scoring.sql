-- 20260817190000_draft_scouting_and_combat_scoring.sql
-- Overhauls public.gm_cross_guild_ranking() into an Inter-Server Migration Scouting & Combat Scoring Engine.
-- Prioritizes:
-- 1. SvS & GvG Day 1-5 presence + Day 6 PvP battle scores doubled (2x weight).
-- 2. Shadowfront attendance rate priority for 20v20 guild coordination.
-- 3. Total cumulative Glory points accumulated.
-- 4. Server-scoped filtering & grouping for migration scouting.

DROP FUNCTION IF EXISTS public.gm_cross_guild_ranking();

CREATE OR REPLACE FUNCTION public.gm_cross_guild_ranking()
RETURNS TABLE(
    pseudo TEXT,
    guild TEXT,
    server_number TEXT,
    power BIGINT,
    draft_score NUMERIC,
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
    roster AS (
        SELECT DISTINCT ON (m.guild, lower(btrim(m.pseudo)))
               m.guild AS guild_id,
               g.server_number,
               m.pseudo,
               m.overall_power AS power
        FROM public.guild_members m
        LEFT JOIN public.guilds g ON g.id = m.guild
        WHERE m.guild <> 'DEMO'
        ORDER BY m.guild, lower(btrim(m.pseudo)), m.created_at DESC, m.id DESC
    ),
    calc AS (
        SELECT r.pseudo,
               r.guild_id AS guild,
               COALESCE(r.server_number, '')::TEXT AS server_number,
               COALESCE(r.power, 0)::BIGINT AS power,
               -- SvS
               COALESCE(ps.svs_att, 0)::INTEGER AS svs_attended,
               COALESCE(st.svs_tot, 0)::INTEGER AS svs_total,
               CASE WHEN COALESCE(st.svs_tot, 0) > 0 THEN ROUND(100.0 * COALESCE(ps.svs_att, 0) / st.svs_tot, 1) END AS svs_rate,
               COALESCE(ps.svs_avg_prep, 0)::BIGINT AS svs_avg_prep,
               COALESCE(ps.svs_avg_pvp, 0)::BIGINT AS svs_avg_pvp,
               -- GvG
               COALESCE(ps.gvg_att, 0)::INTEGER AS gvg_attended,
               COALESCE(st.gvg_tot, 0)::INTEGER AS gvg_total,
               CASE WHEN COALESCE(st.gvg_tot, 0) > 0 THEN ROUND(100.0 * COALESCE(ps.gvg_att, 0) / st.gvg_tot, 1) END AS gvg_rate,
               COALESCE(ps.gvg_avg_prep, 0)::BIGINT AS gvg_avg_prep,
               COALESCE(ps.gvg_avg_pvp, 0)::BIGINT AS gvg_avg_pvp,
               -- Combined Day 6 PvP combat score (Doubled: 2x factor)
               (
                 (2 * COALESCE(ps.svs_avg_pvp, 0)) + 
                 (2 * COALESCE(ps.gvg_avg_pvp, 0))
               )::BIGINT AS day6_pvp_score,
               -- Shadowfront
               COALESCE(ps.sh_att, 0)::INTEGER AS shadow_attended,
               COALESCE(st.sh_tot, 0)::INTEGER AS shadow_total,
               CASE WHEN COALESCE(st.sh_tot, 0) > 0 THEN ROUND(100.0 * COALESCE(ps.sh_att, 0) / st.sh_tot, 1) END AS shadow_rate,
               -- DTR
               COALESCE(ps.dtr_att, 0)::INTEGER AS dtr_attended,
               COALESCE(st.dtr_tot, 0)::INTEGER AS dtr_total,
               CASE WHEN COALESCE(st.dtr_tot, 0) > 0 THEN ROUND(100.0 * COALESCE(ps.dtr_att, 0) / st.dtr_tot, 1) END AS dtr_rate,
               -- Arms Race
               COALESCE(ps.ar_att, 0)::INTEGER AS arms_attended,
               COALESCE(st.ar_tot, 0)::INTEGER AS arms_total,
               CASE WHEN COALESCE(st.ar_tot, 0) > 0 THEN ROUND(100.0 * COALESCE(ps.ar_att, 0) / st.ar_tot, 1) END AS arms_rate,
               -- Glory
               COALESCE(ps.gl_total, 0)::BIGINT AS glory_total,
               COALESCE(ps.gl_att, 0)::INTEGER AS glory_attended,
               COALESCE(st.gl_tot, 0)::INTEGER AS glory_total_weeks,
               CASE WHEN COALESCE(st.gl_tot, 0) > 0 THEN ROUND(100.0 * COALESCE(ps.gl_att, 0) / st.gl_tot, 1) END AS glory_rate,
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
                       (CASE WHEN COALESCE(st.svs_tot, 0) > 0 THEN 5.0 * COALESCE(ps.svs_att, 0) / st.svs_tot ELSE 0 END) +
                       (CASE WHEN COALESCE(st.gvg_tot, 0) > 0 THEN 5.0 * COALESCE(ps.gvg_att, 0) / st.gvg_tot ELSE 0 END) +
                       (CASE WHEN COALESCE(st.sh_tot, 0)  > 0 THEN 4.0 * COALESCE(ps.sh_att, 0)  / st.sh_tot  ELSE 0 END) +
                       (CASE WHEN COALESCE(st.dtr_tot, 0) > 0 THEN 2.0 * COALESCE(ps.dtr_att, 0) / st.dtr_tot ELSE 0 END) +
                       (CASE WHEN COALESCE(st.ar_tot, 0)  > 0 THEN 2.0 * COALESCE(ps.ar_att, 0)  / st.ar_tot  ELSE 0 END)
                     ) * 100.0 / (
                       (CASE WHEN COALESCE(st.svs_tot, 0) > 0 THEN 5.0 ELSE 0 END) +
                       (CASE WHEN COALESCE(st.gvg_tot, 0) > 0 THEN 5.0 ELSE 0 END) +
                       (CASE WHEN COALESCE(st.sh_tot, 0)  > 0 THEN 4.0 ELSE 0 END) +
                       (CASE WHEN COALESCE(st.dtr_tot, 0) > 0 THEN 2.0 ELSE 0 END) +
                       (CASE WHEN COALESCE(st.ar_tot, 0)  > 0 THEN 2.0 ELSE 0 END)
                     ),
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
               -- Draft Composite Score (0-100 scale):
               -- 35% Shadowfront attendance (Priority pillar)
               -- 25% SvS attendance & combat
               -- 25% GvG attendance & combat
               -- 10% Other attendance (DTR/Arms)
               -- 5% Glory participation
               CASE 
                 WHEN c.global_total > 0 OR c.shadow_total > 0 OR c.svs_total > 0 OR c.gvg_total > 0 THEN
                   ROUND(
                     (
                       COALESCE(c.shadow_rate, 0) * 0.35 +
                       COALESCE(c.svs_rate, 0)    * 0.25 +
                       COALESCE(c.gvg_rate, 0)    * 0.25 +
                       COALESCE(c.global_rate, 0) * 0.10 +
                       COALESCE(c.glory_rate, 0)  * 0.05
                     ),
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
           s.draft_score,
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
    ORDER BY s.draft_score DESC NULLS LAST, s.day6_pvp_score DESC, s.power DESC;
END;
$fn$;

REVOKE ALL ON FUNCTION public.gm_cross_guild_ranking() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_cross_guild_ranking() TO authenticated;

NOTIFY pgrst, 'reload schema';
