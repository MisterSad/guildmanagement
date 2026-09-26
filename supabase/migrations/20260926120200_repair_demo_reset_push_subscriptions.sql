-- 20260926120200_repair_demo_reset_push_subscriptions.sql
-- Completes 20260926120100, which was INCOMPLETE.
--
-- `gm_reset_demo_tenant_data()` deleted from BOTH dropped push tables:
--     DELETE FROM public.player_push_prefs   WHERE guild = 'DEMO';
--     DELETE FROM public.push_subscriptions  WHERE guild = 'DEMO';
--
-- 20260926120100 removed only the first. The diagnostic query that drove it used
-- `regexp_match`, which returns just the FIRST match per function, so the second
-- statement was never seen, and that migration's guard only asserted on
-- `player_push_prefs` -- so it passed while leaving the function still broken.
-- The nightly `daily-demo-tenant-reset` cron (03:00 UTC) would still have failed.
--
-- 20260926120100 is deliberately left as-is rather than rewritten: it already ran
-- against production, and editing an applied migration in place is exactly the
-- repo/database drift this audit is meant to remove.
--
-- This version strips DELETEs against EITHER table and asserts on BOTH names, so
-- it is idempotent and correct whether it runs after the partial repair or on a
-- clean replay.

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

  IF v_def NOT LIKE '%push_subscriptions%' AND v_def NOT LIKE '%player_push_prefs%' THEN
    RAISE NOTICE 'gm_reset_demo_tenant_data() already clean; nothing to repair';
    RETURN;
  END IF;

  -- One pattern, either table, however many occurrences.
  v_def := regexp_replace(
    v_def,
    '[ \t]*DELETE[ \t]+FROM[ \t]+public\.(?:push_subscriptions|player_push_prefs)[^;]*;[ \t]*\r?\n?',
    '',
    'gi'
  );

  IF v_def LIKE '%push_subscriptions%' OR v_def LIKE '%player_push_prefs%' THEN
    RAISE EXCEPTION
      'Refusing to re-create gm_reset_demo_tenant_data(): a reference to a dropped push table survived the rewrite';
  END IF;

  EXECUTE v_def;
  RAISE NOTICE 'gm_reset_demo_tenant_data() re-created with no reference to either dropped push table';
END
$repair$;

NOTIFY pgrst, 'reload schema';
