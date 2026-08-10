-- 20260810170000_svs_server_matchup_rpc.sql
-- RPC for SuperAdmin SvS Server vs Server Matchup & Dangerosity Scoring.

drop function if exists public.gm_svs_server_matchup();
create or replace function public.gm_svs_server_matchup()
 returns table(
   pseudo text,
   guild text,
   server_number text,
   power bigint,
   svs_count integer,
   avg_prep_score bigint,
   avg_pvp_score bigint,
   max_prep_score bigint,
   max_pvp_score bigint,
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
  with svs_ep AS (
    SELECT ep0.guild AS guild_id,
           lower(btrim(ep0.pseudo)) AS nkey,
           ep0.pseudo,
           COALESCE(ep0.score_prep, 0)::bigint AS prep,
           COALESCE(ep0.score_pvp, 0)::bigint  AS pvp,
           COALESCE(ep0.score, 0)::bigint      AS total_score
    FROM public.event_participants ep0
    WHERE ep0.is_pending = false
      AND ep0.guild <> 'DEMO'
      AND upper(ep0.event_name) = 'SVS'
  ),
  svs_stats AS (
    SELECT e.guild_id,
           e.nkey,
           count(*)::integer AS sess_count,
           round(avg(e.prep))::bigint AS a_prep,
           round(avg(e.pvp))::bigint AS a_pvp,
           max(e.prep)::bigint AS m_prep,
           max(e.pvp)::bigint AS m_pvp
    FROM svs_ep e
    GROUP BY e.guild_id, e.nkey
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
  combined AS (
    SELECT r.pseudo,
           r.guild_id AS guild,
           COALESCE(r.server_number, '')::text AS server_number,
           COALESCE(r.power, 0)::bigint AS power,
           COALESCE(st.sess_count, 0)::integer AS svs_count,
           COALESCE(st.a_prep, 0)::bigint AS avg_prep_score,
           COALESCE(st.a_pvp, 0)::bigint AS avg_pvp_score,
           COALESCE(st.m_prep, 0)::bigint AS max_prep_score,
           COALESCE(st.m_pvp, 0)::bigint AS max_pvp_score,
           (
             COALESCE(r.power, 0) +
             (COALESCE(st.a_prep, 0) * 2) +
             (COALESCE(st.a_pvp, 0) * 5)
           )::bigint AS danger_score
    FROM roster r
    LEFT JOIN svs_stats st ON st.guild_id = r.guild_id AND st.nkey = lower(btrim(r.pseudo))
  )
  SELECT c.pseudo,
         c.guild,
         c.server_number,
         c.power,
         c.svs_count,
         c.avg_prep_score,
         c.avg_pvp_score,
         c.max_prep_score,
         c.max_pvp_score,
         c.danger_score,
         CASE
           WHEN c.danger_score >= 100000000 OR c.max_pvp_score >= 500000 THEN 'EXTREME'
           WHEN c.danger_score >= 40000000 OR c.max_pvp_score >= 200000  THEN 'HIGH'
           WHEN c.danger_score >= 15000000                               THEN 'MEDIUM'
           ELSE 'LOW'
         END AS danger_tier
  FROM combined c
  ORDER BY c.danger_score DESC, c.power DESC;
end
$fn$;

revoke all on function public.gm_svs_server_matchup() from public, anon, authenticated;
grant execute on function public.gm_svs_server_matchup() to authenticated;

notify pgrst, 'reload schema';
