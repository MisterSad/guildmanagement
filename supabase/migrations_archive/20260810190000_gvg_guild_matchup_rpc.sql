-- 20260810190000_gvg_guild_matchup_rpc.sql
-- RPC for SuperAdmin GvG Guild vs Guild Matchup & Dangerosity Scoring.

drop function if exists public.gm_gvg_guild_matchup();
create or replace function public.gm_gvg_guild_matchup()
 returns table(
   guild text,
   server_number text,
   member_count integer,
   total_power bigint,
   avg_power bigint,
   gvg_count integer,
   avg_prep_score bigint,
   avg_pvp_score bigint,
   total_prep_score bigint,
   total_pvp_score bigint,
   danger_score bigint,
   danger_tier text
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
  with gvg_ep AS (
    SELECT ep0.guild AS guild_id,
           ep0.session_id,
           COALESCE(ep0.score_prep, 0)::bigint AS prep,
           COALESCE(ep0.score_pvp, 0)::bigint  AS pvp
    FROM public.event_participants ep0
    WHERE ep0.is_pending = false
      AND ep0.guild <> 'DEMO'
      AND upper(ep0.event_name) = 'GVG'
  ),
  gvg_sessions AS (
    SELECT e.guild_id,
           e.session_id,
           sum(e.prep)::bigint AS sess_prep,
           sum(e.pvp)::bigint  AS sess_pvp
    FROM gvg_ep e
    GROUP BY e.guild_id, e.session_id
  ),
  gvg_guild_stats AS (
    SELECT s.guild_id,
           count(*)::integer AS sess_count,
           round(avg(s.sess_prep))::bigint AS avg_t_prep,
           round(avg(s.sess_pvp))::bigint  AS avg_t_pvp,
           round(avg(e0.prep))::bigint     AS avg_m_prep,
           round(avg(e0.pvp))::bigint      AS avg_m_pvp
    FROM gvg_sessions s
    JOIN gvg_ep e0 ON e0.guild_id = s.guild_id
    GROUP BY s.guild_id
  ),
  guild_roster AS (
    SELECT m.guild AS guild_id,
           g.server_number,
           count(*)::integer AS member_cnt,
           COALESCE(sum(m.overall_power), 0)::bigint AS tot_power,
           COALESCE(round(avg(m.overall_power)), 0)::bigint AS avg_power
    FROM public.guild_members m
    LEFT JOIN public.guilds g ON g.id = m.guild
    WHERE m.guild <> 'DEMO'
    GROUP BY m.guild, g.server_number
  ),
  calc AS (
    SELECT r.guild_id AS guild,
           COALESCE(r.server_number, '')::text AS server_number,
           r.member_cnt AS member_count,
           r.tot_power AS total_power,
           r.avg_power,
           COALESCE(gs.sess_count, 0)::integer AS gvg_count,
           COALESCE(gs.avg_m_prep, 0)::bigint AS avg_prep_score,
           COALESCE(gs.avg_m_pvp, 0)::bigint AS avg_pvp_score,
           COALESCE(gs.avg_t_prep, 0)::bigint AS total_prep_score,
           COALESCE(gs.avg_t_pvp, 0)::bigint AS total_pvp_score,
           (
             r.tot_power +
             (COALESCE(gs.avg_t_prep, 0) * 2) +
             (COALESCE(gs.avg_t_pvp, 0) * 5)
           )::numeric AS raw_danger,
           CASE
             WHEN r.tot_power < 1500000000 THEN 0.40
             WHEN r.tot_power <= 3500000000 THEN 0.70
             ELSE 1.00
           END AS power_mult
    FROM guild_roster r
    LEFT JOIN gvg_guild_stats gs ON gs.guild_id = r.guild_id
  ),
  combined AS (
    SELECT c.guild,
           c.server_number,
           c.member_count,
           c.total_power,
           c.avg_power,
           c.gvg_count,
           c.avg_prep_score,
           c.avg_pvp_score,
           c.total_prep_score,
           c.total_pvp_score,
           round(c.raw_danger * c.power_mult)::bigint AS danger_score
    FROM calc c
  )
  SELECT c.guild,
         c.server_number,
         c.member_count,
         c.total_power,
         c.avg_power,
         c.gvg_count,
         c.avg_prep_score,
         c.avg_pvp_score,
         c.total_prep_score,
         c.total_pvp_score,
         c.danger_score,
         CASE
           WHEN c.danger_score >= 3000000000 THEN 'EXTREME'
           WHEN c.danger_score >= 1500000000 THEN 'HIGH'
           WHEN c.danger_score >= 500000000  THEN 'MEDIUM'
           ELSE 'LOW'
         END AS danger_tier
  FROM combined c
  ORDER BY c.danger_score DESC, c.total_power DESC;
end
$fn$;

revoke all on function public.gm_gvg_guild_matchup() from public, anon, authenticated;
grant execute on function public.gm_gvg_guild_matchup() to authenticated;

notify pgrst, 'reload schema';
