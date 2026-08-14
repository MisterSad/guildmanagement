-- 20260810050000_fix_session_id_sequence.sql
-- Daily session IDs (DTR, ARA, ARB, SF1, SF2) now include a sequence suffix
-- to allow multiple sessions on the same UTC day:
--   DTR-20260812-1, DTR-20260812-2, ARA-20260812-1, SF1-20260812-1, etc.
-- Weekly IDs (SVS-2026-W32, GVG-2026-W32, GLORY-2026-W32) are unchanged.
--
-- Adds gm_session_id_base() helper to extract the date-only base from a
-- sequenced session_id (strips the trailing -N suffix).
--
-- Updates gm_event_scoring_key: each daily session still counts as its own
-- scoring unit (same behavior as before for DTR and Arms Race post-20260809190000).
-- No changes to scoring logic, only to session_id generation on the frontend.
--
-- No schema changes to indexes or constraints: session_id is TEXT and the
-- existing partial unique indexes already enforce (guild, event_name, session_id, pseudo).

-- ── 1. Helper: extract the date-only base from a sequenced session_id ─────────
-- 'DTR-20260812-2'   -> 'DTR-20260812'
-- 'ARA-20260812-1'   -> 'ARA-20260812'
-- 'SF1-20260812'     -> 'SF1-20260812'  (no suffix: unchanged)
-- 'SVS-2026-W32'     -> 'SVS-2026-W32'  (no numeric-only suffix: unchanged)
create or replace function public.gm_session_id_base(p_session_id text)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  -- Strip trailing -N where N is purely numeric (the sequence counter)
  select regexp_replace(p_session_id, '-[0-9]+$', '');
$function$;

revoke all on function public.gm_session_id_base(text)
  from public, anon, authenticated;
grant execute on function public.gm_session_id_base(text)
  to service_role;

-- ── 2. Update gm_event_scoring_key (drop + create for fresh OID) ─────────────
-- Arms Race: each Stage session (ARA-YYYYMMDD-N / ARB-YYYYMMDD-N) is a
-- separate scoring unit (unchanged from 20260809190000).
-- DTR: each session counts separately (unchanged).
-- Shadowfront: once per week (Squad 1 + Squad 2 combined, unchanged).
-- SvS / GvG: once per week (unchanged).
drop function if exists public.gm_event_scoring_key(text, text, text);
create or replace function public.gm_event_scoring_key(p_event_name text, p_session_id text, p_week_start text)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select case
    when upper(p_event_name) like 'ARMS RACE%'        then 'Arms Race|' || coalesce(p_session_id, p_week_start, '')
    when upper(p_event_name) = 'SHADOWFRONT'          then 'Shadowfront|' || coalesce(p_week_start, '')
    when upper(p_event_name) = 'SVS'                  then 'SvS|' || coalesce(p_week_start, '')
    when upper(p_event_name) = 'GVG'                  then 'GvG|' || coalesce(p_week_start, '')
    when upper(p_event_name) = 'DEFEND TRADE ROUTE'   then 'DTR|' || coalesce(p_session_id, p_week_start, '')
    else coalesce(p_event_name, '') || '|' || coalesce(p_session_id, p_week_start, '')
  end;
$function$;

revoke all on function public.gm_event_scoring_key(text, text, text)
  from public, anon, authenticated;
grant execute on function public.gm_event_scoring_key(text, text, text)
  to service_role;

notify pgrst, 'reload schema';
