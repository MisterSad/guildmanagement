-- 20260808080000_event_scoring_key.sql
-- Participation scoring key, shared by every tenant (SaaS). Mirrors
-- window.GM.eventScoringKey: one key per scoring unit per the game rules.
--
--   - SvS / GvG          -> once per week (SVS-2026-W32)
--   - Shadowfront        -> once per week (Squad 1 + Squad 2 = one)
--   - Arms Race (A or B) -> once per week (Stage A + Stage B = one)
--   - Defend Trade Route -> each event counts (one per session)
--
-- week_start is the Monday (UTC) of the battle week chosen by the admin, so
-- Arms A and Arms B of the same week share the same key.

create or replace function public.gm_event_scoring_key(p_event_name text, p_session_id text, p_week_start text)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select case
    when upper(p_event_name) like 'ARMS RACE%' then 'Arms Race|' || coalesce(p_week_start, '')
    when upper(p_event_name) = 'SHADOWFRONT' then 'Shadowfront|' || coalesce(p_week_start, '')
    when upper(p_event_name) = 'SVS' then 'SvS|' || coalesce(p_week_start, '')
    when upper(p_event_name) = 'GVG' then 'GvG|' || coalesce(p_week_start, '')
    when upper(p_event_name) = 'DEFEND TRADE ROUTE' then 'DTR|' || coalesce(p_session_id, p_week_start, '')
    else coalesce(p_event_name, '') || '|' || coalesce(p_session_id, p_week_start, '')
  end;
$function$;

revoke all on function public.gm_event_scoring_key(text, text, text)
  from public, anon, authenticated;
grant execute on function public.gm_event_scoring_key(text, text, text)
  to service_role;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
