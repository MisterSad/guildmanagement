-- Migration: fully revoke EXECUTE from PUBLIC on the leaked RPCs.
-- The previous migration revoked from anon/authenticated only, but functions
-- grant EXECUTE to PUBLIC by default, so anon still inherited it. Follow the
-- project pattern: revoke from public, anon AND authenticated, then grant
-- back to authenticated where legitimately needed.

revoke all on function public.list_event_sessions(text) from public, anon, authenticated;
revoke all on function public.list_event_weeks(text) from public, anon, authenticated;
revoke all on function public.request_guild_transfer(text, text) from public, anon, authenticated;
revoke all on function public.check_uid_exists_globally(text) from public, anon, authenticated;

grant execute on function public.list_event_sessions(text) to authenticated;
grant execute on function public.list_event_weeks(text) to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
