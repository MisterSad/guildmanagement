-- 20260824000000_free_app_and_donations.sql
-- Free App Transition & Voluntary Donations (Buy Me a Coffee) v127.0
--
-- 1. Neutralizes is_subscription_active to always return true (app is 100% free).
-- 2. Normalizes all guild records to Unlimited subscription_type.
-- 3. Ensures updated_at column exists on public.guilds for canonical replay fidelity.
-- 4. Adds kind column to public.gm_payments to distinguish subscriptions from donations.
-- 5. Implements public.gm_apply_donation RPC (service_role only) for one-time donations.

-- 1. Neutralize the subscription gate across all 36 RLS clauses and 3 RPC gates
CREATE OR REPLACE FUNCTION public.is_subscription_active(p_guild text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    -- The platform is free since v127.0: all features are open to every tenant.
    -- Donations (Buy Me a Coffee) are voluntary and never gate access.
    SELECT true;
$$;
REVOKE ALL ON FUNCTION public.is_subscription_active(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_subscription_active(text) TO authenticated, service_role;

-- 2. Normalize all guild states to Unlimited
UPDATE public.guilds
SET subscription_type = 'Unlimited',
    subscription_end = NULL,
    plan_key = NULL;

-- 3. Canonical replay fix: ensure updated_at column exists on public.guilds
ALTER TABLE public.guilds ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 4. Donations bookkeeping: kind discriminator on gm_payments
ALTER TABLE public.gm_payments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'subscription';
UPDATE public.gm_payments SET kind = 'donation' WHERE plan_key LIKE 'donation%';

-- 5. Dedicated RPC for applying voluntary donations (idempotent, concurrency-safe, never writes to guilds)
CREATE OR REPLACE FUNCTION public.gm_apply_donation(
    p_order_id text
)
RETURNS TABLE(ok boolean, payment_id text, amount_cents integer, guild_id text, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_payment record;
BEGIN
    -- Atomic row-level lock to prevent concurrent execution races
    SELECT * INTO v_payment
    FROM public.gm_payments
    WHERE order_id = p_order_id
    LIMIT 1
    FOR UPDATE;

    IF v_payment.id IS NULL THEN
        RETURN QUERY SELECT false, NULL::text, NULL::int, NULL::text, 'payment_not_found'::text;
        RETURN;
    END IF;

    -- Idempotent return if already completed
    IF v_payment.status = 'completed' THEN
        RETURN QUERY SELECT true, v_payment.order_id, v_payment.amount_cents, v_payment.guild_id, NULL::text;
        RETURN;
    END IF;

    -- Mark payment record completed (guilds table is untouched for donations)
    UPDATE public.gm_payments
    SET status = 'completed',
        applied_at = now(),
        updated_at = now()
    WHERE id = v_payment.id;

    RETURN QUERY SELECT true, v_payment.order_id, v_payment.amount_cents, v_payment.guild_id, NULL::text;
END;
$$;

-- Strict grants hygiene: service_role only
REVOKE ALL ON FUNCTION public.gm_apply_donation(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_apply_donation(text) TO service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

/*
-- ROLLBACK SQL:
-- Drop gm_apply_donation
DROP FUNCTION IF EXISTS public.gm_apply_donation(text);

-- Revert is_subscription_active to legacy check
CREATE OR REPLACE FUNCTION public.is_subscription_active(p_guild text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_sub_type text;
    v_sub_end timestamptz;
BEGIN
    SELECT subscription_type, subscription_end INTO v_sub_type, v_sub_end
    FROM public.guilds
    WHERE id = p_guild;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    IF v_sub_type = 'Unlimited' OR v_sub_type = 'Lifetime' THEN
        RETURN true;
    END IF;

    IF v_sub_type = 'Premium' THEN
        IF v_sub_end IS NULL THEN
            RETURN false;
        END IF;
        RETURN v_sub_end > now();
    END IF;

    RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.is_subscription_active(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_subscription_active(text) TO authenticated, service_role;

ALTER TABLE public.gm_payments DROP COLUMN IF EXISTS kind;
*/
