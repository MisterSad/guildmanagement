-- 20260926140000_drop_dead_rpcs_and_diplomacy.sql
-- Cleanup phase, lot A: remove the database surface of features that were
-- removed from the product, plus legacy RPCs superseded by a `gm_*` twin.
--
-- HOW THE SCOPE WAS ESTABLISHED (not from a guess):
-- every function in `public` was cross-referenced against four kinds of
-- in-database dependency -- RLS policies (`pg_policies.qual` / `with_check`),
-- other function bodies (`pg_get_functiondef`), `cron.job.command`, and
-- `pg_trigger.tgfoid` -- and then against callers in `src/`,
-- `supabase/functions/` and `index.html`. Only objects with zero of both are
-- dropped here.
--
-- That check overturned two assumptions:
--   * `transfer_guild_member` and `request_guild_transfer` were believed to be
--     dead "legacy duplicates". They are LIVE: the client calls the legacy
--     `transfer_guild_member` (members.controller.ts:722) and `member-portal`
--     calls `request_guild_transfer` (index.ts:684). Both are left alone.
--   * `gm_list_event_sessions` appeared to depend on `list_event_sessions`.
--     It does not -- the only match is inside its own CREATE header, a substring
--     artefact.
--
-- Also verified: the codebase contains no dynamic `.rpc(<variable>)` call, every
-- RPC name is a string literal, so a grep for callers is conclusive.

-- ============================================================================
-- 1. Web Push leftover missed by the removal migration
-- ============================================================================
-- Returned the push configuration (VAPID public key) to the client. The client
-- side went with the PWA and nothing calls it.

DROP FUNCTION IF EXISTS public.get_push_config();

-- ============================================================================
-- 2. Diplomacy: never had a UI, and the table is empty
-- ============================================================================
-- `diplomatic_treaties` survived the Leader Hall purge only because its RLS
-- policy depended on `gm_is_leader_caller()` -- which is precisely why that
-- helper was deliberately kept back then. Verified now:
--   * 0 rows;
--   * exactly 1 policy (`diplomatic_treaties_select`), and it is the only policy
--     in the whole schema referencing `gm_is_leader_caller()`;
--   * no incoming foreign keys;
--   * no caller for any of the three treaty RPCs anywhere in the codebase.
-- Dropping the table takes its policy with it, which finally frees the helper.

DROP FUNCTION IF EXISTS public.gm_create_diplomatic_treaty(text, text, text, text, integer);
DROP FUNCTION IF EXISTS public.gm_sign_diplomatic_treaty(uuid);
DROP FUNCTION IF EXISTS public.gm_revoke_diplomatic_treaty(uuid);

DROP TABLE IF EXISTS public.diplomatic_treaties;

-- Now unreferenced: the last Leader Hall residue in the schema.
DROP FUNCTION IF EXISTS public.gm_is_leader_caller();

-- ============================================================================
-- 3. Draft Mercato / SvS / GvG matchup: the whole Settings tab was removed
-- ============================================================================
-- `svs-matchup.js`, `gvg-matchup.js`, `cross-rank.js` and `#tab-settings` no
-- longer exist. These four RPCs were their backend and have stayed callable by
-- every authenticated user ever since.

DROP FUNCTION IF EXISTS public.gm_cross_guild_ranking();
DROP FUNCTION IF EXISTS public.gm_gvg_guild_matchup();
DROP FUNCTION IF EXISTS public.gm_gvg_player_matchup();
DROP FUNCTION IF EXISTS public.gm_svs_server_matchup();

-- ============================================================================
-- 4. Legacy RPCs superseded by a gm_* twin
-- ============================================================================
-- `gm_list_event_sessions` is the one the client calls (HistoryView.ts:143).

DROP FUNCTION IF EXISTS public.list_event_sessions(text);
DROP FUNCTION IF EXISTS public.list_event_weeks(text);

-- ============================================================================
-- 5. Trigger and maintenance functions must not be callable over HTTP
-- ============================================================================
-- Postgres grants EXECUTE to PUBLIC by default, and both `anon` and
-- `authenticated` are members of PUBLIC, so revoking from the roles alone would
-- leave the grant in place.
--
-- Trigger functions are invoked by the trigger machinery, which runs as the
-- table owner and never consults these grants. Exposing them at
-- `/rest/v1/rpc/<name>` is pure attack surface, and `gm_protect_r5_role_change`
-- is itself a privilege-protection guard.

REVOKE EXECUTE ON FUNCTION public.gm_protect_r5_role_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_duplicate_member_uid() FROM PUBLIC, anon, authenticated;

-- Maintenance function driven by the `daily-cleanup-stale-locks` pg_cron job,
-- which runs as `postgres`. Its body is an unconditional DELETE on guild_config
-- with no authorization check of its own, so the grant was the only gate.

REVOKE EXECUTE ON FUNCTION public.gm_cleanup_stale_reminder_locks() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

/* ============================================================================
   IRREVERSIBLE for `diplomatic_treaties` (table dropped), though it held 0 rows
   so no data is lost. The dropped functions could be restored from
   20260812000003_functions_and_rpcs.sql and the Leader Hall / matchup
   migrations, but restoring them would also mean rebuilding the UI that was
   deleted -- treat this as a one-way door.

   The REVOKEs in section 5 are reversible:
     GRANT EXECUTE ON FUNCTION public.gm_protect_r5_role_change() TO authenticated;
     GRANT EXECUTE ON FUNCTION public.prevent_duplicate_member_uid() TO authenticated;
     GRANT EXECUTE ON FUNCTION public.gm_cleanup_stale_reminder_locks() TO authenticated;
   ...though nothing legitimate calls them over HTTP.

   POST-DROP CHECK (the Web Push removal taught this the hard way): PL/pgSQL
   resolves table and function references at EXECUTION time, so a DROP can leave
   other functions broken without any error. After applying, re-scan:
     SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND pg_get_functiondef(p.oid) ~* 'diplomatic_treaties|gm_is_leader_caller'
             '|matchup|cross_guild_ranking|get_push_config|list_event_weeks';
   ============================================================================ */
