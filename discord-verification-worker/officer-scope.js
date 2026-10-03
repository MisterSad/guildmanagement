/**
 * discord-verification-worker/officer-scope.js
 *
 * Who may act on which FGF guild from Discord.
 *
 * The answer never comes from Discord itself: anyone can create a server and be
 * its Administrator, and the bot is in many servers. Authority comes from the
 * caller's LINKED app account, as for /invite in discord-bot-interactions.
 *
 * The worker is a Node service and cannot import the Edge Functions' Deno code,
 * so normalizeRole() and isGuildInScope() mirror
 * supabase/functions/_shared/admin-authz.ts. tests/discord_officer_scope.test.js
 * runs both over the same role matrix, so the two cannot drift apart silently.
 */

/** Only the four canonical roles count. Legacy ranks fall back to member. */
export function normalizeRole(raw) {
  const s = String(raw ?? "").toLowerCase().trim();
  if (s === "super_admin" || s === "server_admin" || s === "guild_admin") return s;
  return "member";
}

function normalizeServer(s) {
  if (s === null || s === undefined) return null;
  const str = String(s).trim();
  return str.length > 0 ? str : null;
}

function normalizeGuild(g) {
  if (!g) return null;
  const str = String(g).trim().toUpperCase();
  return str.length > 0 ? str : null;
}

/** super_admin: every guild. server_admin: guilds of their server. guild_admin: their guild. */
export function isGuildInScope(caller, targetGuild, targetServer) {
  if (!caller || !caller.role) return false;
  if (caller.role === "super_admin") return true;

  const tGuild = normalizeGuild(targetGuild);
  const cGuild = normalizeGuild(caller.guild);
  const tServer = normalizeServer(targetServer);
  const cServer = normalizeServer(caller.serverNumber);

  if (caller.role === "server_admin") {
    if (!cServer) return false;
    return tServer !== null && tServer === cServer;
  }
  if (caller.role === "guild_admin") {
    if (!cGuild) return false;
    return tGuild !== null && tGuild === cGuild;
  }
  return false;
}

/**
 * The ACTIVE officer accounts (any role above member) linked to a Discord
 * identity, each with its server number resolved from its guild when unset.
 * Same derivation as officerAccounts() in discord-bot-interactions.
 */
export async function officerAccounts(supabase, discordUserId) {
  const { data: links, error: linkError } = await supabase
    .from("discord_account_links")
    .select("account_id")
    .eq("discord_user_id", discordUserId);
  if (linkError) throw linkError;
  const ids = (links || []).map((l) => l.account_id);
  if (ids.length === 0) return [];

  const { data: accounts, error: accountError } = await supabase
    .from("accounts")
    .select("id, role, guild, server_number, status")
    .in("id", ids);
  if (accountError) throw accountError;

  const out = [];
  for (const a of accounts || []) {
    if (a.status !== "active") continue;
    const role = normalizeRole(a.role);
    if (role === "member") continue;
    let serverNumber = a.server_number ?? null;
    if (!serverNumber && a.guild) {
      const { data: g } = await supabase.from("guilds").select("server_number").eq("id", a.guild).maybeSingle();
      serverNumber = g?.server_number ?? null;
    }
    out.push({ id: a.id, role, guild: a.guild ?? null, serverNumber });
  }
  return out;
}

/**
 * True when one of the caller's linked officer accounts covers `targetGuild`.
 * Fails closed: no link, no officer account, or a lookup error all mean no.
 */
export async function isOfficerOf(supabase, discordUserId, targetGuild, targetServer) {
  let officers;
  try {
    officers = await officerAccounts(supabase, discordUserId);
  } catch {
    return false;
  }
  return officers.some((o) => isGuildInScope(o, targetGuild, targetServer));
}

/**
 * Escapes the LIKE wildcards, so `.ilike("pseudo", value)` means "equals,
 * ignoring case" and `%` cannot match an arbitrary player. Mirrors
 * supabase/functions/_shared/like.ts.
 */
export function escapeLike(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}
