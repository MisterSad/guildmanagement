-- 20260808010000_event_session_id_scheme.sql
-- Human-readable, chronologically-sortable event session IDs, applied to
-- EVERY tenant (SaaS: never per-tenant).
--
--   SvS           -> SVS-YYYY-Www   (ISO week)
--   GvG           -> GVG-YYYY-Www
--   Glory         -> GLORY-YYYY-Www (weekly)
--   ARMS A        -> ARA-YYYYMMDD
--   ARMS B        -> ARB-YYYYMMDD
--   Defend Trade  -> DTR-YYYYMMDD
--   Shadowfront   -> SF1-/SF2-YYYYMMDD
--
-- The ID is generated deterministically from the battle date, so a re-Start of
-- the same event reuses the same session (no more ghost duplicate sessions).

-- ── 1. gm_event_session_id: deterministic session id from an event name and
-- a reference date (battle date). SQL + JS (gm-utils.js) must agree.
create or replace function public.gm_event_session_id(p_event_name text, p_date date)
 returns text
 language sql
 immutable
 set search_path to ''
as $function$
  select case
    when upper(p_event_name) = 'SVS' then 'SVS-' || to_char(p_date, 'IYYY-"W"IW')
    when upper(p_event_name) = 'GVG' then 'GVG-' || to_char(p_date, 'IYYY-"W"IW')
    when upper(p_event_name) = 'GLORY' then 'GLORY-' || to_char(p_date, 'IYYY-"W"IW')
    when upper(p_event_name) = 'ARMS RACE STAGE A' then 'ARA-' || to_char(p_date, 'YYYYMMDD')
    when upper(p_event_name) = 'ARMS RACE STAGE B' then 'ARB-' || to_char(p_date, 'YYYYMMDD')
    when upper(p_event_name) = 'DEFEND TRADE ROUTE' then 'DTR-' || to_char(p_date, 'YYYYMMDD')
    when upper(p_event_name) = 'SHADOWFRONT SQUAD 1' then 'SF1-' || to_char(p_date, 'YYYYMMDD')
    when upper(p_event_name) = 'SHADOWFRONT SQUAD 2' then 'SF2-' || to_char(p_date, 'YYYYMMDD')
    else 'EV-' || to_char(p_date, 'YYYYMMDD')
  end;
$function$;

revoke all on function public.gm_event_session_id(text, date)
  from public, anon, authenticated;
grant execute on function public.gm_event_session_id(text, date)
  to service_role;

-- ── 2. gm_upsert_player_glory: store the weekly Glory row under a
-- GLORY-YYYY-Www session id so every tenant's Glory is keyed and sortable the
-- same way. The partial unique index event_participants_no_session_unique only
-- guards session_id IS NULL rows, so the upsert now targets the
-- sessioned index event_participants_session_unique.
create or replace function public.gm_upsert_player_glory(
  p_guild text,
  p_pseudo text,
  p_week_start text,
  p_glory integer
)
 returns table(ok boolean, error text)
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_session text;
begin
  if p_guild is null or p_pseudo is null or p_week_start is null then
    return query select false, 'missing_parameters';
    return;
  end if;

  v_session := public.gm_event_session_id('Glory', p_week_start::date);

  insert into public.event_participants (guild, event_name, week_start, pseudo, participated, score, session_id)
  values (p_guild, 'Glory', p_week_start::date, p_pseudo, 1, p_glory, v_session)
  on conflict (guild, event_name, session_id, pseudo) where session_id is not null do update
    set score = p_glory, participated = 1;

  return query select true, null;
end;
$function$;

revoke all on function public.gm_upsert_player_glory(text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.gm_upsert_player_glory(text, text, text, integer)
  to service_role;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
