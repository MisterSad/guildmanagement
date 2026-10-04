-- The DEMO tenant is gone (20261004123020): anyone can create a guild now, so
-- the shared sandbox, its nightly rebuild and every exception for it went.
-- "DEMO" is an ordinary TAG from here on.
BEGIN;
SELECT tests.fixture();

SELECT tests.assert(NOT EXISTS (SELECT 1 FROM public.guilds WHERE id = 'DEMO'), 'no DEMO guild');
SELECT tests.assert(to_regprocedure('public.gm_reset_demo_tenant_data()') IS NULL, 'the nightly rebuild function is gone');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-demo-tenant-reset'), 'nothing rebuilds DEMO at night');
SELECT tests.assert(NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
                                 AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) LIKE '%''DEMO''%'),
                    'no function names the DEMO guild');

-- The TAG is free: a guild admin may take it like any other.
SELECT tests.login('t_admin_a');
SELECT tests.assert_eq(public.gm_rename_guild('TA', 'demo') ->> 'ok', 'true'::text, 'a guild may be renamed to DEMO');
SELECT tests.logout();
ROLLBACK;
