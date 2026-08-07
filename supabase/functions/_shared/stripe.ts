// Shared Stripe helpers used by the payment edge functions.
//
// Checkout flow (redirect, no client SDK required):
//   1. gm-create-order creates a Checkout Session and records it in
//      gm_payments (status 'pending'). The client redirects to session.url.
//   2. After payment, Stripe redirects back to success_url with
//      ?checkout=success&session_id=...
//   3. gm-order-status polls the session (client-side confirmation).
//   4. gm-stripe-webhook (source of truth) applies the subscription
//      atomically via gm_apply_subscription_payment.
//
// Env vars (set as Supabase secrets):
//   STRIPE_SECRET_KEY            — server-side secret key (sk_live_...)
//   STRIPE_PUBLISHABLE_KEY       — publishable key (pk_live_...)
//   STRIPE_WEBHOOK_SIGNING_SECRET— whsec_... used to verify webhook signatures
//   STRIPE_ENV                   — 'test' | 'prod' (default: prod)

export const PLANS: Record<string, { label: string; days: number | null; cents: number }> = {
  "1m": { label: "1 Month", days: 30, cents: 799 },
  "3m": { label: "3 Months", days: 90, cents: 1999 },
  "6m": { label: "6 Months", days: 180, cents: 3499 },
  "12m": { label: "12 Months", days: 365, cents: 5999 },
};

export function stripeMode(): "test" | "prod" {
  return Deno.env.get("STRIPE_ENV") === "test" ? "test" : "prod";
}

export function stripeBaseUrl(): string {
  return "https://api.stripe.com";
}

export function stripeSecretKey(): string | undefined {
  return Deno.env.get("STRIPE_SECRET_KEY") || undefined;
}

export function stripePublishableKey(): string | undefined {
  return Deno.env.get("STRIPE_PUBLISHABLE_KEY") || undefined;
}

export function stripeWebhookSecret(): string | undefined {
  return Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET") || undefined;
}

// ── Create a Checkout Session (one-time payment, EUR) ──────────────────────
// Returns the session object (id, url, ...). Throws on non-2xx.
export async function createCheckoutSession(params: {
  extRef: string;
  guildId: string;
  planKey: string;
  plan: { label: string; cents: number };
  successUrl: string;
  cancelUrl: string;
}) {
  const { extRef, guildId, planKey, plan, successUrl, cancelUrl } = params;
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", "eur");
  body.set("line_items[0][price_data][unit_amount]", String(plan.cents));
  body.set("line_items[0][price_data][product_data][name]", plan.label);
  body.set("success_url", successUrl);
  body.set("cancel_url", cancelUrl);
  body.set("client_reference_id", extRef);
  body.set("metadata[guild_id]", guildId);
  body.set("metadata[plan_key]", planKey);

  const res = await fetch(`${stripeBaseUrl()}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${stripeSecretKey()}`,
    },
    body,
  });
  const jsonBody = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`stripe_checkout_failed:${res.status}`);
  return jsonBody;
}

// ── Fetch a Checkout Session by its id ─────────────────────────────────────
export async function fetchCheckoutSession(sessionId: string) {
  const res = await fetch(
    `${stripeBaseUrl()}/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${stripeSecretKey()}` } }
  );
  const jsonBody = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`stripe_session_failed:${res.status}`);
  return jsonBody;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Stripe signs webhook payloads with HMAC-SHA256:
//   payload_to_sign = `${timestamp}.${raw_body}`
// The Stripe-Signature header is `t=timestamp,v1=...,v0=...` (v1 is the
// current scheme). Timestamp must be within tolerance to prevent replays.
export async function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  toleranceSeconds = 300
): Promise<boolean> {
  const secret = stripeWebhookSecret();
  if (!secret || !signatureHeader) return false;

  const parts = signatureHeader.split(",").map((s) => s.trim());
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of parts) {
    const [k, ...rest] = part.split("=");
    const v = rest.join("=");
    if (k === "t") timestamp = v;
    else if (k === "v1") signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return false;

  // Reject stale deliveries (replay protection).
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSeconds) {
    return false;
  }

  const payloadToSign = `${timestamp}.${rawBody}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadToSign));
  const expected = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return signatures.some((s) => safeEqual(s, expected));
}
