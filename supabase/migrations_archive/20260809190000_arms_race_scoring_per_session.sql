-- 20260809190000_arms_race_scoring_per_session.sql
-- Arms Race scoring: each Stage session counts as one event. Previously Arms
-- A + B of the same week shared one scoring key ("Arms Race|week"), so a guild
-- running two Arms Race cycles in one week (e.g. CLAW on 08-05 and 08-08) only
-- counted once and the participation denominator was too small.
--
-- Now Stage A and Stage B are separate events, keyed by their session id, the
-- same way Defend Trade Route is. 2 x A + 2 x B in a week = 4 events.
-- Mirrors window.GM.eventScoringKey (gm-utils.js) and the member-portal edge
-- function. Drop + recreate for a fresh OID so PostgREST drops cached plans.

drop function if exists public.gm_event_scoring_key(text, text, text);
create or replace function public.gm_event_scoring_key(p_event_name text, p_session_id text, p_week_start text)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select case
    when upper(p_event_name) like 'ARMS RACE%' then 'Arms Race|' || coalesce(p_session_id, p_week_start, '')
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
