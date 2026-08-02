// Shared Revolut Merchant API helpers used by the payment edge functions.
//
// Env vars (set as Supabase secrets):
//   REVOLUT_SECRET_KEY             — server-side API key (Bearer)
//   REVOLUT_PUBLIC_KEY             — public key (pk_...) given to the widget
//   REVOLUT_ENV                    — 'sandbox' | 'prod' (default: prod)
//   REVOLUT_WEBHOOK_SIGNING_SECRET — HMAC secret for webhook verification

export const PLANS: Record<string, { label: string; days: number | null; cents: number }> = {
  "1m": { label: "1 Month", days: 30, cents: 699 },
  "3m": { label: "3 Months", days: 90, cents: 1699 },
  "6m": { label: "6 Months", days: 180, cents: 2799 },
  "12m": { label: "12 Months", days: 365, cents: 4799 },
  lifetime: { label: "Lifetime", days: null, cents: 8900 },
};

const API_VERSION = "2026-04-20";

export function revolutMode(): "sandbox" | "prod" {
  return Deno.env.get("REVOLUT_ENV") === "sandbox" ? "sandbox" : "prod";
}

export function revolutBaseUrl(): string {
  return revolutMode() === "sandbox"
    ? "https://sandbox-merchant.revolut.com"
    : "https://merchant.revolut.com";
}

export function revolutSecretKey(): string | undefined {
  return Deno.env.get("REVOLUT_SECRET_KEY") || undefined;
}

export function revolutPublicKey(): string | undefined {
  return Deno.env.get("REVOLUT_PUBLIC_KEY") || undefined;
}

export function revolutSigningSecret(): string | undefined {
  return Deno.env.get("REVOLUT_WEBHOOK_SIGNING_SECRET") || undefined;
}

export async function createRevolutOrder(extRef: string, cents: number, currency = "EUR") {
  const res = await fetch(`${revolutBaseUrl()}/api/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${revolutSecretKey()}`,
      "Revolut-Api-Version": API_VERSION,
    },
    body: JSON.stringify({ amount: cents, currency, merchant_order_ext_ref: extRef }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`revolut_order_failed:${res.status}`);
  return body;
}

export async function fetchRevolutOrder(orderId: string) {
  const res = await fetch(`${revolutBaseUrl()}/api/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${revolutSecretKey()}` },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`revolut_status_failed:${res.status}`);
  return body;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Revolut signs webhook payloads with HMAC-SHA256:
//   payload_to_sign = v1.{Revolut-Request-Timestamp}.{raw payload, no whitespace}
// The Revolut-Signature header may carry several signatures (secret rotation).
export async function verifyWebhookSignature(
  rawBody: string,
  timestamp: string,
  signatureHeader: string
): Promise<boolean> {
  const secret = revolutSigningSecret();
  if (!secret || !timestamp || !signatureHeader) return false;

  const payloadToSign = `v1.${timestamp}.${rawBody}`;
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

  const supplied = signatureHeader
    .split(",")
    .map((s) => s.trim().replace(/^v1=/, ""));
  return supplied.some((s) => safeEqual(s, expected));
}
