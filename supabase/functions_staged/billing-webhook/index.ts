/**
 * billing-webhook: Paddle Billing -> guilds.subscription_status (saas_strategy.md §8).
 *
 * STAGED + INERT. Deploy only with the multi-tenant release (it writes the
 * guilds table from migrations_staged/). It also does nothing useful until a
 * Paddle account exists and PADDLE_WEBHOOK_SECRET is set. Until then it simply
 * is not wired (no notification destination points at it).
 *
 * Security: Paddle signs each request with `Paddle-Signature: ts=…;h1=<hmac>`.
 * h1 = HMAC-SHA256( `${ts}:${rawBody}` , endpoint secret ). We verify it over
 * the UNMODIFIED raw body and reject stale timestamps (replay protection).
 * https://developer.paddle.com/webhooks/about/signature-verification
 *
 * Env (Supabase Edge function secrets):
 *   PADDLE_WEBHOOK_SECRET   notification destination secret (pdl_ntfset_… )
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * config.toml: [functions.billing-webhook] verify_jwt = false  (called by Paddle)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("PADDLE_WEBHOOK_SECRET") ?? "";
const TOLERANCE_SECONDS = 300; // accept ts within 5 min (clock skew + retries)

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare of two equal-length hex strings.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(rawBody: string, header: string): Promise<boolean> {
  if (!WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(";").map((p) => {
    const i = p.indexOf("=");
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const ts = parts["ts"];
  const h1 = parts["h1"];
  if (!ts || !h1) return false;

  // Replay protection.
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}:${rawBody}`));
  return timingSafeEqual(hex(sig), h1.toLowerCase());
}

// Paddle subscription.status -> our guilds.subscription_status.
// Paddle: trialing | active | past_due | paused | canceled.
function mapStatus(paddleStatus: string): string {
  switch (paddleStatus) {
    case "trialing": return "trialing";
    case "active":   return "active";
    case "past_due": return "past_due";
    case "paused":   return "read_only";
    case "canceled": return "canceled";
    default:         return "active";
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method_not_allowed", { status: 405 });

  const rawBody = await req.text();
  const ok = await verifySignature(rawBody, req.headers.get("Paddle-Signature") ?? "");
  if (!ok) return new Response("invalid_signature", { status: 401 });

  let event: Record<string, unknown>;
  try { event = JSON.parse(rawBody); } catch { return new Response("bad_json", { status: 400 }); }

  const type = String(event.event_type ?? "");
  const data = (event.data ?? {}) as Record<string, unknown>;
  const custom = (data.custom_data ?? {}) as Record<string, unknown>;
  const guildId = custom.guild_id ? String(custom.guild_id) : null;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // We act on subscription lifecycle. transaction.* events are acknowledged
  // (200) but the subscription.* events carry the authoritative status.
  if (type.startsWith("subscription.")) {
    const subId = data.id ? String(data.id) : null;
    const custId = data.customer_id ? String(data.customer_id) : null;
    const status = mapStatus(String(data.status ?? "active"));
    const mgmt = (data.management_urls ?? {}) as Record<string, unknown>;
    const managementUrl = mgmt.update_payment_method ? String(mgmt.update_payment_method) : null;

    const patch: Record<string, unknown> = {
      subscription_status: status,
      provider_subscription_id: subId,
    };
    if (custId) patch.provider_customer_id = custId;
    if (managementUrl) patch.management_url = managementUrl;
    if (data.next_billed_at) patch.trial_ends_at = data.next_billed_at; // trial end ~= first bill

    // Locate the guild: custom_data first (set at checkout), else by sub/customer id.
    let q = supabase.from("guilds").update(patch);
    if (guildId) q = q.eq("id", guildId);
    else if (subId) q = q.eq("provider_subscription_id", subId);
    else if (custId) q = q.eq("provider_customer_id", custId);
    else return new Response(JSON.stringify({ ok: true, skipped: "no_guild_ref" }), { headers: { "Content-Type": "application/json" } });

    const { error } = await q;
    if (error) {
      console.error("billing-webhook update failed:", error);
      return new Response("server_error", { status: 500 });
    }
  }

  return new Response(JSON.stringify({ ok: true, type }), { headers: { "Content-Type": "application/json" } });
});
