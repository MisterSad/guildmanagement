-- 20260926120100_repair_push_table_dependents.sql
-- Fallout repair for 20260926120000_drop_web_push.sql.
--
-- PL/pgSQL resolves table references at EXECUTION time, not at CREATE time, so
-- dropping `push_subscriptions` / `player_push_prefs` succeeded silently while
-- leaving two functions that reference them broken. Found by querying
-- `pg_get_functiondef` across every function in `public` after the drop -- not
-- visible from the migration chain alone.
--
--   1. public.gm_reset_demo_tenant_data()  -- LIVE, and on a nightly cron
--   2. public.gm_guild_benchmark()         -- dead, zero callers

-- ============================================================================
-- 1. gm_reset_demo_tenant_data -- MUST be repaired, it runs every night
-- ============================================================================
-- Scheduled as pg_cron job `daily-demo-tenant-reset` at 03:00 UTC (owner
-- `postgres`). Its body contained:
--     DELETE FROM public.player_push_prefs WHERE guild = 'DEMO';
-- With the table gone the whole function now raises, so the public DEMO tenant
-- would silently stop being reset -- the demo would drift and accumulate
-- whatever visitors left behind.
--
-- The function is several hundred lines of seed data, so rather than restating
-- it (and risking a transcription error in a body nobody would proofread), this
-- reads the live definition, removes exactly that one statement, and re-applies
-- it. Both the "found it" and the "reference is gone" conditions are asserted,
-- so this fails loudly instead of silently no-op'ing -- including on a clean
-- replay, where it rewrites whichever earlier definition is current at this
-- point in the chain.

DO $repair$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     AND p.proname = 'gm_reset_demo_tenant_data';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'gm_reset_demo_tenant_data() not found: cannot repair';
  END IF;

  IF v_def NOT LIKE '%player_push_prefs%' THEN
    -- Already clean (re-run, or a later migration got there first).
    RAISE NOTICE 'gm_reset_demo_tenant_data() has no player_push_prefs reference; nothing to repair';
    RETURN;
  END IF;

  v_def := regexp_replace(
    v_def,
    '[ \t]*DELETE[ \t]+FROM[ \t]+public\.player_push_prefs[^;]*;[ \t]*\r?\n?',
    '',
    'gi'
  );

  IF v_def LIKE '%player_push_prefs%' THEN
    RAISE EXCEPTION
      'Refusing to re-create gm_reset_demo_tenant_data(): a player_push_prefs reference survived the rewrite';
  END IF;

  EXECUTE v_def;
  RAISE NOTICE 'gm_reset_demo_tenant_data() re-created without the player_push_prefs DELETE';
END
$repair$;

-- ============================================================================
-- 2. gm_guild_benchmark -- dropped, not repaired
-- ============================================================================
-- A super_admin-only cross-guild benchmark whose result set included a
-- `push_subs integer` column fed by `SELECT ... FROM public.push_subscriptions`.
--
-- It has ZERO callers: no `src/`, no Edge Function, no test references
-- `gm_guild_benchmark`. (The Portal's "Guild Benchmarks" tiles are unrelated --
-- they are computed client-side by `getGuildAverages`.) It is one of the dead
-- RPCs left behind by the removed Settings / matchup tab, alongside
-- `gm_cross_guild_ranking`, `gm_gvg_guild_matchup` and `gm_svs_server_matchup`,
-- which the cleanup phase removes as a group.
--
-- Repairing a function nobody calls would be waste, and leaving it broken would
-- leave a landmine for whoever calls it next, so it goes now.

DROP FUNCTION IF EXISTS public.gm_guild_benchmark();

NOTIFY pgrst, 'reload schema';

/* ============================================================================
   ROLLBACK: gm_guild_benchmark() would have to be restored from
   20260812000003_functions_and_rpcs.sql (or a later redefinition) minus its
   `push` CTE and the `push_subs` result column, since push_subscriptions no
   longer exists. gm_reset_demo_tenant_data() needs no rollback -- removing a
   DELETE against a dropped table cannot be undone meaningfully.
   ============================================================================ */
