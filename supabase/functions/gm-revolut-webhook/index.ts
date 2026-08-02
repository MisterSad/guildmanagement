// gm-revolut-webhook — receives Revolut payment webhooks.
//
// Source of truth for payments: on ORDER_COMPLETED the subscription is
// extended (atomically, idempotently, via gm_apply_subscription_payment).
//
// Security: the endpoint is intentionally public (Revolut calls it without
// a JWT). Every request is verified against the REVOLUT_WEBHOOK_SIGNING_SECRET
// (HMAC-SHA256 over `v1.{timestamp}.{raw body}`). Revolut retries failed
// deliveries 3 times at 10-minute intervals, so unknown orders return 500.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { revolutSigningSecret, verifyWebhookSignature } from "../_shared/revolut.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  const rawBody = await req.text();
  const timestamp = req.headers.get("revolut-request-timestamp") ?? "";
  const signature = req.headers.get("revolut-signature") ?? "";

  if (!revolutSigningSecret()) {
    console.error("[gm-revolut-webhook] REVOLUT_WEBHOOK_SIGNING_SECRET is not configured");
    return new Response("not_configured", { status: 500 });
  }
  const valid = await verifyWebhookSignature(rawBody, timestamp, signature);
  if (!valid) {
    console.error("[gm-revolut-webhook] invalid signature");
    return new Response("invalid_signature", { status: 401 });
  }

  let payload: {
    event?: string;
    order_id?: string;
    merchant_order_ext_ref?: string;
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("bad_payload", { status: 400 });
  }

  const event = (payload.event ?? "").toString();
  const orderId = (payload.order_id ?? "").toString();
  const extRef = (payload.merchant_order_ext_ref ?? "").toString();
  if (!orderId) return new Response("missing_order_id", { status: 400 });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  if (event === "ORDER_COMPLETED") {
    // Correlate with our pending payment row (prefer order_id, fall back to ext ref).
    let pay: { order_id: string | null } | null = null;
    const byId = await admin.from("gm_payments").select("order_id").eq("order_id", orderId).maybeSingle();
    if (byId.data) {
      pay = byId.data;
    } else if (extRef) {
      const byRef = await admin.from("gm_payments").select("order_id").eq("merchant_order_ext_ref", extRef).maybeSingle();
      if (byRef.data) pay = byRef.data;
    }
    if (!pay || !pay.order_id) {
      console.error("[gm-revolut-webhook] unknown completed order", orderId);
      return new Response("unknown_order", { status: 500 }); // force Revolut to retry
    }

    const { error } = await admin.rpc("gm_apply_subscription_payment", {
      p_order_id: pay.order_id,
    });
    if (error) {
      console.error("[gm-revolut-webhook] apply failed", error);
      return new Response("apply_failed", { status: 500 });
    }
    return new Response("ok");
  }

  if (event === "ORDER_PAYMENT_DECLINED" || event === "ORDER_PAYMENT_FAILED" || event === "ORDER_FAILED") {
    const status = event === "ORDER_PAYMENT_DECLINED" ? "declined" : "failed";
    await admin
      .from("gm_payments")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("order_id", orderId);
    return new Response("ok");
  }

  return new Response("ok"); // other events (authorised, …) are irrelevant here
});
