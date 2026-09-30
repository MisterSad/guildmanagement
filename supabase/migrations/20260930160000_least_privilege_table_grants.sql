-- Grants, not just policies (AGENTS.md security rule 2; finding C0).
--
-- Measured on 2026-09-30 through information_schema.table_privileges:
--   * `anon` held Supabase's default ALL -- SELECT, INSERT, UPDATE, DELETE and
--     TRUNCATE, TRIGGER, REFERENCES -- on 25 of 40 public tables. No RLS policy
--     anywhere names `anon`, so every one of those grants was dead weight held
--     back by RLS alone. TRUNCATE is not subject to RLS at all.
--   * `authenticated` held TRUNCATE (and TRIGGER, REFERENCES) on 31 tables, and
--     ALL on 8 tables that have no policy whatsoever: account_backup_codes,
--     account_passkeys, discord_account_links, discord_link_codes,
--     guild_creation_requests, login_throttle, tickets, webauthn_challenges.
--     The browser reads none of them; the Edge Functions use the service role.
--   * Six tables carried INSERT/UPDATE/DELETE policies for `authenticated` that
--     no client uses, because every write goes through a SECURITY DEFINER RPC:
--     event_chest_tiers, event_daily_scores, player_metrics_history,
--     war_opponents, war_sessions, weekly_scores. That is the shape of the
--     transfer bypass fixed in 20260930140000 -- an RPC that validates, and a
--     direct write path beside it that does not (e.g. event_daily_scores
--     written without the chest-tier derivation). They keep SELECT.
--
-- What `authenticated` keeps, table by table, is exactly the commands a policy
-- allows AND the browser (src/) actually issues, checked by scanning every
-- `.from('<table>')` call. Column-level grants (accounts) are left alone, as is
-- guild_transfers (20260930140000).
--
-- Unaffected: SECURITY DEFINER functions run as their owner; the Edge Functions
-- and the Discord worker use the service role; pg_cron runs as postgres. Nothing
-- in public was SECURITY INVOKER over these tables (checked with pg_proc).
--
-- Default privileges: tables created by later migrations (owner `postgres`)
-- were born with ALL for `anon`, which is how the 25 accumulated. `anon` gets
-- nothing by default any more, and `authenticated` no TRUNCATE/TRIGGER/
-- REFERENCES. (supabase_admin's own defaults cannot be altered from here, and
-- no migration creates tables as that role.)

-- Pre-condition: nothing below may cut off a path an `anon` policy relies on.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND (p.polroles @> ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'anon')]
               OR p.polroles @> ARRAY[0::oid])
    ) THEN
        RAISE EXCEPTION 'least_privilege_grants: a policy grants anon or PUBLIC; review it before revoking anon';
    END IF;
END $$;

-- 1. anon: nothing, anywhere in public.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- 2. authenticated: never TRUNCATE / TRIGGER / REFERENCES.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated;

-- 3. authenticated: no access to tables that have no policy and no browser caller.
REVOKE ALL ON public.account_backup_codes     FROM authenticated;
REVOKE ALL ON public.account_passkeys         FROM authenticated;
REVOKE ALL ON public.discord_account_links    FROM authenticated;
REVOKE ALL ON public.discord_link_codes       FROM authenticated;
REVOKE ALL ON public.guild_creation_requests  FROM authenticated;
REVOKE ALL ON public.login_throttle           FROM authenticated;
REVOKE ALL ON public.tickets                  FROM authenticated;
REVOKE ALL ON public.webauthn_challenges      FROM authenticated;

-- 4. authenticated: read-only where only a read policy exists.
REVOKE INSERT, UPDATE, DELETE ON public.ocr_cache         FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.player_absences   FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.system_audit_logs FROM authenticated;
-- Comments: read, post, delete own -- never edited in place.
REVOKE UPDATE ON public.migration_wiki_comments FROM authenticated;

-- 5. authenticated: RPC-only tables lose the direct write path.
REVOKE INSERT, UPDATE, DELETE ON public.event_chest_tiers      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.event_daily_scores     FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.player_metrics_history FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.war_opponents          FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.war_sessions           FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.weekly_scores          FROM authenticated;

-- 6. Future tables and sequences created by migrations (owner postgres).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLES FROM authenticated;

NOTIFY pgrst, 'reload schema';
