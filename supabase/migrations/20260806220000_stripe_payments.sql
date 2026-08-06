-- 20260806220000_stripe_payments.sql
-- Migrate the payment module from the legacy merchant to Stripe Checkout.
--
--   gm_payments rows now reference a Stripe Checkout Session id instead of a
--   legacy order id. The schema is already generic (order_id/token/ext_ref),
--   so no structural change is required. We only record the provider name for
--   audit clarity so future rows can be distinguished if a provider changes.

BEGIN;

ALTER TABLE public.gm_payments
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'stripe';

-- The RPC is unchanged and provider-agnostic: it transitions a payment row
-- from 'pending' to 'completed' exactly once (CAS) and extends the guild
-- subscription from max(now, current end). Stripe sessions map to order_id.

COMMIT;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
