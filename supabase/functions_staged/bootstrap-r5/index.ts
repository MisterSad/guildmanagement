/**
 * bootstrap-r5: first-login provisioning for an email R5 (saas_strategy.md §6.1).
 *
 * STAGED (writes the multi-tenant guilds table). Called by app/auth.js right
 * after a freshly-confirmed guild leader signs in and has no guild yet. Creates
 * the guild (14-day trial) and stamps the user's app_metadata with
 * { app_role:'R5', guild_id, account_id } so RLS works. Idempotent: a second
 * call returns the existing guild.
 *
 * verify_jwt = true: the caller is the signed-in R5 (we read their identity
 * from the JWT, then use service_role for the privileged writes).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY     = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function slugify(s: string): string {
  const base = s.toLowerCase().normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "guild";
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${base}-${rnd}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: ures, error: uerr } = await userClient.auth.getUser();
  const user = ures?.user;
  if (uerr || !user) return json({ ok: false, error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  // Already provisioned? (claim present, or a guild already owned — handles retries)
  const existingGuildId = (user.app_metadata as Record<string, unknown>)?.guild_id as string | undefined;
  if (existingGuildId) return json({ ok: true, guild_id: existingGuildId });

  const { data: owned } = await admin.from("guilds").select("id").eq("owner_user_id", user.id).maybeSingle();
  let guildId = owned?.id as string | undefined;

  const guildName = ((user.user_metadata as Record<string, unknown>)?.guild_name as string | undefined)?.trim()
    || (user.email ? user.email.split("@")[0] : "My Guild");

  if (!guildId) {
    const trialEnds = new Date(Date.now() + 14 * 86400000).toISOString();
    const { data: created, error: gErr } = await admin
      .from("guilds")
      .insert({
        name: guildName,
        slug: slugify(guildName),
        subscription_status: "trialing",
        trial_ends_at: trialEnds,
        owner_user_id: user.id,
      })
      .select("id")
      .single();
    if (gErr || !created) {
      console.error("bootstrap-r5 guild insert failed:", gErr);
      return json({ ok: false, error: "guild_create_failed" }, 500);
    }
    guildId = created.id;
  }

  const { error: mErr } = await admin.auth.admin.updateUserById(user.id, {
    app_metadata: { app_role: "R5", guild_id: guildId, account_id: guildName },
  });
  if (mErr) {
    console.error("bootstrap-r5 metadata update failed:", mErr);
    return json({ ok: false, error: "metadata_failed" }, 500);
  }

  return json({ ok: true, guild_id: guildId });
});
