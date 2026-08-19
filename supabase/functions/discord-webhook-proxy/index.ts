import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { validateCallerAuth } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-correlation-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidDiscordWebhook(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  const clean = url.replace(/^[<"'\s]+|[>'"\s]+$/g, "").trim();
  try {
    const u = new URL(clean.startsWith("http") ? clean : "https://" + clean);
    return (
      u.protocol === "https:" &&
      (u.hostname === "discord.com" ||
        u.hostname === "discordapp.com" ||
        u.hostname.endsWith(".discord.com") ||
        u.hostname.endsWith(".discordapp.com")) &&
      u.pathname.includes("/webhooks/")
    );
  } catch {
    return false;
  }
}

serve(async (req: Request) => {
  const logger = new EdgeLogger("discord-webhook-proxy", req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    logger.warn("Method not allowed", { method: req.method });
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  // 1. Mandatory JWT & RBAC Verification (C1 / SEV-01 Fix)
  const caller = await validateCallerAuth(req, SUPABASE_URL, ANON_KEY, SERVICE_ROLE);
  if (!caller.authenticated || !caller.role || (caller.role !== "guild_admin" && caller.role !== "server_admin" && caller.role !== "super_admin")) {
    logger.warn("Unauthorized attempt to access discord proxy", {
      authenticated: caller.authenticated,
      role: caller.role,
    });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  logger.setContext({ tenantId: caller.guild, userId: caller.accountId });

  let webhookUrl = "";
  let payload: any = null;
  let requestedGuild = "";

  try {
    const rawBody = await req.json();
    const body =
      rawBody && typeof rawBody === "object" && rawBody.body && typeof rawBody.body === "object"
        ? rawBody.body
        : rawBody;

    webhookUrl = (body?.webhookUrl ?? body?.url ?? "").toString().trim();
    requestedGuild = (body?.guild ?? "").toString().trim();
    const eventPrefix = (body?.eventPrefix ?? "").toString().trim();

    if (body?.payload && typeof body.payload === "object") {
      payload = body.payload;
    } else {
      const { webhookUrl: _w, url: _u, guild: _g, eventPrefix: _ep, ...rest } = body;
      payload = rest;
    }

    // Guild Admins are strictly scoped to their own guild
    if (caller.role === "guild_admin") {
      if (requestedGuild && caller.guild && requestedGuild.toUpperCase() !== caller.guild.toUpperCase()) {
        logger.warn("Guild admin attempted cross-guild discord webhook dispatch", {
          callerGuild: caller.guild,
          requestedGuild,
        });
        return json({ ok: false, error: "forbidden_cross_guild" }, 403);
      }
      requestedGuild = caller.guild || requestedGuild;
    } else if (caller.role === "server_admin") {
      if (requestedGuild && caller.serverNumber) {
        const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
        const { data: g } = await adminClient.from("guilds").select("server_number").eq("id", requestedGuild).maybeSingle();
        if (!g || g.server_number !== caller.serverNumber) {
          logger.warn("Server admin attempted cross-server discord webhook dispatch", {
            callerServer: caller.serverNumber,
            requestedGuild,
          });
          return json({ ok: false, error: "forbidden_cross_server" }, 403);
        }
      }
    }

    // Server-side fallback resolution if webhookUrl is empty
    if (!webhookUrl && requestedGuild) {
      const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
      const { data: rows } = await adminClient
        .from("guild_config")
        .select("key, value")
        .eq("guild", requestedGuild);

      const configMap: Record<string, string> = {};
      (rows || []).forEach((r) => {
        configMap[r.key] = r.value;
      });

      let resolved = eventPrefix ? configMap[`webhook_${eventPrefix}`] : null;
      if (!resolved || !resolved.trim()) {
        resolved = configMap["discord_webhook_url"];
      }
      if (!resolved || !resolved.trim()) {
        const fallbacks = ["webhook_armsrace", "webhook_svs", "webhook_gvg", "webhook_dtr", "webhook_calamity", "webhook_shadowfront"];
        for (const fk of fallbacks) {
          if (configMap[fk] && configMap[fk].trim()) {
            resolved = configMap[fk];
            break;
          }
        }
      }
      if (resolved && resolved.trim()) {
        webhookUrl = resolved.trim();
      }
    }
  } catch (err) {
    logger.error("Failed to parse request payload", err);
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const hasContent = typeof payload?.content === "string" && payload.content.trim().length > 0;
  const hasEmbeds = Array.isArray(payload?.embeds) && payload.embeds.length > 0;

  if (!webhookUrl || (!hasContent && !hasEmbeds)) {
    return json({ ok: false, error: "missing_webhook_url_or_content" }, 400);
  }

  if (!isValidDiscordWebhook(webhookUrl)) {
    logger.warn("Invalid Discord Webhook URL blocked", { webhookUrl });
    return json({ ok: false, error: "invalid_discord_webhook_url" }, 400);
  }

  try {
    logger.info("Dispatching Discord webhook", {
      guild: requestedGuild,
      hasContent,
      embedsCount: Array.isArray(payload?.embeds) ? payload.embeds.length : 0,
    });

    const discordRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });

    if (discordRes.ok || discordRes.status === 204 || discordRes.status === 200) {
      return json({ ok: true, status: discordRes.status });
    }

    const errText = await discordRes.text().catch(() => "");
    logger.error("Discord returned error status", undefined, { status: discordRes.status, errText });
    return json(
      { ok: false, status: discordRes.status, error: `Discord HTTP ${discordRes.status}: ${errText}` },
      200
    );
  } catch (err: any) {
    logger.error("Fetch to Discord failed", err);
    return json({ ok: false, error: `Server fetch to Discord failed: ${err?.message ?? err}` }, 200);
  }
});
