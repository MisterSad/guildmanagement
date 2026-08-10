-- 20260810150000_fix_cross_guild_ranking_ambiguous_guild.sql
-- Fixes "column reference 'guild' is ambiguous" in gm_cross_guild_ranking() by using guild_id aliases inside CTEs.

drop function if exists public.gm_cross_guild_ranking();
create or replace function public.gm_cross_guild_ranking()
 returns table(
   pseudo text,
   guild text,
   server_number text,
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
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_super boolean;
begin
  select public.is_super_admin() into v_super;
  if not v_super then
    return;
  end if;

  return query
  with ep AS (
    SELECT ep0.guild AS guild_id,
           ep0.pseudo,
           ep0.event_name,
           public.gm_event_scoring_key(ep0.event_name, ep0.session_id, ep0.week_start::text) AS skey,
           (ep0.participated > 0) AS attended,
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
           count(*) FILTER (WHERE s.skey LIKE 'SvS|%')          AS svs_tot,
           count(*) FILTER (WHERE s.skey LIKE 'GvG|%')          AS gvg_tot,
           count(*) FILTER (WHERE s.skey LIKE 'Shadowfront|%')  AS sh_tot,
           count(*) FILTER (WHERE s.skey LIKE 'Glory|%')        AS gl_tot,
           count(*) FILTER (WHERE s.skey NOT LIKE 'Glory|%')    AS g_tot
    FROM sess s
    GROUP BY s.guild_id
  ),
  player_stats AS (
    SELECT e.guild_id,
           lower(btrim(e.pseudo)) AS nkey,
           count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'SvS|%' AND e.attended)          AS svs_att,
           count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'GvG|%' AND e.attended)          AS gvg_att,
           count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Shadowfront|%' AND e.attended)  AS sh_att,
           GREATEST(count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Glory|%' AND e.attended)
                    - CASE WHEN count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Glory|%' AND e.attended) > 0 THEN 1 ELSE 0 END, 0) AS gl_att,
           count(DISTINCT e.skey) FILTER (WHERE NOT e.is_glory AND e.attended)               AS g_att
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
  )
  SELECT r.pseudo,
         r.guild_id AS guild,
         COALESCE(r.server_number, '')::text AS server_number,
         COALESCE(r.power, 0)::bigint AS power,
         COALESCE(ps.svs_att, 0)::integer AS svs_attended,
         COALESCE(st.svs_tot, 0)::integer AS svs_total,
         CASE WHEN COALESCE(st.svs_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.svs_att, 0) / st.svs_tot, 1) END AS svs_rate,
         COALESCE(ps.gvg_att, 0)::integer AS gvg_attended,
         COALESCE(st.gvg_tot, 0)::integer AS gvg_total,
         CASE WHEN COALESCE(st.gvg_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.gvg_att, 0) / st.gvg_tot, 1) END AS gvg_rate,
         COALESCE(ps.sh_att, 0)::integer AS shadow_attended,
         COALESCE(st.sh_tot, 0)::integer AS shadow_total,
         CASE WHEN COALESCE(st.sh_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.sh_att, 0) / st.sh_tot, 1) END AS shadow_rate,
         COALESCE(ps.gl_att, 0)::integer AS glory_attended,
         COALESCE(st.gl_tot, 0)::integer AS glory_total,
         CASE WHEN COALESCE(st.gl_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.gl_att, 0) / st.gl_tot, 1) END AS glory_rate,
         COALESCE(ps.g_att, 0)::integer AS global_attended,
         COALESCE(st.g_tot, 0)::integer AS global_total,
         CASE WHEN COALESCE(st.g_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.g_att, 0) / st.g_tot, 1) END AS global_rate
  FROM roster r
  LEFT JOIN player_stats ps ON ps.guild_id = r.guild_id AND ps.nkey = lower(btrim(r.pseudo))
  LEFT JOIN sess_totals st ON st.guild_id = r.guild_id
  ORDER BY r.guild_id, r.pseudo;
end
$fn$;

revoke all on function public.gm_cross_guild_ranking() from public, anon, authenticated;
grant execute on function public.gm_cross_guild_ranking() to authenticated;

notify pgrst, 'reload schema';
