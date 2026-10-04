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
 * names -- not a role ID configured anywhere. Three outcomes:
 *
 *   guild_member -- the tag resolves to a guild sharing this verification
 *       channel's own game-server number, a role named after that tag exists
 *       here, and the roster agrees (see ADR-020). Role + nickname assigned,
 *       stats updated.
 *   pending -- the tag resolved and the role exists, but the guild has
 *       `discord_verification_require_roster` on and this player is not in its
 *       member list. NO guild role, nothing written to the roster, a durable
 *       message to the officer channel. The "[PENDING]" role if the server has
 *       one, else Visitor, else nickname only.
 *   visitor -- no tag, an unknown tag, a tag belonging to another game server,
 *       or no matching role yet. Visitor is the safe default for an
 *       unrecognized or not-yet-configured guild, never a guess at roster data.
 *
 * Every guild_members / ban / roster / gate decision lives in
 * _shared/discord-verification.ts (testable with a fake Supabase client); this
 * file stays the thin caller for OCR, the Discord role lookup, and every
 * Discord-facing action (role, nickname, reply message). The worker itself has
 * no business logic (Gateway listener + forwarder only).
 *
 * Trust model (owner decision): the screenshot alone is accepted as proof
 * of identity -- no prior /link required. This only ever writes to
 * guild_members (roster/stats), never to accounts (no login credentials
 * are ever created from an image).
 */
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { checkAndRecordDiscordAttempt } from "../_shared/rate-limit.ts";
import { callGeminiVision } from "../_shared/gemini-vision.ts";
import {
  normalizeTag,
  resolveExpectedTag,
  resolveHomeServerNumber,
  resolveTagToGuildOnServer,
  evaluateVerification,
  resolveAuditChannelId,
  postAuditMessage,
  ExtractedProfile,
  RefusalReason,
} from "../_shared/discord-verification.ts";
import type { AdminClient } from "../_shared/db.ts";
import { serviceClient } from "../_shared/clients.ts";
import { serveUnlessTest } from "../_shared/serve.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const DISCORD_BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") || "";
const DISCORD_WORKER_SECRET = Deno.env.get("DISCORD_WORKER_SECRET") || "";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const VISITOR_ROLE_NAME = "VISITOR";
// Resolved by name from the server's live role list, exactly like VISITOR --
// no new config key. A server without one falls back to Visitor.
const PENDING_ROLE_NAME = "PENDING";

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

