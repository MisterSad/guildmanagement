// gm-order-status — client-side payment confirmation (polling).
//
// After Stripe redirects the user back to success_url, the client polls this
// function with the Checkout Session id. If Stripe confirms the session as
// paid, the subscription is applied right away with the same atomic/idempotent
// RPC used by the webhook — the UI can refresh immediately while the webhook
// remains the eventual source of truth.
//
// Access: authenticated guild_admin (owner guild) or super_admin.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { fetchCheckoutSession, stripeSecretKey } from "../_shared/stripe.ts";
import { getCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

async function getCallerInfo(
  req: Request,
  admin: ReturnType<typeof createClient>
): Promise<{ role: string | null; guild: string | null }> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return { role: null, guild: null };

  const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error } = await anonClient.auth.getUser(match[1]);
  if (error || !user) return { role: null, guild: null };

  const { data: acc } = await admin
    .from("accounts")
    .select("role, guild")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (!acc) return { role: null, guild: null };
  return { role: acc.role ?? null, guild: acc.guild ?? null };
}

Deno.serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("gm-order-status", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const info = await getCallerInfo(req, admin);
  const isAdmin = info.role === "super_admin" || info.role === "guild_admin";
  if (!isAdmin) return json({ ok: false, error: "forbidden" }, 200);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 200); }
  const sessionId = (body?.sessionId ?? "").toString().trim();
  if (!sessionId) return json({ ok: false, error: "missing_fields" }, 200);

  if (!stripeSecretKey()) return json({ ok: false, error: "not_configured" }, 200);

  const { data: pay } = await admin
    .from("gm_payments")
    .select("order_id, guild_id")
    .eq("token", sessionId)
    .maybeSingle();
  if (!pay || !pay.order_id) return json({ ok: false, error: "not_found" }, 200);

  // Guild admins may only poll their own guild's payments.
  if (info.role === "guild_admin" && info.guild !== pay.guild_id) {
    return json({ ok: false, error: "forbidden" }, 200);
  }

  logger.setContext({ tenantId: pay.guild_id });

  let session: { payment_status?: string; status?: string };
  try {
    session = await fetchCheckoutSession(pay.order_id);
  } catch (err) {
    logger.error("Stripe session fetch failed", err);
    return json({ ok: false, error: "session_failed" }, 200);
  }

  const paymentStatus = (session?.payment_status ?? "").toString().toLowerCase();
  if (paymentStatus === "paid") {
    const { data: rows, error } = await admin.rpc("gm_apply_subscription_payment", {
      p_order_id: pay.order_id,
    });
    if (error) {
      logger.error("Subscription payment apply failed", error);
      return json({ ok: false, error: "server_error" }, 200);
    }
    const row = (rows ?? [])[0];
    return json({
      ok: true,
      state: "completed",
      applied: Boolean(row?.applied),
      lifetime: Boolean(row?.lifetime),
      newEnd: row?.new_end ?? null,
      planKey: row?.plan_key ?? null,
    }, 200);
  }

  return json({ ok: true, state: paymentStatus, applied: false, newEnd: null }, 200);
});
