import { z } from "https://esm.sh/zod@3.23.8";
import { EdgeLogger } from "../_shared/logger.ts";
import { resolveCaller } from "../_shared/auth.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { serviceClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";
import { isAdminRole, isGuildAdmin, isGuildInScope, isServerAdmin } from "../_shared/admin-authz.ts";
import type { CallerInfo } from "../_shared/auth.ts";


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

/** The one definition of a webhook key, as in public.gm_is_webhook_key(). */
export function isWebhookKey(key: string): boolean {
  return key === "discord_webhook_url" || /^webhook_[a-z0-9_]{1,40}$/.test(key);
}

/** `https://` + host + path, without the wrappers users paste around it. */
function cleanWebhookUrl(url: string): string {
  const clean = url.replace(/^[<"'\s]+|[>'"\s]+$/g, "").trim();
  return clean.startsWith("http") ? clean : "https://" + clean;
}

const SetWebhookSchema = z.object({
  action: z.literal("set-webhook"),
  guild: z.string().trim().min(1).max(64),
  key: z.string().trim().max(64).refine(isWebhookKey, "not a webhook key"),
  // Empty removes the webhook.
  url: z.string().trim().max(512),
}).strict();

/**
 * ARC-04: the only way a webhook URL is written. The browser can neither read
 * nor write webhook rows of guild_config (migration webhook_urls_server_only);
 * it sends the new URL here, once, and is told only whether one is now set.
 */
async function setWebhook(
  caller: CallerInfo,
  rawBody: unknown,
  json: (b: unknown, s?: number) => Response,
  logger: EdgeLogger,
): Promise<Response> {
  const parsed = SetWebhookSchema.safeParse(rawBody);
  if (!parsed.success) return json({ ok: false, error: "bad_request" }, 400);
  const { guild, key, url } = parsed.data;

  const admin = serviceClient();
  const { data: g } = await admin.from("guilds").select("id, server_number").eq("id", guild).maybeSingle();
  if (!g) return json({ ok: false, error: "forbidden" }, 403);
  const target = g as { id: string; server_number: string | null };
  if (!isGuildInScope({ role: caller.role, guild: caller.guild, serverNumber: caller.serverNumber }, target.id, target.server_number)) {
    logger.warn("set-webhook outside the caller's scope", { requestedGuild: guild });
    return json({ ok: false, error: "forbidden" }, 403);
  }

  if (!url) {
    const { error } = await admin.from("guild_config").delete().eq("guild", target.id).eq("key", key);
    if (error) return json({ ok: false, error: "save_failed" }, 500);
    logger.info("Webhook removed", { guild: target.id, key });
    return json({ ok: true, configured: false });
  }

  if (!isValidDiscordWebhook(url)) {
    return json({ ok: false, error: "invalid_discord_webhook_url" }, 400);
  }
  const { error } = await admin.from("guild_config").upsert(
    { guild: target.id, key, value: cleanWebhookUrl(url), updated_at: new Date().toISOString() },
    { onConflict: "guild,key" },
  );
  if (error) return json({ ok: false, error: "save_failed" }, 500);
  // Never log the URL: it is the channel's credential.
  logger.info("Webhook set", { guild: target.id, key });
  return json({ ok: true, configured: true });
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
  const caller = await resolveCaller(req);
  if (!caller.authenticated || !caller.role || !isAdminRole(caller.role)) {
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

  let rawBody: any;
  try {
    rawBody = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  if (rawBody && typeof rawBody === "object" && rawBody.action === "set-webhook") {
    const clientIp = extractClientIp(req.headers);
    const limit = await checkAndRecordIpAttempt(serviceClient(), clientIp, { limit: 30, windowMs: 60000 });
    if (!limit.allowed) return json({ ok: false, error: "rate_limit_exceeded", retry_after: 60 }, 429);
    return await setWebhook(caller, rawBody, json, logger);
  }

  try {
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
    if (isGuildAdmin(caller.role) && rawClientWebhook) {
      logger.warn("Guild admin attempted to provide client-supplied webhook URL", {
        callerGuild: caller.guild,
      });
      return json({ ok: false, error: "forbidden_client_webhook_url" }, 403);
    }

    // Guild Admins are strictly scoped to their own guild
    if (isGuildAdmin(caller.role)) {
      if (requestedGuild && caller.guild && requestedGuild.toUpperCase() !== caller.guild.toUpperCase()) {
        logger.warn("Guild admin attempted cross-guild discord webhook dispatch", {
          callerGuild: caller.guild,
          requestedGuild,
        });
        return json({ ok: false, error: "forbidden_cross_guild" }, 403);
      }
      requestedGuild = caller.guild || requestedGuild;
    } else if (isServerAdmin(caller.role)) {
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
      isAdminRole(caller.role);

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