// `roleId` is nullable so the pending path can patch a nickname without ever
// granting a role: a server with neither a "[PENDING]" nor a "[VISITOR]" role
// must still not receive a guild role as a consolation prize.
async function assignRoleAndNickname(
  discordServerId: string,
  discordUserId: string,
  roleId: string | null,
  nickname: string | null,
  logger: EdgeLogger,
  removeRoleIds?: (string | null | undefined)[]
): Promise<boolean> {
  const patchBody: Record<string, unknown> = {};
  if (nickname) patchBody.nick = nickname;
  const toRemove = new Set((removeRoleIds || []).filter((id): id is string => !!id));

  try {
    const memberRes = await discordFetch(`/guilds/${discordServerId}/members/${discordUserId}`, { method: "GET" });
    if (memberRes.ok) {
      const memberData = await memberRes.json();
      let currentRoles: string[] = Array.isArray(memberData?.roles) ? memberData.roles : [];
      currentRoles = currentRoles.filter((id) => !toRemove.has(id));
      if (roleId) {
        patchBody.roles = currentRoles.includes(roleId) ? currentRoles : [...currentRoles, roleId];
      } else if (toRemove.size > 0) {
        patchBody.roles = currentRoles;
      }
    } else if (roleId) {
      patchBody.roles = [roleId];
    }
  } catch (e) {
    logger.warn("Failed to fetch current Discord member roles before patch", { error: String(e) });
    if (roleId) patchBody.roles = [roleId];
  }

  if (Object.keys(patchBody).length === 0) return true;

  try {
    const patchRes = await discordFetch(`/guilds/${discordServerId}/members/${discordUserId}`, {
      method: "PATCH",
      body: JSON.stringify(patchBody),
    });
    if (!patchRes.ok) {
      logger.warn("Discord member PATCH failed (likely role hierarchy or server-owner nickname restriction)", {
        status: patchRes.status,
      });
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
// An empty tag yields "Pseudo #Server": the pending path must not stamp a
// membership claim it is in the middle of refusing.
function buildNickname(tagDisplay: string, pseudo: string, serverNumber: string | null): string {
  const prefix = tagDisplay ? `${tagDisplay} ` : "";
  let nickname = `${prefix}${pseudo}${serverNumber ? ` #${serverNumber}` : ""}`;
  if (nickname.length > 32) nickname = nickname.slice(0, 32);
  return nickname;
}

// Where an officer will actually see this.
//
// Measured 2026-09-28: `guild_config` holds ZERO rows for
// discord_audit_channel_id and discord_officer_channel_id -- not empty ones,
// none at all -- across all 28 guilds. So the officer notification the roster
// gate promises had nowhere to go for anybody, and a held verification would
// have been silent: the player learns they are pending, nobody who can fix it
// does. The verification channel is the last resort, because a message nobody
// reads is still better than a message nobody sends. It is posted with the
// DURABLE helper, so it survives while the player's reply and the screenshot
// are cleaned up around it.
async function resolveOfficerChannel(
  admin: AdminClient,
  targetGuild: string,
  fgfGuild: string,
  verificationChannelId: string,
  logger: EdgeLogger
): Promise<{ channelId: string; isFallback: boolean }> {
  const configured =
    (await resolveAuditChannelId(admin, targetGuild)) || (await resolveAuditChannelId(admin, fgfGuild));
  if (configured) return { channelId: configured, isFallback: false };
  logger.warn(
    "No audit or officer channel configured; posting the officer notice in the verification channel instead",
    { targetGuild, fgfGuild }
  );
  return { channelId: verificationChannelId, isFallback: true };
}

// What the player is told, and what the officer channel records, for each way
// the roster can refuse. Kept next to each other so the two never disagree.
function pendingAuditReason(reason: RefusalReason, onFileUid?: string): string {
  switch (reason) {
    case "pseudo_conflict":
      return `that pseudo is already on the roster under a different UID (\`${onFileUid || "unknown"}\`)`;
    case "ambiguous_pseudo":
      return "several roster entries share that pseudo, so I cannot tell which one this is";
    case "scan_truncated":
      return "the roster read came back truncated, so I refused rather than guess (this is a bug -- please report it)";
    default:
      return "no roster entry matches this UID or pseudo";
  }
}

function pendingPlayerMessage(
  reason: RefusalReason,
  tagDisplay: string,
  targetGuild: string,
  serverNumber: string,
  pseudo: string,
  uid: string,
  assignedRoleName: string | null,
  patched: boolean
): string {
  const held = assignedRoleName && patched ? ` You have the **${assignedRoleName}** role meanwhile.` : "";
  switch (reason) {
    case "pseudo_conflict":
      return `⏳ I can't give you the **${tagDisplay}** role yet — **${pseudo}** is already in the **${targetGuild}** roster under a different UID, and yours reads \`${uid}\`. An officer has been notified and needs to check it.${held}`;
    case "ambiguous_pseudo":
      return `⏳ I can't give you the **${tagDisplay}** role yet — several **${targetGuild}** roster entries share the pseudo **${pseudo}**, so I won't guess which one is you. An officer has been notified.${held}`;
    case "scan_truncated":
      return `⏳ I couldn't read the **${targetGuild}** roster completely, so I'm not granting a role on a partial answer. An officer has been notified -- please try again in a few minutes.${held}`;
    default:
      return `⏳ I can't give you the **${tagDisplay}** role yet — **${pseudo}** (UID \`${uid}\`) isn't in the **${targetGuild}** member list for server **#${serverNumber}**. An officer has been notified; once they add you in the Guild Management tool, post your screenshot again.${held}`;
  }
}

export async function handler(req: Request): Promise<Response> {
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

  const admin = serviceClient();
  logger.setContext({ tenantId: fgfGuild, userId: discordUserId });

  const throttle = await checkAndRecordDiscordAttempt(admin, discordUserId, {
    limit: 5,
    windowMs: 10 * 60 * 1000, // 5 attempts per 10 minutes -- a one-time action, not a chat command
  });
  if (!throttle.allowed) {
    const botMsgId = await postChannelMessage(
      channelId,
      "⏳ Too many verification attempts. Please wait a few minutes and try again."
    );
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
    const botMsgId = await postChannelMessage(
      channelId,
      "❌ Couldn't read your screenshot. Please try again with a clearer, uncropped image of your profile."
    );
    return json({ ok: false, error: "ocr_failed", bot_message_id: botMsgId }, 500);
  }

  let rawExtracted: any;
  try {
    rawExtracted = JSON.parse(visionResult.raw);
  } catch {
    const botMsgId = await postChannelMessage(
      channelId,
      "❌ Couldn't read your screenshot. Please try again with a clearer, uncropped image of your profile."
    );
    return json({ ok: false, error: "json_parse_failed", bot_message_id: botMsgId }, 500);
  }

  const pseudo = String(rawExtracted?.pseudo || "").trim();
  const extractedUid = rawExtracted?.uid ? String(rawExtracted.uid).trim() : "";
  const power = Number.isFinite(Number(rawExtracted?.power)) ? Math.max(0, Math.round(Number(rawExtracted.power))) : 0;
  const glory =
    rawExtracted?.glory != null && Number.isFinite(Number(rawExtracted.glory))
      ? Math.max(0, Math.round(Number(rawExtracted.glory)))
      : null;
  const extractedServerNumber = rawExtracted?.server_number
    ? String(rawExtracted.server_number)
        .replace(/[^0-9]/g, "")
        .trim()
    : null;
  const extractedTagNormalized = normalizeTag(rawExtracted?.guild_tag);

  if (!pseudo || !extractedUid) {
    const botMsgId = await postChannelMessage(
      channelId,
      "❌ Couldn't find your pseudo and UID on that screenshot. Please try again with your full profile visible."
    );
    return json({ ok: false, error: "missing_fields_in_ocr", bot_message_id: botMsgId }, 200);
  }

  // ---------------------------------------------------------------------
  // Role decision. Two guards, both from data, neither with a tenant name or
  // a game-server literal in it (ADR-003, ADR-020):
  //   1. the tag resolves ONLY among the guilds sharing this channel's own
  //      guilds.server_number, so a same-tag guild on another game server can
  //      neither be granted nor be blocked from here;
  //   2. the target guild's roster decides, when it asked to.
  // ---------------------------------------------------------------------
  const serverRoles = await fetchServerRoles(discordServerId);
  const visitorRole = findRoleByNormalizedName(serverRoles, VISITOR_ROLE_NAME);
  const pendingRole = findRoleByNormalizedName(serverRoles, PENDING_ROLE_NAME);

  const homeServerNumber = await resolveHomeServerNumber(admin, fgfGuild);
  const tagMatch = await resolveTagToGuildOnServer(admin, extractedTagNormalized, homeServerNumber, fgfGuild);

  // A misconfiguration must fail visibly and must never widen the search back
  // to every tenant -- an unresolved tenant never falls back to a real guild.
  if (tagMatch.kind === "home_server_unknown") {
    logger.error("Verification channel's guild has no server_number; no guild role can be resolved", undefined, {
      fgfGuild,
    });
    const officer = await resolveOfficerChannel(admin, fgfGuild, fgfGuild, channelId, logger);
    await postAuditMessage(
      officer.channelId,
      `⚠️ Verification is misconfigured: guild **${fgfGuild}** has no game-server number, so no guild tag can be resolved and every screenshot will be treated as a visitor. Set the server number in the Guild Management tool (Settings > Guild).`
    );
  } else if (tagMatch.kind === "ambiguous") {
    logger.error("Two guilds on the same game server share this tag; refusing to guess", undefined, {
      serverNumber: tagMatch.serverNumber,
      candidates: tagMatch.candidates.join(","),
      tag: extractedTagNormalized,
    });
    const officer = await resolveOfficerChannel(admin, fgfGuild, fgfGuild, channelId, logger);
    await postAuditMessage(
      officer.channelId,
      `⚠️ Verification is misconfigured: guilds **${tagMatch.candidates.join("**, **")}** all use the tag **[${extractedTagNormalized}]** on server **#${tagMatch.serverNumber}**. I will not guess which one a screenshot belongs to -- fix the guild tags in the Guild Management tool. Players are getting the Visitor role meanwhile.`
    );
  }

  const matched = tagMatch.kind === "match" ? tagMatch : null;

  // Strict-if-present: a server number read off the screenshot that disagrees
  // with the channel's own is a screenshot from another game server, whatever
  // the tag says. When the OCR read nothing -- the "#1058" line sits at the
  // very bottom and is often cropped -- the roster check is the authority, so
  // do not block on it.
  const serverMismatch = !!(matched && extractedServerNumber && extractedServerNumber !== matched.serverNumber);
  if (serverMismatch) {
    logger.warn("Screenshot's server number disagrees with the channel's guild; treating as a visitor", {
      extractedServerNumber,
      homeServerNumber,
    });
  }

  const matchedGuildRole =
    matched && !serverMismatch ? findRoleByNormalizedName(serverRoles, normalizeTag(matched.tagDisplay)) : null;

  if (!matchedGuildRole) {
    if (!visitorRole) {
      const expectedTagDisplay = await resolveExpectedTag(admin, fgfGuild);
      logger.warn(`Neither a matching guild role nor a ${VISITOR_ROLE_NAME} role exists on this server`, {
        discordServerId,
        expectedTagDisplay,
      });
      const botMsgId = await postChannelMessage(
        channelId,
        `⚠️ I couldn't find a matching guild role or a "[${VISITOR_ROLE_NAME}]" role on this server -- ask an officer to create one, then try again.`
      );
      return json({ ok: false, error: "no_matching_role", bot_message_id: botMsgId }, 200);
    }

    // Visitor path: All external or unrecognized guilds MUST be tagged [VISITOR].
    const serverNum = extractedServerNumber || homeServerNumber || null;
    const visitorTagDisplay = `[${VISITOR_ROLE_NAME}]`;
    const visitorNickname = buildNickname(visitorTagDisplay, pseudo, serverNum);

    const patched = await assignRoleAndNickname(
      discordServerId,
      discordUserId,
      visitorRole.id,
      visitorNickname,
      logger,
      [pendingRole?.id]
    );
    const reason = serverMismatch
      ? `guild [${extractedTagNormalized}] belongs to game server #${homeServerNumber}, but the screenshot reads #${extractedServerNumber}`
      : rawExtracted?.guild_tag
        ? `external guild [${rawExtracted.guild_tag}]`
        : "no guild tag detected";
    const auditChannelId = await resolveAuditChannelId(admin, fgfGuild);
    const botMsgId = await postChannelMessage(
      channelId,
      patched
        ? `👋 Assigned the **${visitorRole.name}** role (**${visitorNickname}**) (${reason}). No roster changes were made.`
        : `⚠️ Tried to assign the **${visitorRole.name}** role but couldn't -- an officer may need to check my role position in Server Settings > Roles.`
    );
    return json(
      {
        ok: true,
        role: "visitor",
        tag_matches_channel: false,
        nickname: visitorNickname,
        assigned_role_id: visitorRole.id,
        audit_channel_id: auditChannelId,
        bot_message_id: botMsgId,
      },
      200
    );
  }

  // Real guild member candidate: the tag resolved to a guild on this game
  // server and that guild's role exists here. The roster has the last word.
  const targetGuild = matched!.fgfGuild;
  const extracted: ExtractedProfile = { pseudo, uid: extractedUid, power, glory, serverNumber: extractedServerNumber };
  const result = await evaluateVerification(admin, targetGuild, discordUserId, extracted);

  if (!result.ok && result.error === "not_on_roster") {
    // PENDING: never the guild role, never a roster write. The tag is the
    // membership claim being refused, so it is not written into the nickname
    // either -- and any guild/visitor role a previous run granted is removed.
    const pendingNickname = buildNickname("", pseudo, extractedServerNumber || matched!.serverNumber);
    const assigned = pendingRole || visitorRole || null;
    // Strip the guild role a previous run may have granted, plus whichever of
    // the two holding roles is not the one being assigned now.
    const stripRoles = [matchedGuildRole.id, visitorRole?.id, pendingRole?.id].filter(
      (id) => id && id !== assigned?.id
    );
    const patched = await assignRoleAndNickname(
      discordServerId,
      discordUserId,
      assigned?.id || null,
      pendingNickname,
      logger,
      stripRoles
    );

    const playerMessage = pendingPlayerMessage(
      result.reason,
      matched!.tagDisplay,
      targetGuild,
      matched!.serverNumber,
      pseudo,
      extractedUid,
      assigned?.name || null,
      patched
    );
    const botMsgId = await postChannelMessage(channelId, playerMessage);

    // Durable on purpose (not the 15s auto-deleting reply): this is the only
    // place an officer can see that someone is waiting to be added.
    const officer = await resolveOfficerChannel(admin, targetGuild, fgfGuild, channelId, logger);
    const auditChannelId = officer.isFallback ? null : officer.channelId;
    {
      await postAuditMessage(
        officer.channelId,
        `⏳ **Verification held** — **${pseudo}** (UID \`${extractedUid}\`) claimed **${matched!.tagDisplay}** on server **#${matched!.serverNumber}** but is not in the **${targetGuild}** member list.\n` +
          `• Reason: ${pendingAuditReason(result.reason, result.onFileUid)}\n` +
          (result.otherGuilds.length ? `• That UID is on the roster of: ${result.otherGuilds.join(", ")}\n` : "") +
          `• Power read: ${power.toLocaleString("en-US")}${glory != null ? ` · Glory: ${glory.toLocaleString("en-US")}` : ""}\n` +
          `• Action: add them in the Guild Management tool, then ask them to post their screenshot again. No role was granted and nothing was written to the roster.` +
          (officer.isFallback
            ? `\n• *This notice is here because **${targetGuild}** has no audit/officer channel configured. Set one in the Guild Management tool to keep these out of the verification channel.*`
            : "")
      );
    }

    return json(
      {
        ok: false,
        error: "not_on_roster",
        role: "pending",
        reason: result.reason,
        target_guild: targetGuild,
        pseudo,
        uid: extractedUid,
        nickname: pendingNickname,
        assigned_role_id: assigned?.id || null,
        other_guilds: result.otherGuilds,
        audit_channel_id: auditChannelId,
        discord_actions_ok: patched,
        bot_message_id: botMsgId,
      },
      200
    );
  }

  if (!result.ok) {
    const messages: Record<string, string> = {
      banned: "❌ This player is banned from this guild's roster. Contact an officer if you believe this is a mistake.",
      db_error: "❌ Something went wrong updating your roster entry. Please try again later.",
    };
    const botMsgId = await postChannelMessage(
      channelId,
      messages[result.error] || "❌ Something went wrong. Please try again later."
    );
    return json({ ok: false, error: result.error, bot_message_id: botMsgId }, result.error === "db_error" ? 500 : 200);
  }

  const effectiveServerNumber = matched!.serverNumber || extractedServerNumber || null;
  const nickname = buildNickname(matched!.tagDisplay, result.finalPseudo, effectiveServerNumber);

  // Assign the matched guild role, and strip any visitor/pending role a
  // previous attempt left behind.
  const patched = await assignRoleAndNickname(discordServerId, discordUserId, matchedGuildRole.id, nickname, logger, [
    visitorRole?.id,
    pendingRole?.id,
  ]);
  const summary = result.isNewPlayer ? "added to the roster" : "roster updated";

  const botMsgId = await postChannelMessage(
    channelId,
    patched
      ? `✅ Verified: **${nickname}** — ${summary}, role **${matchedGuildRole.name}** assigned.`
      : `✅ Verified and ${summary} (**${result.finalPseudo}**), but I couldn't update your nickname/role automatically -- an officer may need to check my role position in Server Settings > Roles.`
  );

  const auditChannelId =
    (await resolveAuditChannelId(admin, targetGuild)) || (await resolveAuditChannelId(admin, fgfGuild));

  return json({
    ok: true,
    role: "guild_member",
    target_guild: targetGuild,
    pseudo: result.finalPseudo,
    uid: extractedUid,
    is_new_player: result.isNewPlayer,
    uid_backfilled: result.uidBackfilled === true,
    previous_power: result.previousPower ?? null,
    power: result.power,
    glory: result.glory,
    nickname,
    assigned_role_id: matchedGuildRole.id,
    audit_channel_id: auditChannelId,
    discord_actions_ok: patched,
    bot_message_id: botMsgId,
  });
}

serveUnlessTest(handler);
