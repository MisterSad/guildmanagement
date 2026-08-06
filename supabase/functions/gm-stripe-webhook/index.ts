// gm-stripe-webhook — receives Stripe payment webhooks.
//
// Source of truth for payments: on checkout.session.completed the subscription
// is extended (atomically, idempotently, via gm_apply_subscription_payment).
//
// Security: the endpoint is intentionally public (Stripe calls it without a
// JWT). Every request is verified against the STRIPE_WEBHOOK_SIGNING_SECRET
// (HMAC-SHA256 over `{timestamp}.{raw body}`, from the Stripe-Signature
// header). Stripe retries failed deliveries, so unknown sessions return 500.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { stripeWebhookSecret, verifyWebhookSignature } from "../_shared/stripe.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature") ?? "";

  if (!stripeWebhookSecret()) {
    console.error("[gm-stripe-webhook] STRIPE_WEBHOOK_SIGNING_SECRET is not configured");
    return new Response("not_configured", { status: 500 });
  }
  const valid = await verifyWebhookSignature(rawBody, signature);
  if (!valid) {
    console.error("[gm-stripe-webhook] invalid signature");
    return new Response("invalid_signature", { status: 401 });
  }

  let payload: {
    type?: string;
    data?: { object?: { id?: string; payment_status?: string } };
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad_payload", { status: 400 });
  }

  const event = (payload?.type ?? "").toString();
  const obj = payload?.data?.object ?? {};
  const sessionId = (obj.id ?? "").toString();
  const paymentStatus = (obj.payment_status ?? "").toString().toLowerCase();
  if (!sessionId) return new Response("missing_session_id", { status: 400 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Apply the subscription only when the payment has settled:
  //   - checkout.session.completed with payment_status 'paid'  → immediate methods
  //   - checkout.session.async_payment_succeeded               → async methods
  //     (PayPal, SEPA, iDEAL, ...). 'completed' alone means "checkout
  //     finished", not "funds captured" — applying there would grant paid
  //     access before the payment settles.
  const applyPayment =
    (event === "checkout.session.completed" && paymentStatus === "paid") ||
    event === "checkout.session.async_payment_succeeded";

  if (!applyPayment) {
    return new Response("ok"); // not a settled-payment event
  }

  // Correlate with our pending payment row.
  const { data: pay } = await admin
    .from("gm_payments")
    .select("order_id")
    .eq("order_id", sessionId)
    .maybeSingle();
  if (!pay || !pay.order_id) {
    console.error("[gm-stripe-webhook] unknown settled session", sessionId);
    return new Response("unknown_session", { status: 500 }); // force Stripe to retry
  }

  const { error } = await admin.rpc("gm_apply_subscription_payment", {
    p_order_id: pay.order_id,
  });
  if (error) {
    console.error("[gm-stripe-webhook] apply failed", error);
    return new Response("apply_failed", { status: 500 });
  }
  return new Response("ok");
});
