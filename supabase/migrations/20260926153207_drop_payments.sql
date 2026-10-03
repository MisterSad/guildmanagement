-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1 — Remove payments entirely (the platform is free, permanently)
--
-- Owner decision (2026-09-26): no subscriptions, no donations, no payment
-- surface of any kind. Confirmed by the owner that no payment was ever
-- collected, and by the data: all 22 `gm_payments` rows are `pending`, none
-- `paid`, so there is nothing to retain for accounting.
--
-- What this drops:
--   * gm_apply_subscription_payment(text,text,text,text) — webhook applier
--   * gm_apply_donation(text)                           — donation applier
--   * gm_payments                                       — 22 pending rows
--   * guilds.subscription_type / subscription_end / plan_key /
--     payments_disabled, and the two CHECK constraints over them
--
-- What this deliberately KEEPS:
--   * is_subscription_active(text) — already neutralised to `SELECT true`, but
--     invoked by ~36 RLS clauses. Removing it means rewriting every write
--     policy, which is its own lot (Phase 4), not a payment-removal side
--     effect.
--   * gm_delete_guild / server_number — the super-admin guild tab is live.
--
-- Deployed Edge Functions deleted alongside this migration (platform-side):
--   gm-create-order, gm-order-status, gm-stripe-webhook, and gm-revolut-webhook
--   (which was ACTIVE and public with no source in this repository).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Repair gm_reset_demo_tenant_data BEFORE dropping the columns ────────
--
-- The nightly 03:00 cron seeds the DEMO tenant and its Step 2 writes three of
-- the columns dropped below. This is the same failure mode as the Web Push
-- removal (see 20260926120100 / 20260926120200): a column drop that silently
-- breaks a cron job whose next failure is invisible until someone notices DEMO
-- has gone stale. Rewriting the live definition in place — rather than
-- re-embedding 300 lines of seed data that would immediately drift — keeps the
-- rest of the function byte-identical.
DO $repair$
DECLARE
    v_def  text;
    v_new  text;
    v_old_block CONSTANT text :=
$old$    -- Step 2: Ensure DEMO guild entry exists with unlimited subscription and donations ENABLED
    INSERT INTO public.guilds (id, server_number, subscription_type, subscription_end, payments_disabled, created_at)
    VALUES ('DEMO', '0000', 'Unlimited', NULL, false, now())
    ON CONFLICT (id) DO UPDATE SET
        server_number = EXCLUDED.server_number,
        subscription_type = EXCLUDED.subscription_type,
        payments_disabled = false;$old$;
    v_new_block CONSTANT text :=
$new$    -- Step 2: Ensure the DEMO guild row exists (the platform is free; the
    -- subscription and payment columns were dropped in 20260926180000).
    INSERT INTO public.guilds (id, server_number, created_at)
    VALUES ('DEMO', '0000', now())
    ON CONFLICT (id) DO UPDATE SET
        server_number = EXCLUDED.server_number;$new$;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_reset_demo_tenant_data';

    IF v_def IS NULL THEN
        RAISE EXCEPTION 'gm_reset_demo_tenant_data is missing; refusing to drop columns it may write';
    END IF;

    -- Pre-condition: the block we are about to rewrite must be present verbatim.
    -- If the live function has drifted, fail loudly rather than leave the cron
    -- referencing dropped columns.
    IF position(v_old_block IN v_def) = 0 THEN
        RAISE EXCEPTION 'gm_reset_demo_tenant_data Step 2 does not match the expected text; repair it by hand before dropping the guilds payment columns';
    END IF;

    v_new := replace(v_def, v_old_block, v_new_block);
    EXECUTE v_new;

    -- Post-condition: assert on EVERY dropped name, not just one. The push
    -- removal shipped a repair that passed its own guard while still leaving a
    -- second reference behind (20260926120200).
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_reset_demo_tenant_data';

    IF v_def ~* '(subscription_type|subscription_end|payments_disabled|plan_key|gm_payments)' THEN
        RAISE EXCEPTION 'gm_reset_demo_tenant_data still references a dropped payment object';
    END IF;
END
$repair$;

-- ── 2. Payment RPCs ───────────────────────────────────────────────────────
-- Both were already revoked from anon and authenticated (only the deleted
-- webhooks called them with the service role).
DROP FUNCTION IF EXISTS public.gm_apply_subscription_payment(text, text, text, text);
DROP FUNCTION IF EXISTS public.gm_apply_donation(text);

-- ── 3. Payment ledger ─────────────────────────────────────────────────────
-- No foreign key points at this table (verified), so no cascade is needed.
DROP TABLE IF EXISTS public.gm_payments;

-- ── 4. Subscription columns on guilds ─────────────────────────────────────
-- The constraints must go first: `check_subscription_end_premium` spans both
-- subscription columns. Note that `guilds_subscription_type_check` only ever
-- allowed 'Unlimited' or 'Premium' while the admin UI offered a third
-- 'Lifetime' option — choosing it made the save fail. Both disappear here.
ALTER TABLE public.guilds
    DROP CONSTRAINT IF EXISTS check_subscription_end_premium,
    DROP CONSTRAINT IF EXISTS guilds_subscription_type_check;

ALTER TABLE public.guilds
    DROP COLUMN IF EXISTS subscription_type,
    DROP COLUMN IF EXISTS subscription_end,
    DROP COLUMN IF EXISTS plan_key,
    DROP COLUMN IF EXISTS payments_disabled;

COMMENT ON TABLE public.guilds IS
    'Tenant registry. One row per guild. `server_number` is the game server the guild plays on and gates cross-server transfers. The platform is free: no subscription, plan or payment state is stored (Phase 1, 20260926180000).';

-- ── 5. Final assertions ───────────────────────────────────────────────────
DO $verify$
DECLARE
    v_n int;
BEGIN
    SELECT count(*) INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'gm_payments';
    IF v_n <> 0 THEN RAISE EXCEPTION 'gm_payments survived the drop'; END IF;

    SELECT count(*) INTO v_n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'guilds'
      AND column_name IN ('subscription_type', 'subscription_end', 'plan_key', 'payments_disabled');
    IF v_n <> 0 THEN RAISE EXCEPTION 'guilds still carries % payment column(s)', v_n; END IF;

    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('gm_apply_subscription_payment', 'gm_apply_donation');
    IF v_n <> 0 THEN RAISE EXCEPTION 'a payment RPC survived the drop'; END IF;

    -- Nothing else in the schema may reference a dropped object.
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) ~* '(gm_payments|subscription_type|subscription_end|plan_key|payments_disabled)';
    IF v_n <> 0 THEN RAISE EXCEPTION '% function(s) still reference a dropped payment object', v_n; END IF;
END
$verify$;

-- PostgREST caches the schema: without this it would keep advertising the
-- dropped table and columns until the next restart.
NOTIFY pgrst, 'reload schema';
