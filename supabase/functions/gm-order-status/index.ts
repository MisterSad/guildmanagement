// gm-order-status — client-side payment confirmation (polling).
//
// After the embedded checkout widget reports success (onSuccess), the client
// polls this function with the order's public token. If Revolut confirms the
// order as COMPLETED, the subscription is applied right away with the same
// atomic/idempotent RPC used by the webhook — the UI can refresh immediately
// while the webhook remains the eventual source of truth.
//
// Access: authenticated guild_admin (owner guild) or super_admin.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fetchRevolutOrder, revolutSecretKey } from "../_shared/revolut.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const info = await getCallerInfo(req, admin);
  const isAdmin = info.role === "super_admin" || info.role === "guild_admin";
  if (!isAdmin) return json({ ok: false, error: "forbidden" }, 200);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 200); }
  const token = (body?.orderId ?? "").toString().trim();
  if (!token) return json({ ok: false, error: "missing_fields" }, 200);

  if (!revolutSecretKey()) return json({ ok: false, error: "not_configured" }, 200);

  const { data: pay } = await admin
    .from("gm_payments")
    .select("order_id, guild_id")
    .eq("token", token)
    .maybeSingle();
  if (!pay || !pay.order_id) return json({ ok: false, error: "not_found" }, 200);

  // Guild admins may only poll their own guild's payments.
  if (info.role === "guild_admin" && info.guild !== pay.guild_id) {
    return json({ ok: false, error: "forbidden" }, 200);
  }

  let order: { state?: string };
  try {
    order = await fetchRevolutOrder(pay.order_id);
  } catch (err) {
    console.error("[gm-order-status] Revolut status failed", err);
    return json({ ok: false, error: "revolut_status_failed" }, 200);
  }

  const state = (order?.state ?? "").toString().toLowerCase();
  if (state === "completed") {
    const { data: rows, error } = await admin.rpc("gm_apply_subscription_payment", {
      p_order_id: pay.order_id,
    });
    if (error) {
      console.error("[gm-order-status] apply failed", error);
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
    });
  }

  return json({ ok: true, state, applied: false, newEnd: null });
});
