-- 20260926080100_revoke_overreaching_function_grants.sql
-- AUDIT-2026-09-26 [C2, M15]: three SECURITY DEFINER functions were callable by
-- roles that have no business calling them. None of them performs an
-- authorization check of its own, so the grant *was* the only gate.
--
-- Verified live before writing this migration:
--   has_function_privilege('anon',          'gm_cleanup_expired_ocr_cache()')  = true
--   has_function_privilege('authenticated', 'gm_reset_demo_tenant_data()')     = true
--   save_push_subscription(...) granted to authenticated, anon, service_role
--     (20260830054835_canonicalize_save_push_subscription_v2.sql:45)
--
-- Verified safe: every pg_cron job (daily-demo-tenant-reset,
-- daily-cleanup-stale-locks, guild-requests-expire, login-throttle-retention,
-- fgf-event-reminders) runs as `postgres`, not as `authenticated`/`anon`, so
-- revoking from those two roles does not affect any scheduled job.

-- ============================================================================
-- 1. [C2] save_push_subscription -- anonymous cross-tenant write
-- ============================================================================
-- The function does `v_guild := coalesce(v_guild, 'ALPHA')` at line 31 of its
-- defining migration. For an unauthenticated caller `auth.uid()` is NULL, so
-- the subscription lands in tenant ALPHA: an attacker could register their own
-- Web Push endpoint into ALPHA and receive that guild's event reminders, with
-- no login. `p_pseudo` is written verbatim (impersonation) and
-- `ON CONFLICT (endpoint) DO UPDATE` allows rewriting a victim's row.
--
-- This is the exact bug class CHANGELOG.md:562 claims was eliminated ("purged
-- all hardcoded tenant fallbacks COALESCE(..., 'ALPHA')") -- the function was
-- re-created after that sweep and reintroduced it.
--
-- Web Push is already decommissioned end to end (PushService.init() is an empty
-- body; event-reminders contains no push code), so revoking breaks nothing. The
-- function and its table are dropped outright in the Web Push removal phase;
-- this revoke closes the hole in the meantime.

REVOKE EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text, text)
    FROM anon, authenticated;

-- ============================================================================
-- 2. [M15] Maintenance functions -- unauthenticated / unprivileged DELETE
-- ============================================================================
-- gm_cleanup_expired_ocr_cache(): body is an unconditional
--   DELETE FROM public.ocr_cache WHERE expires_at < now()
-- Callable by `anon`, i.e. anyone holding the (public) publishable key could
-- wipe the OCR cache and force re-billing of Gemini Vision calls.

REVOKE EXECUTE ON FUNCTION public.gm_cleanup_expired_ocr_cache() FROM anon, authenticated;

-- gm_reset_demo_tenant_data(): deletes and rebuilds every DEMO-tenant row.
-- Any logged-in member of any guild could wipe the public demo on demand.

REVOKE EXECUTE ON FUNCTION public.gm_reset_demo_tenant_data() FROM anon, authenticated;

-- Belt and braces: Postgres grants EXECUTE to PUBLIC by default on new
-- functions, and both `anon` and `authenticated` are members of PUBLIC. A
-- REVOKE from the roles alone does not remove a grant held via PUBLIC.

REVOKE EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.gm_cleanup_expired_ocr_cache() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.gm_reset_demo_tenant_data() FROM PUBLIC;

-- `service_role` keeps EXECUTE on all three (it is the path the cron jobs and
-- the Edge Functions use) -- it is deliberately not revoked here.

NOTIFY pgrst, 'reload schema';

/* ============================================================================
   ROLLBACK SQL (restores the pre-audit, insecure state):

   GRANT EXECUTE ON FUNCTION public.save_push_subscription(text, text, text, text, text)
       TO authenticated, anon;
   GRANT EXECUTE ON FUNCTION public.gm_cleanup_expired_ocr_cache() TO anon, authenticated;
   GRANT EXECUTE ON FUNCTION public.gm_reset_demo_tenant_data() TO authenticated;
   NOTIFY pgrst, 'reload schema';
   ============================================================================ */
