/**
 * supabase/functions/discord-profile-verification/index.ts
 *
 * Receives one in-game profile screenshot forwarded by the
 * discord-verification-worker (a separate always-on Render process that
 * holds the Discord Gateway connection this feature needs -- Edge Functions
 * can't hold a persistent WebSocket, see the worker's own README).
 *
 * Role assignment rule (owner decision): the guild tag read off the
 * screenshot is matched against the Discord server's OWN existing role
 * names -- not a role ID configured anywhere. If a role named after the
 * guild's tag already exists AND the tag matches the guild this
 * verification channel belongs to, that role is assigned and the player's
 * guild_members entry is created/updated. Otherwise (wrong guild for this
 * channel, or the matching role hasn't been created yet) the player gets
 * the "Visitor" role instead and no roster entry is touched -- Visitor is
 * a safe default for an unrecognized or not-yet-configured guild, never a
 * guess at roster data. Every guild_members / ban / cross-guild decision
 * lives in _shared/discord-verification.ts (testable with a fake Supabase
 * client); this file stays the thin caller for OCR, the Discord role
 * lookup, and every Discord-facing action (role, nickname, reply message).
 * The worker itself has no business logic (Gateway listener + forwarder
 * only).
 *
 * Trust model (owner decision): the screenshot alone is accepted as proof
 * of identity -- no prior /link required. This only ever writes to
 * guild_members (roster/stats), never to accounts (no login credentials
 * are ever created from an image).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkAndRecordDiscordAttempt } from "../_shared/rate-limit.ts";
import { callGeminiVision } from "../_shared/gemini-vision.ts";
import { normalizeTag, resolveExpectedTag, resolveTagToGuild, evaluateVerification, resolveAuditChannelId, ExtractedProfile } from "../_shared/discord-verification.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") || "";
const DISCORD_WORKER_SECRET = Deno.env.get("DISCORD_WORKER_SECRET") || "";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const VISITOR_ROLE_NAME = "VISITOR";

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

async function discordFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function postChannelMessage(channelId: string, content: string): Promise<string | null> {
  try {
    const res = await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] }, // Never tag/ping any role, user, or @everyone
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const messageId = typeof data?.id === "string" ? data.id : null;
      if (messageId && typeof (globalThis as any).EdgeRuntime?.waitUntil === "function") {
        // Auto-cleanup bot verification message after 15s to keep the verification channel clean
        (globalThis as any).EdgeRuntime.waitUntil(
          new Promise((resolve) => setTimeout(resolve, 15000))
            .then(() => discordFetch(`/channels/${channelId}/messages/${messageId}`, { method: "DELETE" }))
            .catch(() => {})
        );
      }
      return messageId;
    }
  } catch (_) {
    // Best-effort -- a failed confirmation message shouldn't fail the request.
  }
  return null;
}

interface DiscordRole {
  id: string;
  name: string;
}

async function fetchServerRoles(discordServerId: string): Promise<DiscordRole[]> {
  try {
    const res = await discordFetch(`/guilds/${discordServerId}/roles`, { method: "GET" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function findRoleByNormalizedName(roles: DiscordRole[], normalizedTarget: string): DiscordRole | null {
  return roles.find((r) => normalizeTag(r.name) === normalizedTarget) || null;
}

async function assignRoleAndNickname(
  discordServerId: string,
  discordUserId: string,
  roleId: string,
  nickname: string | null,
  logger: EdgeLogger,
  removeRoleId?: string | null
): Promise<boolean> {
  const patchBody: Record<string, unknown> = {};
  if (nickname) patchBody.nick = nickname;

  try {
    const memberRes = await discordFetch(`/guilds/${discordServerId}/members/${discordUserId}`, { method: "GET" });
    if (memberRes.ok) {
      const memberData = await memberRes.json();
      let currentRoles: string[] = Array.isArray(memberData?.roles) ? memberData.roles : [];
      if (removeRoleId) {
        currentRoles = currentRoles.filter((id) => id !== removeRoleId);
      }
      patchBody.roles = currentRoles.includes(roleId) ? currentRoles : [...currentRoles, roleId];
    } else {
      patchBody.roles = [roleId];
    }
  } catch (e) {
    logger.warn("Failed to fetch current Discord member roles before patch", { error: String(e) });
    patchBody.roles = [roleId];
  }

  try {
    const patchRes = await discordFetch(`/guilds/${discordServerId}/members/${discordUserId}`, {
      method: "PATCH",
      body: JSON.stringify(patchBody),
    });
    if (!patchRes.ok) {
      logger.warn("Discord member PATCH failed (likely role hierarchy or server-owner nickname restriction)", { status: patchRes.status });
      return false;
    }
    return true;
  } catch (e) {
    logger.error("Discord member PATCH threw", e);
    return false;
  }
}

// "[TAG] Pseudo #Server" -- applied on both the guild-member path and the
// Visitor path (owner's request: even a Visitor's tag+server should be
// trackable), truncated defensively to Discord's 32-char nickname limit.
function buildNickname(tagDisplay: string, pseudo: string, serverNumber: string | null): string {
  let nickname = `${tagDisplay} ${pseudo}${serverNumber ? ` #${serverNumber}` : ""}`;
  if (nickname.length > 32) nickname = nickname.slice(0, 32);
  return nickname;
}

Deno.serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("discord-profile-verification", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!DISCORD_WORKER_SECRET) {
    logger.error("DISCORD_WORKER_SECRET is not configured");
    return json({ ok: false, error: "not_configured" }, 500);
  }
  const authHeader = req.headers.get("Authorization") || "";
  const authBearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!safeEqual(authBearer, DISCORD_WORKER_SECRET)) {
    logger.warn("Rejected discord-profile-verification call with invalid worker secret");
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  if (!GEMINI_API_KEY || !DISCORD_BOT_TOKEN) {
    logger.error("GEMINI_API_KEY or DISCORD_BOT_TOKEN not configured");
    return json({ ok: false, error: "not_configured" }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "bad_request" }, 400);
  }

  const discordUserId: string = String(body?.discord_user_id || "").trim();
  const discordServerId: string = String(body?.discord_server_id || "").trim();
  const channelId: string = String(body?.channel_id || "").trim();
  const fgfGuild: string = String(body?.fgf_guild || "").trim();
  const mimeType: string = String(body?.mime_type || "image/png").trim();
  const imageBase64: string = String(body?.image_base64 || "");

  if (!discordUserId || !discordServerId || !channelId || !fgfGuild || !imageBase64) {
    return json({ ok: false, error: "missing_fields" }, 400);
  }
  if (imageBase64.length > MAX_IMAGE_BYTES) {
    return json({ ok: false, error: "payload_too_large" }, 413);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  logger.setContext({ tenantId: fgfGuild, userId: discordUserId });

  const throttle = await checkAndRecordDiscordAttempt(admin, discordUserId, {
    limit: 5,
    windowMs: 10 * 60 * 1000, // 5 attempts per 10 minutes -- a one-time action, not a chat command
  });
  if (!throttle.allowed) {
    const botMsgId = await postChannelMessage(channelId, "⏳ Too many verification attempts. Please wait a few minutes and try again.");
    return json({ ok: false, error: "rate_limited", bot_message_id: botMsgId }, 429);
  }

  // OCR extraction -- single-profile prompt, calibrated against the app's
  // actual in-game profile screen layout: pseudo at the top, a "[TAG]
  // GuildName" pill right below it, "Power" and "Total Glory" as labeled
  // stat rows, and "UID: <digits>" at the very bottom of the screen
  // (distinctly shorter than the Power/Glory numbers -- don't confuse them).
  const prompt = `You are an OCR expert for Foundation Galactic Frontier (FGF) player profile screenshots. The profile screen layout is: the player's username near the top; a rounded pill just below it showing "[TAG] GuildName" (e.g. "[PR1M] ALPHA"); a "Power" stat row with a large number (e.g. "111,161,059"); a "Total Glory" stat row with a large number (e.g. "77,771,070"); and at the very bottom of the screen a much shorter "UID: <digits>" value (e.g. "UID: 1917131") followed by a server tag like "#1058" -- do not confuse the short UID with the much larger Power/Glory numbers.

Extract:
1. "pseudo": the username at the top.
2. "guild_tag": only the tag portion inside the brackets of the "[TAG] GuildName" pill (e.g. "PR1M", not "PR1M ALPHA" and not including the brackets). CRITICAL: Read the exact characters inside the brackets verbatim. External guilds have varied tags (e.g. "SB", "WAR", "SOL", etc.). Do NOT guess, auto-complete, or substitute with "IMK", "PR1M", or "OMG" if the letters are different. If no pill or brackets are visible, return null.
3. "server_number": only the digits after "#" at the bottom of the screen (e.g. "#1058" -> "1058"), or null if not visible.
4. "power": the Power stat converted to a pure integer, stripping commas (e.g. "111,161,059" -> 111161059) and expanding abbreviations (e.g. "145.2M" -> 145200000, "500K" -> 500000).
5. "glory": the Total Glory stat, converted the same way, or null if not visible.
6. "uid": the digits after "UID:" at the bottom of the screen, or null if not visible.

Return ONLY a JSON object: {"pseudo": "string", "guild_tag": "string or null", "server_number": "string or null", "power": number, "glory": number or null, "uid": "string or null"}`;

  let b64 = imageBase64;
  let mType = mimeType;
  if (b64.includes(";base64,")) {
    const p = b64.split(";base64,");
    if (p[0].includes("image/")) mType = p[0].split(":")[1];
    b64 = p[1];
  }

  const visionResult = await callGeminiVision(GEMINI_API_KEY, prompt, [{ mimeType: mType, base64Data: b64 }]);
  if (!visionResult.ok || !visionResult.raw) {
    logger.error("Gemini OCR failed for profile verification", undefined, { error: visionResult.error });
    const botMsgId = await postChannelMessage(channelId, "❌ Couldn't read your screenshot. Please try again with a clearer, uncropped image of your profile.");
    return json({ ok: false, error: "ocr_failed", bot_message_id: botMsgId }, 500);
  }

  let rawExtracted: any;
  try {
    rawExtracted = JSON.parse(visionResult.raw);
  } catch {
    const botMsgId = await postChannelMessage(channelId, "❌ Couldn't read your screenshot. Please try again with a clearer, uncropped image of your profile.");
    return json({ ok: false, error: "json_parse_failed", bot_message_id: botMsgId }, 500);
  }

  const pseudo = String(rawExtracted?.pseudo || "").trim();
  const extractedUid = rawExtracted?.uid ? String(rawExtracted.uid).trim() : "";
  const power = Number.isFinite(Number(rawExtracted?.power)) ? Math.max(0, Math.round(Number(rawExtracted.power))) : 0;
  const glory = rawExtracted?.glory != null && Number.isFinite(Number(rawExtracted.glory)) ? Math.max(0, Math.round(Number(rawExtracted.glory))) : null;
  const extractedServerNumber = rawExtracted?.server_number ? String(rawExtracted.server_number).replace(/[^0-9]/g, "").trim() : null;
  const extractedTagNormalized = normalizeTag(rawExtracted?.guild_tag);

  if (!pseudo || !extractedUid) {
    const botMsgId = await postChannelMessage(channelId, "❌ Couldn't find your pseudo and UID on that screenshot. Please try again with your full profile visible.");
    return json({ ok: false, error: "missing_fields_in_ocr", bot_message_id: botMsgId }, 200);
  }

  // Multi-tenant role decision: Does the extracted tag resolve to any known
  // FGF guild (e.g. [PR1M] -> ALPHA, [OMG] -> OMEGA, [IMK] -> IMK), AND does
  // a Discord role matching that tag exist on this server?
  // If yes: real guild member path for that guild.
  // Otherwise: Visitor path.
  const serverRoles = await fetchServerRoles(discordServerId);
  const visitorRole = findRoleByNormalizedName(serverRoles, VISITOR_ROLE_NAME);

  const tagMatch = await resolveTagToGuild(admin, extractedTagNormalized);
  const matchedGuildRole = tagMatch ? findRoleByNormalizedName(serverRoles, normalizeTag(tagMatch.tagDisplay)) : null;

  if (!matchedGuildRole) {
    if (!visitorRole) {
      const expectedTagDisplay = await resolveExpectedTag(admin, fgfGuild);
      logger.warn(`Neither a matching guild role nor a ${VISITOR_ROLE_NAME} role exists on this server`, { discordServerId, expectedTagDisplay });
      const botMsgId = await postChannelMessage(
        channelId,
        `⚠️ I couldn't find a matching guild role or a "[${VISITOR_ROLE_NAME}]" role on this server -- ask an officer to create one, then try again.`
      );
      return json({ ok: false, error: "no_matching_role", bot_message_id: botMsgId }, 200);
    }

    // Visitor path: All external or unrecognized guilds MUST be tagged [VISITOR].
    const { data: channelGuildRow } = await admin.from("guilds").select("server_number").eq("id", fgfGuild).maybeSingle();
    const serverNum = extractedServerNumber || (channelGuildRow as { server_number?: string } | null)?.server_number || null;
    const visitorTagDisplay = `[${VISITOR_ROLE_NAME}]`;
    const visitorNickname = buildNickname(visitorTagDisplay, pseudo, serverNum);

    const patched = await assignRoleAndNickname(discordServerId, discordUserId, visitorRole.id, visitorNickname, logger);
    const reason = rawExtracted?.guild_tag
      ? `external guild [${rawExtracted.guild_tag}]`
      : "no guild tag detected";
    const auditChannelId = await resolveAuditChannelId(admin, fgfGuild);
    const botMsgId = await postChannelMessage(
      channelId,
      patched
        ? `👋 Assigned the **${visitorRole.name}** role (**${visitorNickname}**) (${reason}). No roster changes were made.`
        : `⚠️ Tried to assign the **${visitorRole.name}** role but couldn't -- an officer may need to check my role position in Server Settings > Roles.`
    );
    return json({
      ok: true,
      role: "visitor",
      tag_matches_channel: false,
      nickname: visitorNickname,
      assigned_role_id: visitorRole.id,
      audit_channel_id: auditChannelId,
      bot_message_id: botMsgId,
    }, 200);
  }

  // Real guild member (matched PR1M -> ALPHA, OMG -> OMEGA, IMK -> IMK, etc.):
  // Run every ban / cross-guild / roster decision for the resolved guild.
  const targetGuild = tagMatch!.fgfGuild;
  const extracted: ExtractedProfile = { pseudo, uid: extractedUid, power, glory, serverNumber: extractedServerNumber };
  const result = await evaluateVerification(admin, targetGuild, discordUserId, extracted);

  if (!result.ok) {
    const messages: Record<string, string> = {
      banned: "❌ This player is banned from this guild's roster. Contact an officer if you believe this is a mistake.",
      uid_registered_elsewhere: "❌ This UID is already registered under a different guild. If you transferred guilds, ask an officer to update your roster entry.",
      db_error: "❌ Something went wrong updating your roster entry. Please try again later.",
    };
    const botMsgId = await postChannelMessage(channelId, messages[result.error] || "❌ Something went wrong. Please try again later.");
    return json({ ok: false, error: result.error, bot_message_id: botMsgId }, result.error === "db_error" ? 500 : 200);
  }

  const effectiveServerNumber = tagMatch!.serverNumber || extractedServerNumber || null;
  const nickname = buildNickname(tagMatch!.tagDisplay, result.finalPseudo, effectiveServerNumber);

  // Assign matched guild role and strip visitor role if previously assigned
  const patched = await assignRoleAndNickname(discordServerId, discordUserId, matchedGuildRole.id, nickname, logger, visitorRole?.id);
  const summary = result.isNewPlayer ? "added to the roster" : "roster updated";

  const botMsgId = await postChannelMessage(
    channelId,
    patched
      ? `✅ Verified: **${nickname}** — ${summary}, role **${matchedGuildRole.name}** assigned.`
      : `✅ Verified and ${summary} (**${result.finalPseudo}**), but I couldn't update your nickname/role automatically -- an officer may need to check my role position in Server Settings > Roles.`
  );

  const auditChannelId = (await resolveAuditChannelId(admin, targetGuild)) || (await resolveAuditChannelId(admin, fgfGuild));

  return json({
    ok: true,
    role: "guild_member",
    target_guild: targetGuild,
    pseudo: result.finalPseudo,
    uid: extractedUid,
    is_new_player: result.isNewPlayer,
    previous_power: result.previousPower ?? null,
    power: result.power,
    glory: result.glory,
    nickname,
    assigned_role_id: matchedGuildRole.id,
    audit_channel_id: auditChannelId,
    discord_actions_ok: patched,
    bot_message_id: botMsgId,
  });
});
