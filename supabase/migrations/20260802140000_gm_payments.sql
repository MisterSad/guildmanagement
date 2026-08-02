-- 20260802140000_gm_payments.sql
-- Self-service subscriptions (Revolut payments).
--
--   gm_payments : one row per Revolut order — audit trail + idempotency key.
--   Created by the gm-create-order edge function when a checkout starts,
--   then confirmed by gm-revolut-webhook (source of truth) and by
--   gm-order-status (client-side polling after the widget succeeds).
--
--   gm_apply_subscription_payment : atomic, idempotent application of a
--   completed payment to the guild subscription:
--     - time plans: new_end = max(now, current end) + days  (stacking)
--     - lifetime  : subscription_type -> 'Lifetime' (never expires)
--   Concurrency-safe: only one caller can transition a payment row from
--   'pending' to 'completed' (CAS), so retries / duplicate webhooks can
--   never extend the subscription twice.

BEGIN;

CREATE TABLE IF NOT EXISTS public.gm_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id text UNIQUE,               -- Revolut internal order id (from API)
    token text UNIQUE,                  -- Revolut public order token (client-side id)
    merchant_order_ext_ref text UNIQUE, -- our correlation ref (gm_<uuid>)
    guild_id text NOT NULL,
    plan_key text NOT NULL,             -- '1m' | '3m' | '6m' | 'lifetime'
    amount_cents integer NOT NULL,
    currency text NOT NULL DEFAULT 'EUR',
    days_added integer,                 -- NULL for lifetime
    status text NOT NULL DEFAULT 'pending',  -- pending | completed | failed | declined
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz              -- when the extension was applied
);

CREATE INDEX IF NOT EXISTS gm_payments_guild_idx ON public.gm_payments (guild_id);
CREATE INDEX IF NOT EXISTS gm_payments_status_idx ON public.gm_payments (status);

ALTER TABLE public.gm_payments ENABLE ROW LEVEL SECURITY;
-- No policies: rows are written only through edge functions (service_role).

-- ── Atomic, idempotent subscription application ────────────────────────────
CREATE OR REPLACE FUNCTION public.gm_apply_subscription_payment(p_order_id text)
 RETURNS TABLE(applied boolean, lifetime boolean, new_end timestamptz, plan_key text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_pay public.gm_payments%ROWTYPE;
    v_rc integer;
    v_sub_type text;
    v_sub_end timestamptz;
    v_base timestamptz;
    v_new_end timestamptz;
BEGIN
    SELECT * INTO v_pay FROM public.gm_payments WHERE order_id = p_order_id;
    IF v_pay.id IS NULL THEN
        RETURN; -- unknown order: caller decides (webhook returns 500 to trigger retry)
    END IF;

    -- CAS: only one caller may transition pending -> completed.
    UPDATE public.gm_payments
       SET status = 'completed', applied_at = now(), updated_at = now()
     WHERE id = v_pay.id AND status = 'pending';
    GET DIAGNOSTICS v_rc = ROW_COUNT;

    IF v_rc = 0 THEN
        -- Already handled — re-read the final state and return it.
        SELECT status, applied_at INTO v_pay.status, v_pay.applied_at
          FROM public.gm_payments WHERE id = v_pay.id;
        IF v_pay.status = 'completed' THEN
            IF v_pay.plan_key = 'lifetime' THEN
                RETURN QUERY SELECT false, true, NULL::timestamptz, v_pay.plan_key;
            ELSE
                SELECT subscription_end INTO v_new_end
                  FROM public.guilds WHERE id = v_pay.guild_id;
                RETURN QUERY SELECT false, false, v_new_end, v_pay.plan_key;
            END IF;
        END IF;
        RETURN QUERY SELECT false, false, NULL::timestamptz, v_pay.plan_key;
        RETURN;
    END IF;

    -- First application: extend the guild subscription.
    SELECT subscription_type, subscription_end INTO v_sub_type, v_sub_end
      FROM public.guilds WHERE id = v_pay.guild_id;

    IF v_pay.plan_key = 'lifetime' THEN
        UPDATE public.guilds
           SET subscription_type = 'Lifetime', subscription_end = NULL
         WHERE id = v_pay.guild_id;
        RETURN QUERY SELECT true, true, NULL::timestamptz, v_pay.plan_key;
        RETURN;
    END IF;

    v_base := now();
    IF v_sub_type = 'Premium' AND v_sub_end IS NOT NULL AND v_sub_end > now() THEN
        v_base := v_sub_end; -- stacking: extend from the current expiry
    END IF;
    v_new_end := v_base + make_interval(days => v_pay.days_added);
    UPDATE public.guilds
       SET subscription_type = 'Premium', subscription_end = v_new_end
     WHERE id = v_pay.guild_id;

    RETURN QUERY SELECT true, false, v_new_end, v_pay.plan_key;
END;
$fn$;

REVOKE ALL ON FUNCTION public.gm_apply_subscription_payment(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_apply_subscription_payment(text) TO service_role;

COMMIT;
