-- 20260809170000_harden_populate_rpc_and_fix_babe_glory.sql
-- SaaS hardening + data fix discovered by the cross-tenant audit.
--
-- 1. gm_populate_event_participants(text,text,date) is a legacy 3-argument
--    overload that falls back to v_guild := 'ALPHA' when the guild cannot be
--    resolved, and its authorization check is weak. The frontend only ever
--    calls the 4-argument overload (with an explicit p_guild). Revoke the
--    legacy overload so no authenticated caller can accidentally populate
--    participants into ALPHA.
--
-- 2. BABE's current-week Glory rows (week_start 2026-08-03) carry
--    session_id = NULL (created before Glory rows were keyed with a
--    GLORY-YYYY-Www session id). Every other tenant uses GLORY-2026-W32, so
--    player-portal Glory upserts on BABE would insert duplicate rows (the
--    conflict target is the sessioned index). Backfill the missing session id
--    so BABE matches the other tenants.

-- 1. Revoke legacy overload
revoke all on function public.gm_populate_event_participants(text, text, date)
  from public, anon, authenticated;
-- (service_role may keep it if anything internal relies on it; the grants are
--  now limited to the explicit 4-arg overload used by the frontend.)

-- 2. Backfill BABE Glory session ids for the current week
update public.event_participants
  set session_id = 'GLORY-2026-W32'
  where guild = 'BABE'
    and event_name = 'Glory'
    and week_start = '2026-08-03'
    and session_id is null;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
