-- 20260823053000_harden_subscription_payment_and_plans.sql
-- Workstream W3 & W7: Payment integrity, race condition elimination, and plan normalization
--
-- 1. Adds plan_key column to public.guilds and backfills legacy rows.
-- 2. Hardens public.gm_apply_subscription_payment with row-level locking (FOR UPDATE)
--    and sets subscription_type = 'Premium' while recording plan_key.
-- 3. Revokes all execution rights from public, anon, authenticated (service_role only).

-- 1. Ensure plan_key column exists on public.guilds
ALTER TABLE public.guilds ADD COLUMN IF NOT EXISTS plan_key text;

-- 2. Backfill any existing guilds whose subscription_type was stored as plan_key ('1m', '3m', '12m')
UPDATE public.guilds
SET plan_key = subscription_type,
    subscription_type = 'Premium'
WHERE subscription_type IN ('1m', '3m', '12m');

-- 3. Replace gm_apply_subscription_payment with concurrency-safe locking and proper plan handling
CREATE OR REPLACE FUNCTION public.gm_apply_subscription_payment(
    p_order_id text,
    p_token text DEFAULT NULL,
    p_provider text DEFAULT 'stripe',
    p_ext_ref text DEFAULT NULL
)
RETURNS TABLE(ok boolean, guild_id text, plan_key text, days_added integer, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_payment record;
    v_new_end timestamptz;
BEGIN
    -- Atomic row-level lock to prevent concurrent execution races
    SELECT * INTO v_payment
    FROM public.gm_payments
    WHERE (order_id = p_order_id OR token = p_token OR merchant_order_ext_ref = p_ext_ref)
    LIMIT 1
    FOR UPDATE;

    IF v_payment.id IS NULL THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::int, 'payment_not_found'::text;
        RETURN;
    END IF;

    -- Idempotent return if already completed
    IF v_payment.status = 'completed' THEN
        RETURN QUERY SELECT true, v_payment.guild_id, v_payment.plan_key, v_payment.days_added, NULL::text;
        RETURN;
    END IF;

    -- Calculate new subscription end date
    v_new_end := GREATEST(now(), COALESCE((SELECT subscription_end FROM public.guilds WHERE id = v_payment.guild_id), now()))
                 + (v_payment.days_added || ' days')::interval;

    -- Set subscription_type to 'Premium' (enables is_subscription_active) and store plan_key
    UPDATE public.guilds
    SET subscription_type = 'Premium',
        plan_key = v_payment.plan_key,
        subscription_end = v_new_end,
        updated_at = now()
    WHERE id = v_payment.guild_id;

    -- Mark payment record completed
    UPDATE public.gm_payments
    SET status = 'completed',
        applied_at = now(),
        updated_at = now()
    WHERE id = v_payment.id;

    RETURN QUERY SELECT true, v_payment.guild_id, v_payment.plan_key, v_payment.days_added, NULL::text;
END;
$$;

-- 4. Strict grants hygiene: service_role only (invoked by Stripe webhook and order status functions)
REVOKE ALL ON FUNCTION public.gm_apply_subscription_payment(text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_apply_subscription_payment(text, text, text, text) TO service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
-- In case of emergency rollback:
GRANT EXECUTE ON FUNCTION public.gm_apply_subscription_payment(text, text, text, text) TO authenticated, service_role;
*/
