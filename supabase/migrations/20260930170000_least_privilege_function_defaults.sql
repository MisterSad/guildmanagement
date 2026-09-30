-- New functions are no longer executable by `anon` (or PUBLIC) by default.
--
-- Every function created by a migration used to be born executable by
-- everyone: PostgreSQL grants EXECUTE to PUBLIC on every new function (a
-- global default), and Supabase's schema default adds anon and authenticated.
-- Each migration therefore had to end with its own
-- `REVOKE ... FROM PUBLIC, anon` -- and forgetting it once on a SECURITY
-- DEFINER function publishes it at /rest/v1/rpc/<name> to anyone holding the
-- publishable key. Companion of 20260930160000, which did the same for tables.
--
-- Measured on 2026-09-30: of 108 public functions, exactly two are executable
-- by anon today:
--   * gm_report_client_error -- DELIBERATELY anonymous (ADR-011, crash reports
--     before sign-in; rate limited by 20260926240000). Its explicit grant is
--     kept: nothing here touches existing grants except the next line.
--   * gm_event_scoring_key -- a pure SECURITY INVOKER helper reached only
--     through PUBLIC. No browser code calls it; it is revoked from PUBLIC and
--     anon and granted explicitly to the roles that run SQL.
--
-- Defaults after this migration, for functions created by `postgres`:
--   PUBLIC  -- nothing (global default revoked; per-schema cannot revoke it)
--   anon    -- nothing
--   authenticated, service_role -- EXECUTE, unchanged, so an RPC still works
--   without a grant; a service-only one must still REVOKE from authenticated.
-- A function meant for anonymous callers now needs an explicit
-- `GRANT EXECUTE ... TO anon`, which is the point.

REVOKE EXECUTE ON FUNCTION public.gm_event_scoring_key(text, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gm_event_scoring_key(text, text, date) TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

NOTIFY pgrst, 'reload schema';
