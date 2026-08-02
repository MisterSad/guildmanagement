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
    SELECT guild,
           pseudo,
           event_name,
           COALESCE(NULLIF(session_id, ''), week_start::text) AS skey,
           (participated > 0) AS attended,
           (event_name = 'Glory') AS is_glory
    FROM public.event_participants
    WHERE is_pending = false
      AND COALESCE(NULLIF(session_id, ''), week_start::text) IS NOT NULL
  ),
  sess AS (
    SELECT DISTINCT guild, event_name, skey FROM ep
  ),
  sess_totals AS (
    SELECT guild,
           count(*) FILTER (WHERE event_name = 'SvS')         AS svs_tot,
           count(*) FILTER (WHERE event_name = 'GvG')         AS gvg_tot,
           count(*) FILTER (WHERE event_name = 'Shadowfront') AS sh_tot,
           count(*) FILTER (WHERE event_name = 'Glory')       AS gl_tot,
           count(*) FILTER (WHERE event_name <> 'Glory')      AS g_tot
    FROM sess
    GROUP BY guild
  ),
  player_stats AS (
    SELECT guild,
           lower(btrim(pseudo)) AS nkey,
           count(DISTINCT skey) FILTER (WHERE event_name = 'SvS' AND attended)         AS svs_att,
           count(DISTINCT skey) FILTER (WHERE event_name = 'GvG' AND attended)         AS gvg_att,
           count(DISTINCT skey) FILTER (WHERE event_name = 'Shadowfront' AND attended) AS sh_att,
           count(DISTINCT skey) FILTER (WHERE event_name = 'Glory' AND attended)       AS gl_att,
           count(DISTINCT skey) FILTER (WHERE NOT is_glory AND attended)               AS g_att
    FROM ep
    GROUP BY guild, lower(btrim(pseudo))
  ),
  roster AS (
    SELECT DISTINCT ON (guild, lower(btrim(pseudo)))
           guild, pseudo, overall_power AS power
    FROM public.guild_members
    ORDER BY guild, lower(btrim(pseudo)), created_at DESC, id DESC
  )
  SELECT r.pseudo,
         r.guild,
         COALESCE(r.power, 0)::bigint,
         COALESCE(ps.svs_att, 0)::integer,
         st.svs_tot,
         CASE WHEN st.svs_tot > 0 THEN round(100.0 * COALESCE(ps.svs_att, 0) / st.svs_tot, 1) END,
         COALESCE(ps.gvg_att, 0)::integer,
         st.gvg_tot,
         CASE WHEN st.gvg_tot > 0 THEN round(100.0 * COALESCE(ps.gvg_att, 0) / st.gvg_tot, 1) END,
         COALESCE(ps.sh_att, 0)::integer,
         st.sh_tot,
         CASE WHEN st.sh_tot > 0 THEN round(100.0 * COALESCE(ps.sh_att, 0) / st.sh_tot, 1) END,
         COALESCE(ps.gl_att, 0)::integer,
         st.gl_tot,
         CASE WHEN st.gl_tot > 0 THEN round(100.0 * COALESCE(ps.gl_att, 0) / st.gl_tot, 1) END,
         COALESCE(ps.g_att, 0)::integer,
         st.g_tot,
         CASE WHEN st.g_tot > 0 THEN round(100.0 * COALESCE(ps.g_att, 0) / st.g_tot, 1) END
  FROM roster r
  LEFT JOIN player_stats ps ON ps.guild = r.guild AND ps.nkey = lower(btrim(r.pseudo))
  LEFT JOIN sess_totals st ON st.guild = r.guild
  ORDER BY r.guild, r.pseudo;
END
$fn$;

GRANT EXECUTE ON FUNCTION public.gm_cross_guild_ranking() TO authenticated;
