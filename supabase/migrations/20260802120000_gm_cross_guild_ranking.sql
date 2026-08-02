-- Cross-guild player ranking for super admins ("Settings" tab).
--
-- One consolidated view of every player across all guilds using the app:
-- current power, participation rates per event type (SvS, GvG, Shadowfront,
-- Glory) and a global attendance rate (all event types except Glory, which
-- matches the participation semantics used by the stats module).
--
-- Semantics (consistent with the app's participation mode):
--   - a session = distinct (event_name, session_id|week_start) per guild
--   - rate(type) = attended sessions of that type / total sessions of that
--     type in the player's guild (pending rows excluded)
--   - players without recorded rows of a type get a NULL rate ("—" in the UI)
--
-- Access: SECURITY DEFINER guarded by is_super_admin(); any other caller
-- receives an empty result set.

CREATE OR REPLACE FUNCTION public.gm_cross_guild_ranking()
 RETURNS TABLE(
   pseudo text,
   guild text,
   power bigint,
   svs_attended integer,
   svs_total integer,
   svs_rate numeric,
   gvg_attended integer,
   gvg_total integer,
   gvg_rate numeric,
   shadow_attended integer,
   shadow_total integer,
   shadow_rate numeric,
   glory_attended integer,
   glory_total integer,
   glory_rate numeric,
   global_attended integer,
   global_total integer,
   global_rate numeric
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_super boolean;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  IF NOT v_super THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH ep AS (
    SELECT ep0.guild,
           ep0.pseudo,
           ep0.event_name,
           COALESCE(NULLIF(ep0.session_id, ''), ep0.week_start::text) AS skey,
           (ep0.participated > 0) AS attended,
           (ep0.event_name = 'Glory') AS is_glory
    FROM public.event_participants ep0
    WHERE ep0.is_pending = false
      AND COALESCE(NULLIF(ep0.session_id, ''), ep0.week_start::text) IS NOT NULL
  ),
  sess AS (
    SELECT DISTINCT e.guild, e.event_name, e.skey FROM ep e
  ),
  sess_totals AS (
    SELECT s.guild,
           count(*) FILTER (WHERE s.event_name = 'SvS')         AS svs_tot,
           count(*) FILTER (WHERE s.event_name = 'GvG')         AS gvg_tot,
           count(*) FILTER (WHERE s.event_name = 'Shadowfront') AS sh_tot,
           count(*) FILTER (WHERE s.event_name = 'Glory')       AS gl_tot,
           count(*) FILTER (WHERE s.event_name <> 'Glory')      AS g_tot
    FROM sess s
    GROUP BY s.guild
  ),
  player_stats AS (
    SELECT e.guild,
           lower(btrim(e.pseudo)) AS nkey,
           count(DISTINCT e.skey) FILTER (WHERE e.event_name = 'SvS' AND e.attended)         AS svs_att,
           count(DISTINCT e.skey) FILTER (WHERE e.event_name = 'GvG' AND e.attended)         AS gvg_att,
           count(DISTINCT e.skey) FILTER (WHERE e.event_name = 'Shadowfront' AND e.attended) AS sh_att,
           count(DISTINCT e.skey) FILTER (WHERE e.event_name = 'Glory' AND e.attended)       AS gl_att,
           count(DISTINCT e.skey) FILTER (WHERE NOT e.is_glory AND e.attended)               AS g_att
    FROM ep e
    GROUP BY e.guild, lower(btrim(e.pseudo))
  ),
  roster AS (
    SELECT DISTINCT ON (m.guild, lower(btrim(m.pseudo)))
           m.guild, m.pseudo, m.overall_power AS power
    FROM public.guild_members m
    ORDER BY m.guild, lower(btrim(m.pseudo)), m.created_at DESC, m.id DESC
  )
  SELECT r.pseudo,
         r.guild,
         COALESCE(r.power, 0)::bigint,
         COALESCE(ps.svs_att, 0)::integer,
         st.svs_tot::integer,
         CASE WHEN st.svs_tot > 0 THEN round(100.0 * COALESCE(ps.svs_att, 0) / st.svs_tot, 1) END,
         COALESCE(ps.gvg_att, 0)::integer,
         st.gvg_tot::integer,
         CASE WHEN st.gvg_tot > 0 THEN round(100.0 * COALESCE(ps.gvg_att, 0) / st.gvg_tot, 1) END,
         COALESCE(ps.sh_att, 0)::integer,
         st.sh_tot::integer,
         CASE WHEN st.sh_tot > 0 THEN round(100.0 * COALESCE(ps.sh_att, 0) / st.sh_tot, 1) END,
         COALESCE(ps.gl_att, 0)::integer,
         st.gl_tot::integer,
         CASE WHEN st.gl_tot > 0 THEN round(100.0 * COALESCE(ps.gl_att, 0) / st.gl_tot, 1) END,
         COALESCE(ps.g_att, 0)::integer,
         st.g_tot::integer,
         CASE WHEN st.g_tot > 0 THEN round(100.0 * COALESCE(ps.g_att, 0) / st.g_tot, 1) END
  FROM roster r
  LEFT JOIN player_stats ps ON ps.guild = r.guild AND ps.nkey = lower(btrim(r.pseudo))
  LEFT JOIN sess_totals st ON st.guild = r.guild
  ORDER BY r.guild, r.pseudo;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.gm_cross_guild_ranking() TO authenticated;
