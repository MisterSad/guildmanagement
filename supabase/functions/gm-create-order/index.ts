// gm-create-order — creates a Revolut order for a guild subscription.
// Actions:
//   { action: 'config' }  → returns the widget public key + environment
//   { action: 'create', guildId, plan } → creates the order, records it in
//     gm_payments (status 'pending') and returns the order token.
//
// Access: authenticated users with role guild_admin (own guild only) or
// super_admin (any guild).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  PLANS,
  createRevolutOrder,
  revolutMode,
  revolutPublicKey,
  revolutSecretKey,
} from "../_shared/revolut.ts";

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
  const action = (body?.action ?? "create").toString();

  // ── Config: public key + environment for the embedded checkout widget ─────
  if (action === "config") {
    return json({
      ok: true,
      publicKey: revolutPublicKey() ?? null,
      mode: revolutMode(),
      configured: Boolean(revolutPublicKey() && revolutSecretKey()),
    });
  }

  // ── Create order ───────────────────────────────────────────────────────────
  const guildId = (body?.guildId ?? "").toString().trim().toUpperCase();
  const planKey = (body?.plan ?? "").toString().trim();
  if (!guildId || !PLANS[planKey]) return json({ ok: false, error: "missing_fields" }, 200);

  // Guild admins can only purchase for their own guild.
  if (info.role === "guild_admin" && info.guild !== guildId) {
    return json({ ok: false, error: "forbidden" }, 200);
  }

  const secret = revolutSecretKey();
  const pub = revolutPublicKey();
  if (!secret || !pub) return json({ ok: false, error: "not_configured" }, 200);

  const { data: guild } = await admin.from("guilds").select("id").eq("id", guildId).maybeSingle();
  if (!guild) return json({ ok: false, error: "guild_not_found" }, 200);

  const plan = PLANS[planKey];
  const extRef = `gm_${crypto.randomUUID()}`;

  let order: { id?: string; token?: string };
  try {
    order = await createRevolutOrder(extRef, plan.cents);
  } catch (err) {
    console.error("[gm-create-order] Revolut order failed", err);
    return json({ ok: false, error: "revolut_order_failed" }, 200);
  }

  const orderId = (order?.id ?? "").toString();
  const token = (order?.token ?? "").toString();
  if (!orderId || !token) return json({ ok: false, error: "revolut_order_failed" }, 200);

  const { error: insErr } = await admin.from("gm_payments").insert({
    order_id: orderId,
    token,
    merchant_order_ext_ref: extRef,
    guild_id: guildId,
    plan_key: planKey,
    amount_cents: plan.cents,
    currency: "EUR",
    days_added: plan.days,
  });
  if (insErr) {
    console.error("[gm-create-order] insert failed", insErr);
    return json({ ok: false, error: "server_error" }, 200);
  }

  return json({
    ok: true,
    token,
    orderId,
    publicKey: pub,
    mode: revolutMode(),
  });
});
