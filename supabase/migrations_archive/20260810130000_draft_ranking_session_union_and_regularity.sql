-- 20260810130000_draft_ranking_session_union_and_regularity.sql
-- Computes guild session totals by combining event_status and event_participants,
-- ensuring all guild events (including Shadowfront) are counted in total denominators.

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
    SELECT ep0.guild,
           ep0.pseudo,
           ep0.event_name,
           public.gm_event_scoring_key(ep0.event_name, ep0.session_id, ep0.week_start::text) AS skey,
           (ep0.participated > 0) AS attended,
           (ep0.event_name = 'Glory') AS is_glory
    FROM public.event_participants ep0
    WHERE ep0.is_pending = false
      AND public.gm_event_scoring_key(ep0.event_name, ep0.session_id, ep0.week_start::text) IS NOT NULL
  ),
  es_sess AS (
    SELECT DISTINCT es0.guild,
           public.gm_event_scoring_key(es0.event_name, es0.session_id, NULL) AS skey
    FROM public.event_status es0
    WHERE public.gm_event_scoring_key(es0.event_name, es0.session_id, NULL) IS NOT NULL
  ),
  ep_sess AS (
    SELECT DISTINCT e.guild, e.skey FROM ep e
  ),
  sess AS (
    SELECT guild, skey FROM es_sess
    UNION
    SELECT guild, skey FROM ep_sess
  ),
  sess_totals AS (
    SELECT s.guild,
           count(*) FILTER (WHERE s.skey LIKE 'SvS|%')          AS svs_tot,
           count(*) FILTER (WHERE s.skey LIKE 'GvG|%')          AS gvg_tot,
           count(*) FILTER (WHERE s.skey LIKE 'Shadowfront|%')  AS sh_tot,
           count(*) FILTER (WHERE s.skey LIKE 'Glory|%')        AS gl_tot,
           count(*) FILTER (WHERE s.skey NOT LIKE 'Glory|%')    AS g_tot
    FROM sess s
    GROUP BY s.guild
  ),
  player_stats AS (
    SELECT e.guild,
           lower(btrim(e.pseudo)) AS nkey,
           count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'SvS|%' AND e.attended)          AS svs_att,
           count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'GvG|%' AND e.attended)          AS gvg_att,
           count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Shadowfront|%' AND e.attended)  AS sh_att,
           GREATEST(count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Glory|%' AND e.attended)
                    - CASE WHEN count(DISTINCT e.skey) FILTER (WHERE e.skey LIKE 'Glory|%' AND e.attended) > 0 THEN 1 ELSE 0 END, 0) AS gl_att,
           count(DISTINCT e.skey) FILTER (WHERE NOT e.is_glory AND e.attended)               AS g_att
    FROM ep e
    GROUP BY e.guild, lower(btrim(e.pseudo))
  ),
  roster AS (
    SELECT DISTINCT ON (m.guild, lower(btrim(m.pseudo)))
           m.guild,
           g.server_number,
           m.pseudo,
           m.overall_power AS power
    FROM public.guild_members m
    LEFT JOIN public.guilds g ON g.id = m.guild
    ORDER BY m.guild, lower(btrim(m.pseudo)), m.created_at DESC, m.id DESC
  )
  SELECT r.pseudo,
         r.guild,
         COALESCE(r.server_number, '')::text,
         COALESCE(r.power, 0)::bigint,
         COALESCE(ps.svs_att, 0)::integer,
         COALESCE(st.svs_tot, 0)::integer,
         CASE WHEN COALESCE(st.svs_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.svs_att, 0) / st.svs_tot, 1) END,
         COALESCE(ps.gvg_att, 0)::integer,
         COALESCE(st.gvg_tot, 0)::integer,
         CASE WHEN COALESCE(st.gvg_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.gvg_att, 0) / st.gvg_tot, 1) END,
         COALESCE(ps.sh_att, 0)::integer,
         COALESCE(st.sh_tot, 0)::integer,
         CASE WHEN COALESCE(st.sh_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.sh_att, 0) / st.sh_tot, 1) END,
         COALESCE(ps.gl_att, 0)::integer,
         COALESCE(st.gl_tot, 0)::integer,
         CASE WHEN COALESCE(st.gl_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.gl_att, 0) / st.gl_tot, 1) END,
         COALESCE(ps.g_att, 0)::integer,
         COALESCE(st.g_tot, 0)::integer,
         CASE WHEN COALESCE(st.g_tot, 0) > 0 THEN round(100.0 * COALESCE(ps.g_att, 0) / st.g_tot, 1) END
  FROM roster r
  LEFT JOIN player_stats ps ON ps.guild = r.guild AND ps.nkey = lower(btrim(r.pseudo))
  LEFT JOIN sess_totals st ON st.guild = r.guild
  ORDER BY r.guild, r.pseudo;
end
$fn$;

revoke all on function public.gm_cross_guild_ranking() from public, anon, authenticated;
grant execute on function public.gm_cross_guild_ranking() to authenticated;

notify pgrst, 'reload schema';
