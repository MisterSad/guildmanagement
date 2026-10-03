import { EdgeLogger } from "../_shared/logger.ts";
import { validateCallerAuth } from "../_shared/auth.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { serviceClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";

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

const ALLOWED_DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
  "ptb.discordapp.com",
  "canary.discordapp.com",
]);

const DISCORD_WEBHOOK_PATH_REGEX = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/;

function isValidDiscordWebhook(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  const clean = url.replace(/^[<"'\s]+|[>'"\s]+$/g, "").trim();
  try {
    const u = new URL(clean.startsWith("http") ? clean : "https://" + clean);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === "443") &&
      ALLOWED_DISCORD_HOSTS.has(u.hostname.toLowerCase()) &&
      DISCORD_WEBHOOK_PATH_REGEX.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export async function handler(req: Request): Promise<Response> {
  const json = makeJson(req);
  const logger = new EdgeLogger("discord-webhook-proxy", req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: getCorsHeaders(req) });
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
  let hasExplicitEveryonePermission = false;

  try {
    const rawBody = await req.json();
    const body =
      rawBody && typeof rawBody === "object" && rawBody.body && typeof rawBody.body === "object"
        ? rawBody.body
        : rawBody;

    const rawClientWebhook = (body?.webhookUrl ?? body?.url ?? "").toString().trim();
    requestedGuild = (body?.guild ?? "").toString().trim();
    const eventPrefix = (body?.eventPrefix ?? "").toString().trim();

    if (body?.payload && typeof body.payload === "object") {
      payload = body.payload;
    } else {
      const { webhookUrl: _w, url: _u, guild: _g, eventPrefix: _ep, ...rest } = body;
      payload = rest;
    }

    // 1. Interdire formellement les URLs Discord webhook fournies par le client pour les guild_admins
    if (caller.role === "guild_admin" && rawClientWebhook) {
      logger.warn("Guild admin attempted to provide client-supplied webhook URL", {
        callerGuild: caller.guild,
      });
      return json({ ok: false, error: "forbidden_client_webhook_url" }, 403);
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
      if (rawClientWebhook) {
        logger.warn("Server admin attempted to provide client-supplied webhook URL", {
          callerServer: caller.serverNumber,
        });
        return json({ ok: false, error: "forbidden_client_webhook_url" }, 403);
      }
      if (requestedGuild && caller.serverNumber) {
        const adminClient = serviceClient();
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

    // 2. Si le rôle est 'super_admin', ignorer body.webhookUrl fourni par le client et forcer la résolution serveur de l'URL depuis guild_config.
    // Pour tous les rôles admis (super_admin, server_admin, guild_admin), webhookUrl est résolu côté serveur depuis guild_config.
    webhookUrl = "";

    // 3. Permission explicite et validée pour @everyone / @here
    const explicitEveryoneRequested = Boolean(
      body?.allowEveryoneMention === true ||
      body?.allow_everyone_mention === true ||
      body?.allowEveryone === true ||
      payload?.allowEveryoneMention === true ||
      payload?.allow_everyone_mention === true ||
      payload?.allowEveryone === true
    );
    hasExplicitEveryonePermission =
      explicitEveryoneRequested &&
      (caller.role === "super_admin" || caller.role === "guild_admin" || caller.role === "server_admin");

    // Server-side resolution from guild_config
    requestedGuild = requestedGuild || caller.guild || "";
    if (!webhookUrl && requestedGuild) {
      const adminClient = serviceClient();
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
        webhookUrl = resolved.replace(/^[<"'\s]+|[>'"\s]+$/g, "").trim();
      }
    }
  } catch (err) {
    logger.error("Failed to parse request payload", err);
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const hasContent = typeof payload?.content === "string" && payload.content.trim().length > 0;
  const hasEmbeds = Array.isArray(payload?.embeds) && payload.embeds.length > 0;

  // The payload is relayed to Discord as given: bound it to what Discord
  // itself accepts before spending a quota slot on it (audit SEC-13).
  if ((typeof payload?.content === "string" && payload.content.length > 2000)
      || (payload?.embeds !== undefined && (!Array.isArray(payload.embeds) || payload.embeds.length > 10))
      || JSON.stringify(payload ?? {}).length > 60_000) {
    return json({ ok: false, error: "payload_too_large" }, 400);
  }

  if (!webhookUrl || (!hasContent && !hasEmbeds)) {
    return json({ ok: false, error: "missing_webhook_url_or_content" }, 400);
  }

  if (!isValidDiscordWebhook(webhookUrl)) {
    const masked = webhookUrl.replace(/(https:\/\/discord\.com\/api\/webhooks\/\d+\/)[^?#\s]+/, '$1***');
    logger.warn("Invalid Discord Webhook URL blocked", { webhookUrl: masked });
    return json({ ok: false, error: "invalid_discord_webhook_url" }, 400);
  }

  // Rate-limiting: max 30 dispatches per minute per client IP
  const clientIp = extractClientIp(req.headers);
  const adminClient = serviceClient();
  const rateLimitResult = await checkAndRecordIpAttempt(adminClient, clientIp, { limit: 30, windowMs: 60000 });
  if (!rateLimitResult.allowed) {
    logger.warn("Rate limit exceeded for discord webhook proxy", { clientIp, guild: requestedGuild });
    return json({ ok: false, error: "rate_limit_exceeded", retry_after: 60 }, 429);
  }

  try {
    logger.info("Dispatching Discord webhook", {
      guild: requestedGuild,
      hasContent,
      embedsCount: Array.isArray(payload?.embeds) ? payload.embeds.length : 0,
    });

    // 3. Supprimer systématiquement "@everyone" et "@here" de allowed_mentions par défaut, sauf permission explicite et validée
    if (payload && typeof payload === "object") {
      if (!payload.allowed_mentions) {
        payload.allowed_mentions = { parse: ["roles", "users"] };
        if (hasExplicitEveryonePermission) {
          payload.allowed_mentions = { parse: ["roles", "users", "everyone"] };
        }
      } else if (typeof payload.allowed_mentions === "object" && Array.isArray(payload.allowed_mentions.parse)) {
        if (!hasExplicitEveryonePermission) {
          payload.allowed_mentions.parse = payload.allowed_mentions.parse.filter(
            (p: unknown) => typeof p === "string" && p !== "everyone" && p !== "here"
          );
        }
      }
    }

    const discordRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });

    if (discordRes.ok || discordRes.status === 204 || discordRes.status === 200) {
      return json({ ok: true, status: discordRes.status });
    }

    if (discordRes.status === 429) {
      const retryAfter = discordRes.headers.get("retry-after") || "5";
      logger.warn("Discord returned 429 Rate Limit", { retryAfter, guild: requestedGuild });
      return json({ ok: false, error: "discord_rate_limited", retry_after: Number(retryAfter) || 5 }, 429);
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
}

serveUnlessTest(handler);
