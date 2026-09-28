/**
 * discord-verification-worker/index.js
 *
 * The ONLY reason this worker exists: reacting to a message posted in a
 * Discord channel requires the Gateway (a persistent WebSocket), which a
 * stateless Supabase Edge Function cannot hold open. This worker stays as
 * small as possible -- it listens for image attachments in configured
 * verification channels, gives the player immediate feedback (⏳ while the
 * screenshot is being processed, then ✅/❌), forwards the screenshot to the
 * discord-profile-verification Edge Function, and handles the /profile and
 * /absent slash commands (registered at startup via the REST API). The Edge
 * Function keeps the authoritative business logic; this file only handles
 * the Gateway-only surface (reactions, replies, slash command handlers) that
 * no stateless function can do.
 */
import { createServer } from "node:http";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from "discord.js";
import { provisionDiscordServer } from "./server-provisioner.js";
import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

const {
  DISCORD_BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  VERIFICATION_FUNCTION_URL,
  DISCORD_WORKER_SECRET,
  // Optional: single Discord role ID to grant after a successful profile
  // verification. When empty, the per-guild guild_config fallback is used;
  // if neither is set the feature is disabled (see addVerifiedRole).
  DISCORD_MEMBER_ROLE_ID,
} = process.env;

// The player-command Edge Function lives next to the verification one, so its
// URL is derived rather than made a new Render env var the owner has to set.
// An explicit INTERACTIONS_FUNCTION_URL still wins if it is ever set.
const INTERACTIONS_FUNCTION_URL =
  (process.env.INTERACTIONS_FUNCTION_URL || "").trim() ||
  (VERIFICATION_FUNCTION_URL || "").replace(/\/discord-profile-verification\/?$/, "/discord-bot-interactions");

// Opt-in, because it is a privileged intent -- see the client's intents below.
const MEMBERS_INTENT_ENABLED = (process.env.DISCORD_GUILD_MEMBERS_INTENT || "").trim() === "true";

const REQUIRED_ENV = {
  DISCORD_BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  VERIFICATION_FUNCTION_URL,
  DISCORD_WORKER_SECRET,
};
for (const [name, value] of Object.entries(REQUIRED_ENV)) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  // Without an explicit transport, older runtimes fail to resolve WebSocket
  // and the Realtime client crashes at startup. Node >= 22 ships a global
  // WebSocket, but pinning the "ws" implementation keeps behavior identical
  // across local dev and Render.
  realtime: { transport: WebSocket },
});

// Which Discord channel maps to which FGF guild -- refreshed periodically so
// a guild admin enabling the feature doesn't require a worker restart.
let channelToGuild = new Map();

async function refreshChannelMap() {
  const { data, error } = await supabase
    .from("guild_config")
    .select("guild, value")
    .eq("key", "discord_verification_channel_id");

  if (error) {
    console.error("Failed to refresh verification channel map:", error.message);
    return;
  }

  const next = new Map();
  for (const row of data || []) {
    const channelId = (row.value || "").trim();
    if (channelId) next.set(channelId, row.guild);
  }
  channelToGuild = next;
  console.log(`Verification channel map refreshed: ${channelToGuild.size} guild(s) configured.`);
}

// Optional per-guild verified-role ID (guild_config key discord_member_role_id),
// used only when DISCORD_MEMBER_ROLE_ID isn't set globally. Scoped by the FGF
// guild the verification channel belongs to, mirroring the channel map above.
let memberRoleByGuild = new Map();

async function refreshMemberRoleMap() {
  const { data, error } = await supabase
    .from("guild_config")
    .select("guild, value")
    .eq("key", "discord_member_role_id");

  if (error) {
    console.error("Failed to refresh verified member role map:", error.message);
    return;
  }

  const next = new Map();
  for (const row of data || []) {
    const roleId = (row.value || "").trim();
    if (roleId) next.set(row.guild, roleId);
  }
  memberRoleByGuild = next;
  console.log(`Verified member role map refreshed: ${memberRoleByGuild.size} guild(s) configured.`);
}

// Audit/officer channel map (discord_audit_channel_id or discord_officer_channel_id)
// for forwarding verification events and absence declarations.
let auditChannelByGuild = new Map();

async function refreshAuditChannelMap() {
  const { data, error } = await supabase
    .from("guild_config")
    .select("guild, value, key")
    .in("key", ["discord_audit_channel_id", "discord_officer_channel_id"]);

  if (error) {
    console.error("Failed to refresh audit channel map:", error.message);
    return;
  }

  const next = new Map();
  for (const row of data || []) {
    const channelId = (row.value || "").trim();
    if (channelId && !next.has(row.guild)) next.set(row.guild, channelId);
  }
  auditChannelByGuild = next;
  console.log(`Audit channel map refreshed: ${auditChannelByGuild.size} guild(s) configured.`);
}

// Render creates this as a Web Service (the MCP tool used to provision it
// has no "background worker" type) -- that expects an HTTP port bound for
// health checks, even though the actual job here is a Gateway connection,
// not serving requests. This listener exists ONLY to satisfy that check;
// it carries no business logic and nothing ever calls it on purpose.
let discordReady = false;
createServer((_req, res) => {
  res.writeHead(discordReady ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: discordReady }));
}).listen(process.env.PORT || 3000, () => {
  console.log(`Health check listener up on port ${process.env.PORT || 3000}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // Listing who holds a role means listing members, and that needs the
    // PRIVILEGED GuildMembers intent. Declaring it while the toggle is off in
    // the Discord Developer Portal makes the bot fail to log in entirely
    // ("Used disallowed intents") -- the whole bot, not just one command. So it
    // is opt-in: flip "Server Members Intent" in the portal, then set
    // DISCORD_GUILD_MEMBERS_INTENT=true on Render. /reconcile-roles says so
    // when it is missing.
    ...(MEMBERS_INTENT_ENABLED ? [GatewayIntentBits.GuildMembers] : []),
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Reactions are the only Gateway-only feedback this worker owns for
// verification: the Edge Function already posts the detailed confirmation /
// error messages into the channel, so the worker never adds a text reply --
// it just flips ⏳ to ✅/❌ so the player sees progress on their own message.
async function addReaction(message, emoji) {
  try {
    await message.react(emoji);
  } catch (e) {
    console.warn(`Failed to add ${emoji} reaction in ${message.channel.id}:`, e.message);
  }
}

async function removeBotReaction(message, emoji) {
  try {
    const reaction = message.reactions.cache.get(emoji);
    if (reaction) await reaction.users.remove(client.user.id);
  } catch (e) {
    console.warn(`Failed to remove ${emoji} reaction in ${message.channel.id}:`, e.message);
  }
}

async function settleFeedback(message, succeeded) {
  await removeBotReaction(message, "⏳");
  await addReaction(message, succeeded ? "✅" : "❌");
}

// Grants the verified-member role after a successful verification. Isolated
// try/catch: a permission failure (e.g. the bot's role sits below the target
// role) is logged as a warning and never crashes the worker or cancels the ✅
// reaction already applied. No-op when neither the env var nor a guild_config
// fallback provides a role ID.
async function addVerifiedRole(message, fgfGuild) {
  const roleId = (DISCORD_MEMBER_ROLE_ID || "").trim() || (memberRoleByGuild.get(fgfGuild) || "").trim();
  if (!roleId) return;

  try {
    const member = await message.guild.members.fetch(message.author.id);
    if (!member) {
      console.warn(`Verified member ${message.author.id} not found in guild ${message.guild.id}; role not assigned.`);
      return;
    }
    if (member.roles.cache.has(roleId)) return;
    await member.roles.add(roleId, "FGF Automated Profile Verification");
    console.log(`Assigned verified member role to ${message.author.id} in guild ${message.guild.id}.`);
  } catch (e) {
    console.warn(
      `Could not assign verified member role (${roleId}) to ${message.author.id} in guild ${message.guild.id}: ${e.message}. ` +
      `Check that the bot's role sits above the target role in Server Settings > Roles.`
    );
  }
}

// Commands whose logic lives in the discord-bot-interactions Edge Function.
//
// They already EXIST on Discord -- scripts/register-discord-commands.mjs
// registered them and this worker preserves commands it does not own -- but the
// worker had no handler, so running one produced "The application did not
// respond". Measured 2026-09-28: the Edge Function was invoked 0 times in 24
// hours, because Discord delivers interactions over the Gateway for this
// application, not to an Interactions Endpoint URL.
//
// The interaction is forwarded rather than reimplemented here: those five
// commands run the same validated, audited `_shared/player-actions.ts` paths the
// Player Portal uses, and a second Node copy would drift from them.
const FORWARDED_COMMANDS = new Set(["update-stats", "timezone", "challenges", "absence"]);

/** discord.js option tree -> Discord's raw option array, subcommands included. */
function rawOptions(list) {
  return (list || []).map((o) => ({
    name: o.name,
    type: o.type,
    ...(o.value !== undefined ? { value: o.value } : {}),
    ...(o.options && o.options.length ? { options: rawOptions(o.options) } : {}),
  }));
}

function toRawInteraction(interaction) {
  const user = { id: interaction.user.id, username: interaction.user.username };
  return {
    // 2 = APPLICATION_COMMAND, the only type forwarded here.
    type: 2,
    id: interaction.id,
    application_id: interaction.applicationId,
    guild_id: interaction.guildId || null,
    channel_id: interaction.channelId || null,
    data: {
      name: interaction.commandName,
      options: rawOptions(interaction.options?.data),
    },
    ...(interaction.member ? { member: { user } } : {}),
    user,
  };
}

async function forwardInteraction(interaction) {
  // Discord allows 3 seconds to acknowledge; the Edge round trip plus a database
  // write can exceed that, so acknowledge first and edit the reply after.
  await interaction.deferReply({ ephemeral: true });

  const res = await fetch(INTERACTIONS_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DISCORD_WORKER_SECRET}`,
    },
    // Rebuilt into Discord's own APPLICATION_COMMAND shape, because that is what
    // the Edge Function reads (interaction.data.name, interaction.data.options,
    // and the subcommand nested inside options[0].options for /absence).
    // discord.js `toJSON()` does NOT give the raw gateway payload back.
    body: JSON.stringify({ interaction: toRawInteraction(interaction) }),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok || !payload) {
    console.warn(`discord-bot-interactions returned ${res.status} for /${interaction.commandName}`);
    await interaction.editReply({ content: "Something went wrong running that command. Please try again." });
    return;
  }

  // The Edge Function answers in Discord's interaction-response shape.
  const data = payload.data || {};
  const content = typeof data.content === "string" && data.content.trim() ? data.content : null;
  const embeds = Array.isArray(data.embeds) ? data.embeds : [];

  if (!content && embeds.length === 0) {
    await interaction.editReply({ content: "Done." });
    return;
  }
  await interaction.editReply({
    ...(content ? { content } : {}),
    ...(embeds.length ? { embeds } : {}),
    allowedMentions: { parse: [] },
  });
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
// ApplicationCommandOptionType: 6 = USER, 3 = STRING, 4 = INTEGER.
const PROFILE_COMMAND = {
  name: "profile",
  description: "View a member's combat stats from the FGF roster.",
  options: [
    { name: "user", description: "Discord user to look up via their linked account", type: 6, required: false },
    { name: "ingame_name", description: "In-game pseudo to search in the roster", type: 3, required: false },
  ],
};

const ABSENT_COMMAND = {
  name: "absent",
  description: "Declare an absence for your guild.",
  options: [
    { name: "start_date", description: "First day of absence (YYYY-MM-DD)", type: 3, required: true },
    { name: "end_date", description: "Last day of absence (YYYY-MM-DD)", type: 3, required: true },
    { name: "reason", description: "Reason for the absence", type: 3, required: false },
  ],
};

const TOP_COMMAND = {
  name: "top",
  description: "View the top guild members leaderboard.",
  options: [
    {
      name: "category",
      description: "Leaderboard category (Overall Power, Glory, or Fleet)",
      type: 3,
      required: false,
      choices: [
        { name: "Overall Power", value: "power" },
        { name: "Glory Score", value: "glory" },
        { name: "Fleet Rating", value: "fleet" },
      ],
    },
  ],
};

const ABSENCES_COMMAND = {
  name: "absences",
  description: "Check declared absences in your guild (today or upcoming).",
  options: [
    {
      name: "scope",
      description: "Timeframe to check",
      type: 3,
      required: true,
      choices: [
        { name: "Today (Currently Active)", value: "today" },
        { name: "Upcoming (Next 7 Days)", value: "upcoming" },
      ],
    },
  ],
};

const CALL_TO_ARMS_COMMAND = {
  name: "call-to-arms",
  description: "Launch an interactive war check-in with live presence and power tracking.",
  options: [
    { name: "event_name", description: "Event name (e.g. SvS Invasion, GvG Saturday)", type: 3, required: true },
    { name: "description", description: "Battle objective or instructions", type: 3, required: false },
  ],
};

const UPDATE_STATS_COMMAND = {
  name: "update-stats",
  description: "Quickly update your combat power and/or glory score in the roster.",
  options: [
    { name: "power", description: "Your current Overall Power (digits only, e.g. 150000000)", type: 4, required: false, min_value: 0 },
    { name: "glory", description: "Your current Glory score", type: 4, required: false, min_value: 0 },
  ],
};

const SETUP_SERVER_COMMAND = {
  name: "setup-server",
  description: "Format and bootstrap a full Discord server structure for an FGF guild.",
  default_member_permissions: "8",
  options: [
    {
      name: "guild",
      description: "Target FGF Guild identifier (e.g. ALPHA, BABE, CLAW)",
      type: 3,
      required: true,
    },
    {
      name: "server_number",
      description: "Game server number (e.g. 1058). Defaults to guild's registered server.",
      type: 3,
      required: false,
    },
    {
      name: "clean_mode",
      description: "Delete default empty channels before creating structure (default: false)",
      type: 5,
      required: false,
    },
  ],
};

// The five commands whose logic lives in the discord-bot-interactions Edge
// Function (see FORWARDED_COMMANDS). Their definitions used to exist ONLY in
// scripts/register-discord-commands.mjs -- a third registry, run by hand, that
// nothing kept in step with the two handlers. They live here now, with every
// other command, so there is one source of truth and Discord cannot end up
// serving a command no source file describes.
// Retired 2026-09-28: /power and /glory did exactly what /update-stats does, and
// /absence's `set` subcommand did what /absent does (and /absent also alerts the
// officer channel). Dropping a name from `desired` is NOT enough to remove it
// from Discord, because the merge step below folds unknown existing commands
// back in so this worker never wipes one it does not own -- so they are named
// here and excluded from that fold.
const RETIRED_COMMANDS = new Set(["power", "glory"]);

const TIMEZONE_COMMAND = {
  name: "timezone",
  description: "Set your timezone (UTC offset).",
  options: [
    { name: "offset", description: "UTC offset in hours (e.g. -5, 0, 8)", type: 4, required: true, min_value: -12, max_value: 14 },
  ],
};

const CHALLENGES_COMMAND = {
  name: "challenges",
  description: "Show your weekly challenges progress.",
};

const ABSENCE_COMMAND = {
  name: "absence",
  description: "Manage your absence declarations.",
  options: [
    // `set` retired -- /absent declares an absence and alerts the officers.
    { type: 1, name: "list", description: "List your own absences" },
    {
      type: 1,
      name: "cancel",
      description: "Cancel a declared absence",
      options: [
        { type: 3, name: "id", description: "Absence ID (from /absence list)", required: true },
      ],
    },
  ],
};

const RECONCILE_ROLES_COMMAND = {
  name: "reconcile-roles",
  description: "Officers: who holds the guild role without being on the roster.",
  default_member_permissions: String(PermissionFlagsBits.ManageRoles),
};

const MYSTATS_COMMAND = {
  name: "mystats",
  description: "Your attendance per event type, and how your guild compares.",
  options: [
    { name: "weeks", description: "How many recent weeks to include (1-26, default 4)", type: 4, required: false, min_value: 1, max_value: 26 },
  ],
};

const VERIFICATIONS_COMMAND = {
  name: "verifications",
  description: "Officers: players whose Discord verification was held back.",
  default_member_permissions: String(PermissionFlagsBits.ManageMessages),
  options: [
    { name: "days", description: "How far back to look (1-30, default 7)", type: 4, required: false, min_value: 1, max_value: 30 },
  ],
};

const LINK_COMMAND = {
  name: "link",
  description: "Link your Discord account to your FGF Guild Management player account.",
};

const MYINFO_COMMAND = {
  name: "myinfo",
  description: "Show your linked player stats (power, glory, role, timezone).",
};

// Registers slash commands via the REST API, merging into whatever
// global commands already exist so other commands are never wiped on a redeploy.
async function registerSlashCommands() {
  const appId = client.user?.id;
  if (!appId) {
    console.error("Cannot register slash commands: bot user not ready yet.");
    return;
  }

  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);
  try {
    const existing = (await rest.get(Routes.applicationCommands(appId))) || [];
    const existingByName = new Map(existing.map((c) => [c.name, c]));

    const desired = new Map([
      ["link", LINK_COMMAND],
      ["myinfo", MYINFO_COMMAND],
      ["profile", PROFILE_COMMAND],
      ["absent", ABSENT_COMMAND],
      ["top", TOP_COMMAND],
      ["absences", ABSENCES_COMMAND],
      ["call-to-arms", CALL_TO_ARMS_COMMAND],
      ["update-stats", UPDATE_STATS_COMMAND],
      ["setup-server", SETUP_SERVER_COMMAND],
      ["mystats", MYSTATS_COMMAND],
      ["reconcile-roles", RECONCILE_ROLES_COMMAND],
      ["verifications", VERIFICATIONS_COMMAND],
      // Forwarded to the Edge Function, but owned here.
      ["timezone", TIMEZONE_COMMAND],
      ["challenges", CHALLENGES_COMMAND],
      ["absence", ABSENCE_COMMAND],
    ]);

    const body = [];
    for (const [name, cmd] of desired) {
      const current = existingByName.get(name);
      if (current) body.push({ ...cmd, id: current.id });
      else body.push(cmd);
    }
    // Unchanged commands are folded back in untouched -- legacy commands never
    // get wiped or overwritten by this register step.
    for (const cmd of existing) {
      if (desired.has(cmd.name) || RETIRED_COMMANDS.has(cmd.name)) continue;
      body.push(cmd);
    }

    const retiring = existing.filter((c) => RETIRED_COMMANDS.has(c.name));
    if (retiring.length > 0) {
      console.log(`Retiring commands: ${retiring.map((c) => `/${c.name}`).join(", ")} -- superseded by /update-stats.`);
    }

    const unowned = existing.filter((c) => !desired.has(c.name));
    if (unowned.length > 0) {
      console.log(`Preserved commands this worker does not define: ${unowned.map((c) => `/${c.name}`).join(", ")}.`);
    }

    // Global registration
    await rest.put(Routes.applicationCommands(appId), { body });
    console.log(`Slash commands registered globally: ${[...desired.keys()].map((n) => `/${n}`).join(", ")}`);

    // ONE SCOPE, and it is global.
    //
    // Discord lists global and guild-scoped commands separately, so a command
    // registered in BOTH shows up TWICE in the picker. This loop used to
    // register the same set per guild for instant availability, and it failed
    // every time -- `body` carries each global command's id, which a
    // guild-scoped PUT rejects with APPLICATION_COMMANDS_INVALID_ID ("Invalid
    // Form Body"). Stripping the ids made it succeed, and every command promptly
    // appeared twice for every player. The duplicate was the fix working.
    //
    // So the guild scope is CLEARED instead, every boot: idempotent, cheap, and
    // it repairs any server still holding a duplicate set. The cost is that a
    // NEW or CHANGED command now waits on global propagation, which is the
    // honest trade for a command list players can read.
    let cleared = 0;
    for (const guild of client.guilds.cache.values()) {
      try {
        const guildCommands = (await rest.get(Routes.applicationGuildCommands(appId, guild.id))) || [];
        if (guildCommands.length === 0) continue;
        await rest.put(Routes.applicationGuildCommands(appId, guild.id), { body: [] });
        cleared += 1;
      } catch (err) {
        console.warn(`Could not clear guild-scoped commands for ${guild.id}:`, err.message);
      }
    }
    console.log(
      cleared > 0
        ? `Cleared duplicate guild-scoped command sets from ${cleared}/${client.guilds.cache.size} guild(s) -- the global set is the only one.`
        : `No guild-scoped command sets to clear; the global set is the only one (${client.guilds.cache.size} guild(s)).`
    );
  } catch (e) {
    console.error("Failed to register slash commands:", e);
  }
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

function timezoneLabel(offset) {
  if (offset === null || offset === undefined || offset === "") return "—";
  const n = Number(offset);
  if (!Number.isFinite(n)) return "—";
  return `UTC${n >= 0 ? "+" : ""}${n}`;
}

/**
 * The roster identity behind a Discord user.
 *
 * Returns { uid, guild } for exactly one active linked account, or
 * { ambiguous: [{ id, guild, role }] } when the person holds several and the
 * command has to ask which one.
 *
 * Migration 20260927120000 re-keyed `discord_account_links` to
 * (discord_user_id, account_id), so one Discord identity legitimately holds
 * several accounts -- an administrator who is also a player. `.maybeSingle()`
 * ERRORS on that rather than picking one, so every command here threw for the
 * identity that already has two. Only ACTIVE accounts count, and a tie is never
 * broken silently: silently picking is how an admin's command lands on their
 * player account.
 */
async function resolveLinkedAccount(discordUserId) {
  const { data: links, error: linkError } = await supabase
    .from("discord_account_links")
    .select("account_id")
    .eq("discord_user_id", discordUserId);
  if (linkError) throw linkError;
  if (!links || links.length === 0) return null;

  const { data: accounts, error: accountError } = await supabase
    .from("accounts")
    .select("id, uid, guild, role, status")
    .in("id", links.map((l) => l.account_id));
  if (accountError) throw accountError;

  const usable = (accounts || []).filter((a) => a.status === "active" && a.uid && a.guild);
  if (usable.length === 0) return null;
  if (usable.length === 1) {
    return { uid: usable[0].uid, guild: usable[0].guild, accountId: usable[0].id };
  }
  return {
    ambiguous: usable
      .map((a) => ({ id: a.id, guild: a.guild, role: a.role, uid: a.uid }))
      .sort((a, b) => a.guild.localeCompare(b.guild)),
  };
}

/**
 * Replies asking which linked account to act as, and returns true when it did.
 * Every caller of resolveLinkedAccount goes through this, so no command has to
 * remember the ambiguous shape.
 */
async function askWhichAccount(interaction, linked) {
  if (!linked || !linked.ambiguous) return false;
  const list = linked.ambiguous.map((a) => `• **${a.guild}** — \`${a.id}\` (${a.role})`).join("\n");
  await interaction.reply({
    content:
      `Your Discord account is linked to **${linked.ambiguous.length}** player accounts, so I don't know which one you mean:\n${list}\n` +
      `Use the one you want in the app, or ask an admin to unlink the other.`,
    ephemeral: true,
  });
  return true;
}

function formatPlayerLocalTime(offset) {
  if (offset === null || offset === undefined || offset === "") return null;
  const n = Number(offset);
  if (!Number.isFinite(n)) return null;
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const target = new Date(utc + n * 3600000);
  const hh = String(target.getUTCHours()).padStart(2, "0");
  const mm = String(target.getUTCMinutes()).padStart(2, "0");
  const sign = n >= 0 ? "+" : "";
  return `${hh}:${mm} (UTC${sign}${n})`;
}

async function getPlayerActiveAbsence(uid, guild) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await supabase
      .from("player_absences")
      .select("start_date, end_date, note")
      .eq("uid", uid)
      .eq("guild", guild)
      .lte("start_date", today)
      .gte("end_date", today)
      .maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

function randomLinkCode() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function handleLink(interaction) {
  const discordUserId = interaction.user.id;
  const discordUsername = interaction.user.username;
  const code = randomLinkCode();

  // Invalidate any previously pending code for this user
  await supabase.from("discord_link_codes").delete().eq("discord_user_id", discordUserId);
  const { error } = await supabase.from("discord_link_codes").insert({
    code,
    discord_user_id: discordUserId,
    discord_username: discordUsername || null,
  });

  if (error) {
    console.error("Failed to create discord_link_codes row:", error.message);
    await interaction.reply({
      content: "❌ Something went wrong generating your link code. Please try again.",
      ephemeral: true,
    });
    return;
  }

  const embed = {
    color: 0x3b82f6,
    title: "🔗 Link Your Discord Account",
    description:
      `Your link code is: **\`${code}\`**\n\n` +
      `⏱️ *This code expires in 10 minutes.*\n\n` +
      `**How to complete linking:**\n` +
      `1. Open the FGF Guild Management web app.\n` +
      `2. Go to **Player Portal** ➔ **My Info** ➔ **Link Discord**.\n` +
      `3. Enter the code **\`${code}\`** and confirm to link your player profile!`,
    footer: { text: "FGF Guild Management • Account Link" },
    timestamp: new Date().toISOString(),
  };

  await interaction.reply({
    embeds: [embed],
    ephemeral: true,
  });
}

async function handleMyInfo(interaction) {
  const linked = await resolveLinkedAccount(interaction.user.id);
  if (!linked) {
    await interaction.reply({
      content: "Your Discord account isn't linked yet. Run `/link` first, then enter the code in the Player Portal (**My Info** ➔ **Link Discord**).",
      ephemeral: true,
    });
    return;
  }
  if (await askWhichAccount(interaction, linked)) return;

  const { data: member, error: memberErr } = await supabase
    .from("guild_members")
    .select("pseudo, overall_power, glory_score, role, fleet_rating, tech_power, timezone_offset")
    .eq("guild", linked.guild)
    .eq("uid", linked.uid)
    .maybeSingle();

  if (memberErr || !member) {
    await interaction.reply({
      content: "Couldn't find your roster entry. Your guild officer may need to re-scan the roster.",
      ephemeral: true,
    });
    return;
  }

  const localTime = formatPlayerLocalTime(member.timezone_offset);
  const tzStr = timezoneLabel(member.timezone_offset);

  const embed = {
    title: `👤 ${member.pseudo} — [${linked.guild}]`,
    color: 0x6366f1,
    fields: [
      { name: "Overall Power", value: formatNumber(member.overall_power), inline: true },
      { name: "Glory Score", value: formatNumber(member.glory_score), inline: true },
      { name: "Role", value: member.role || "—", inline: true },
      { name: "Fleet Rating", value: formatNumber(member.fleet_rating), inline: true },
      { name: "Tech Power", value: formatNumber(member.tech_power), inline: true },
      { name: "Timezone", value: localTime ? `${tzStr} (${localTime})` : tzStr, inline: true },
    ],
    footer: { text: "FGF Guild Management • Player Portal" },
    timestamp: new Date().toISOString(),
  };

  await interaction.reply({
    embeds: [embed],
    ephemeral: true,
  });
}

const PROFILE_FIELDS = "pseudo, guild, role, overall_power, fleet_rating, tech_power, flagship_power, champion_power, crew_power, glory_score, timezone_offset, uid";

async function handleProfile(interaction) {
  const targetUser = interaction.options.getUser("user");
  const ingameName = interaction.options.getString("ingame_name");

  if (!targetUser && !ingameName) {
    await interaction.reply({
      content: "Provide a Discord **user** or an in-game **name** to look up.",
      ephemeral: true,
    });
    return;
  }

  let member = null;
  let note = null;

  if (targetUser) {
    const linked = await resolveLinkedAccount(targetUser.id);
    if (!linked) {
      await interaction.reply({
        content: `<@${targetUser.id}> has no linked FGF account yet. They must run \`/link\` and confirm it in the Player Portal first.`,
        ephemeral: true,
      });
      return;
    }
    if (linked.ambiguous) {
      await interaction.reply({
        content: `<@${targetUser.id}> has ${linked.ambiguous.length} linked player accounts, so I can't tell which roster entry you mean. Search by in-game name instead: \`/profile ingame_name:<pseudo>\`.`,
        ephemeral: true,
      });
      return;
    }
    const { data, error } = await supabase
      .from("guild_members")
      .select(PROFILE_FIELDS)
      .eq("uid", linked.uid)
      .eq("guild", linked.guild)
      .maybeSingle();
    if (error) throw error;
    member = data;
  } else {
    const { data, error } = await supabase
      .from("guild_members")
      .select(PROFILE_FIELDS)
      .ilike("pseudo", ingameName.trim())
      .limit(4);
    if (error) throw error;
    if (data && data.length > 1) {
      note = `Several players share that name — showing the first match.`;
    }
    member = (data && data[0]) || null;
  }

  if (!member) {
    await interaction.reply({
      content: targetUser
        ? `<@${targetUser.id}>'s linked account has no roster entry yet.`
        : `No roster entry found for **${ingameName.trim()}**.`,
      ephemeral: true,
    });
    return;
  }

  const localTime = formatPlayerLocalTime(member.timezone_offset);
  const activeAbsence = await getPlayerActiveAbsence(member.uid, member.guild);
  const statusValue = activeAbsence
    ? `🔴 Absent until ${activeAbsence.end_date}${activeAbsence.note ? ` (${activeAbsence.note})` : ""}`
    : "🟢 Active";

  const fields = [
    { name: "Role", value: member.role || "—", inline: true },
    { name: "Status", value: statusValue, inline: true },
    { name: "Overall Power", value: formatNumber(member.overall_power), inline: true },
    { name: "Fleet", value: formatNumber(member.fleet_rating), inline: true },
    { name: "Tech", value: formatNumber(member.tech_power), inline: true },
    { name: "Flagship", value: formatNumber(member.flagship_power), inline: true },
    { name: "Champs", value: formatNumber(member.champion_power), inline: true },
    { name: "Crew", value: formatNumber(member.crew_power), inline: true },
    { name: "Timezone", value: timezoneLabel(member.timezone_offset), inline: true },
  ];
  if (localTime) {
    fields.push({ name: "Local Time", value: localTime, inline: true });
  }

  const embed = {
    color: 0x6366f1,
    title: `${member.pseudo} — ${member.guild}`,
    fields,
  };
  await interaction.reply({ embeds: [embed], content: note || "" });
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE_REGEX.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

async function handleAbsent(interaction) {
  const startDate = interaction.options.getString("start_date");
  const endDate = interaction.options.getString("end_date");
  const reason = interaction.options.getString("reason");

  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
    await interaction.reply({
      content: "Dates must be valid **YYYY-MM-DD** values (e.g. 2026-09-13).",
      ephemeral: true,
    });
    return;
  }
  if (endDate < startDate) {
    await interaction.reply({
      content: "The **end date** must be on or after the **start date**.",
      ephemeral: true,
    });
    return;
  }

  const linked = await resolveLinkedAccount(interaction.user.id);
  if (!linked) {
    await interaction.reply({
      content: "Your Discord account isn't linked yet. Run `/link`, then confirm the code in the Player Portal (My Info -> Link Discord).",
      ephemeral: true,
    });
    return;
  }
  if (await askWhichAccount(interaction, linked)) return;

  const { data: member, error: memberError } = await supabase
    .from("guild_members")
    .select("pseudo")
    .eq("guild", linked.guild)
    .eq("uid", linked.uid)
    .maybeSingle();
  if (memberError) throw memberError;
  if (!member) {
    await interaction.reply({
      content: "No roster entry found for your linked account. Your guild admin may need to re-scan the roster.",
      ephemeral: true,
    });
    return;
  }

  const { data, error } = await supabase.rpc("gm_upsert_player_absence", {
    p_guild: linked.guild,
    p_pseudo: member.pseudo,
    p_uid: linked.uid,
    p_id: null,
    p_start_date: startDate,
    p_end_date: endDate,
    p_kind: "full",
    p_note: reason || null,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.ok) {
    await interaction.reply({
      content: `Couldn't save your absence (${row?.error || "unknown error"}). Please try again.`,
      ephemeral: true,
    });
    return;
  }

  const suffix = reason ? ` Reason: ${reason}` : "";
  await interaction.reply({
    content: `Absence recorded for **${linked.guild}** from **${startDate}** to **${endDate}**.${suffix}`,
    ephemeral: true,
  });

  const auditChannelId = auditChannelByGuild.get(linked.guild);
  if (auditChannelId && interaction.guild) {
    await postOfficerAbsenceAlert(interaction.guild, auditChannelId, member.pseudo, linked.guild, startDate, endDate, reason);
  }
}

async function handleTop(interaction) {
  const category = interaction.options.getString("category") || "power";
  let fgfGuild = channelToGuild.get(interaction.channelId);

  if (!fgfGuild) {
    const linked = await resolveLinkedAccount(interaction.user.id).catch(() => null);
    // An ambiguous link resolves no single guild, so it resolves nothing here.
    if (linked && linked.guild) fgfGuild = linked.guild;
  }

  if (!fgfGuild) {
    await interaction.reply({
      content: "Could not determine your guild. Run `/link` first or use this command in a designated guild channel.",
      ephemeral: true,
    });
    return;
  }

  let orderCol = "overall_power";
  let title = `🏆 Top Overall Power — ${fgfGuild}`;
  let valueFormatter = (m) => formatNumber(m.overall_power);

  if (category === "glory") {
    orderCol = "glory_score";
    title = `🏆 Top Glory Score — ${fgfGuild}`;
    valueFormatter = (m) => formatNumber(m.glory_score);
  } else if (category === "fleet") {
    orderCol = "fleet_rating";
    title = `🏆 Top Fleet Rating — ${fgfGuild}`;
    valueFormatter = (m) => formatNumber(m.fleet_rating);
  }

  const { data: members, error } = await supabase
    .from("guild_members")
    .select("pseudo, overall_power, glory_score, fleet_rating, role")
    .eq("guild", fgfGuild)
    .order(orderCol, { ascending: false, nullsFirst: false })
    .limit(10);

  if (error || !members || members.length === 0) {
    await interaction.reply({
      content: `No roster members found for **${fgfGuild}**.`,
      ephemeral: true,
    });
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = members.map((m, idx) => {
    const badge = idx < 3 ? medals[idx] : `\`${String(idx + 1).padStart(2, " ")}.\``;
    const roleTag = m.role ? `[${m.role}]` : "";
    return `${badge} **${m.pseudo}** ${roleTag} — ${valueFormatter(m)}`;
  });

  const embed = {
    color: 0x6366f1,
    title,
    description: lines.join("\n"),
    footer: { text: `FGF Guild Management • Top ${members.length} members shown` },
    timestamp: new Date().toISOString(),
  };

  await interaction.reply({ embeds: [embed] });
}

async function handleAbsences(interaction) {
  const scope = interaction.options.getString("scope");
  let fgfGuild = channelToGuild.get(interaction.channelId);

  if (!fgfGuild) {
    const linked = await resolveLinkedAccount(interaction.user.id).catch(() => null);
    // An ambiguous link resolves no single guild, so it resolves nothing here.
    if (linked && linked.guild) fgfGuild = linked.guild;
  }

  if (!fgfGuild) {
    await interaction.reply({
      content: "Could not determine your guild. Run `/link` first or use this command in a designated guild channel.",
      ephemeral: true,
    });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const next7Days = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  let query = supabase.from("player_absences").select("pseudo, start_date, end_date, note, kind").eq("guild", fgfGuild);

  if (scope === "today") {
    query = query.lte("start_date", today).gte("end_date", today);
  } else {
    query = query.gt("start_date", today).lte("start_date", next7Days);
  }

  const { data: rows, error } = await query.order("start_date", { ascending: true });

  if (error) {
    await interaction.reply({ content: "Error fetching absences. Please try again later.", ephemeral: true });
    return;
  }

  const title = scope === "today"
    ? `📅 Guild Absences Today (${today}) — ${fgfGuild}`
    : `📅 Upcoming Guild Absences (Next 7 Days) — ${fgfGuild}`;

  if (!rows || rows.length === 0) {
    const embed = {
      color: 0x22c55e,
      title,
      description: scope === "today"
        ? "✅ No members are currently marked absent today!"
        : "✅ No upcoming absences recorded for the next 7 days.",
      timestamp: new Date().toISOString(),
    };
    await interaction.reply({ embeds: [embed] });
    return;
  }

  const lines = rows.map((r) => {
    const note = r.note ? ` — *"${r.note}"*` : "";
    return `• **${r.pseudo}**: \`${r.start_date}\` to \`${r.end_date}\`${note}`;
  });

  const embed = {
    color: 0xf59e0b,
    title,
    description: lines.join("\n"),
    footer: { text: `Total absent: ${rows.length}` },
    timestamp: new Date().toISOString(),
  };

  await interaction.reply({ embeds: [embed] });
}

// In-memory call to arms state tracker
const ctaSessions = new Map();

function buildCtaEmbed(session) {
  const present = Array.from(session.present.values());
  const late = Array.from(session.late.values());
  const absent = Array.from(session.absent.values());

  const totalPower = present.reduce((acc, p) => acc + (Number(p.power) || 0), 0);
  const totalFleet = present.reduce((acc, p) => acc + (Number(p.fleet) || 0), 0);

  const presentText = present.length > 0
    ? present.slice(0, 15).map((p) => `• **${p.pseudo}** (${formatNumber(p.power)})`).join("\n") + (present.length > 15 ? `\n*...and ${present.length - 15} more*` : "")
    : "—";

  const lateText = late.length > 0
    ? late.slice(0, 10).map((p) => `• **${p.pseudo}**`).join("\n") + (late.length > 10 ? `\n*...and ${late.length - 10} more*` : "")
    : "—";

  const absentText = absent.length > 0
    ? absent.slice(0, 10).map((p) => `• **${p.pseudo}**`).join("\n") + (absent.length > 10 ? `\n*...and ${absent.length - 10} more*` : "")
    : "—";

  return {
    color: 0x6366f1,
    title: `⚔️ Call to Arms: ${session.eventName}`,
    description: session.description
      ? `${session.description}\n\n**Click a button below to declare your attendance:**`
      : "**Click a button below to declare your attendance for this battle:**",
    fields: [
      { name: `🟢 Present (${present.length})`, value: presentText, inline: false },
      { name: `🟡 Late (${late.length})`, value: lateText, inline: true },
      { name: `🔴 Absent (${absent.length})`, value: absentText, inline: true },
      {
        name: "⚡ Mobilized Combat Power",
        value: `**Total Power:** ${formatNumber(totalPower)}\n**Total Fleet Rating:** ${formatNumber(totalFleet)}`,
        inline: false,
      },
    ],
    footer: { text: "FGF War Coordination • Live Battle Check-In" },
    timestamp: new Date().toISOString(),
  };
}

function buildCtaComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("cta_present")
        .setLabel("Present")
        .setStyle(ButtonStyle.Success)
        .setEmoji("🟢"),
      new ButtonBuilder()
        .setCustomId("cta_late")
        .setLabel("Late (15-30m)")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🟡"),
      new ButtonBuilder()
        .setCustomId("cta_absent")
        .setLabel("Absent")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("🔴")
    ),
  ];
}

async function handleCallToArms(interaction) {
  const eventName = interaction.options.getString("event_name");
  const description = interaction.options.getString("description") || null;

  const session = {
    eventName,
    description,
    present: new Map(),
    late: new Map(),
    absent: new Map(),
  };

  const reply = await interaction.reply({
    embeds: [buildCtaEmbed(session)],
    components: buildCtaComponents(),
    fetchReply: true,
  });

  ctaSessions.set(reply.id, session);
}

async function handleCtaButton(interaction) {
  const messageId = interaction.message.id;
  let session = ctaSessions.get(messageId);

  if (!session) {
    const title = interaction.message.embeds?.[0]?.title || "⚔️ Call to Arms";
    const eventName = title.replace("⚔️ Call to Arms: ", "").trim();
    session = {
      eventName,
      description: null,
      present: new Map(),
      late: new Map(),
      absent: new Map(),
    };
    ctaSessions.set(messageId, session);
  }

  const userId = interaction.user.id;
  session.present.delete(userId);
  session.late.delete(userId);
  session.absent.delete(userId);

  let pseudo = interaction.member?.nickname || interaction.user.username;
  let power = 0;
  let fleet = 0;

  const linked = await resolveLinkedAccount(userId).catch(() => null);
  if (linked && linked.guild) {
    const { data: member } = await supabase
      .from("guild_members")
      .select("pseudo, overall_power, fleet_rating")
      .eq("uid", linked.uid)
      .eq("guild", linked.guild)
      .maybeSingle();
    if (member) {
      pseudo = member.pseudo;
      power = Number(member.overall_power) || 0;
      fleet = Number(member.fleet_rating) || 0;
    }
  }

  const entry = { pseudo, power, fleet };
  const action = interaction.customId;

  if (action === "cta_present") {
    session.present.set(userId, entry);
  } else if (action === "cta_late") {
    session.late.set(userId, entry);
  } else if (action === "cta_absent") {
    session.absent.set(userId, entry);
  }

  await interaction.message.edit({
    embeds: [buildCtaEmbed(session)],
    components: buildCtaComponents(),
  });

  const label = action === "cta_present" ? "🟢 Present" : action === "cta_late" ? "🟡 Late" : "🔴 Absent";
  await interaction.reply({
    content: `You have been registered as **${label}** (${pseudo}).`,
    ephemeral: true,
  });
}

/**
 * /mystats -- one player's attendance, on the app's own definition.
 *
 * Built on `gm_player_stats`, which is the only stats RPC a service-role caller
 * can reach: `gm_stats_weeks`, `gm_stats_members`, `gm_stats_health` and
 * `gm_stats_events` all gate on `gm_can_read_guild_data`, which returns false
 * when there is no `auth.uid()`. It returns no peer rows and computes no rank by
 * design, so a player cannot read a guildmate through it.
 *
 * It deliberately shows att/opp per event type and the guild's pooled rate, and
 * computes NO weighted score. The weighting lives in
 * src/core/scoring/reliability.ts, shared by the admin page and the Portal; a
 * third copy in this Node process is exactly how those two came to disagree in
 * the first place. The bot reports the same counts and lets the app do the
 * weighting.
 */
async function handleMyStats(interaction) {
  const linked = await resolveLinkedAccount(interaction.user.id);
  if (!linked) {
    await interaction.reply({
      content: "Your Discord account isn't linked yet. Run `/link` first, then confirm the code in the Player Portal (My Info ➔ Link Discord).",
      ephemeral: true,
    });
    return;
  }
  if (await askWhichAccount(interaction, linked)) return;

  const { data: member, error: memberErr } = await supabase
    .from("guild_members")
    .select("pseudo")
    .eq("guild", linked.guild)
    .eq("uid", linked.uid)
    .maybeSingle();
  if (memberErr || !member) {
    await interaction.reply({ content: "No roster entry found for your linked account.", ephemeral: true });
    return;
  }

  // Bounded here as well as inside the function (AGENTS rule 3).
  const requested = interaction.options.getInteger("weeks");
  const weeks = Math.min(Math.max(requested ?? 4, 1), 26);

  const { data, error } = await supabase.rpc("gm_player_stats", {
    p_guild: linked.guild,
    p_pseudo: member.pseudo,
    p_weeks: weeks,
  });
  if (error || !data || data.ok !== true) {
    await interaction.reply({
      content: `Couldn't read your stats: ${error ? error.message : (data && data.error) || "no data"}.`,
      ephemeral: true,
    });
    return;
  }

  const playerBuckets = data.player?.buckets || {};
  const guildBuckets = data.guild_totals?.buckets || {};
  const names = [...new Set([...Object.keys(playerBuckets), ...Object.keys(guildBuckets)])].sort();

  const pct = (att, opp) => (opp > 0 ? `${Math.round((att / opp) * 100)}%` : "—");
  const lines = names.map((b) => {
    const mine = playerBuckets[b] || { att: 0, opp: 0, exc: 0 };
    const theirs = guildBuckets[b] || { attendances: 0, member_opportunities: 0 };
    const excused = Number(mine.exc) > 0 ? ` · ${mine.exc} excused` : "";
    return `**${b}** — you ${mine.att}/${mine.opp} (${pct(Number(mine.att), Number(mine.opp))})` +
      ` · guild ${pct(Number(theirs.attendances), Number(theirs.member_opportunities))}${excused}`;
  });

  const glory = data.glory || {};
  const embed = {
    color: 0x6366f1,
    title: `📊 ${member.pseudo} — ${linked.guild}`,
    description: lines.length
      ? lines.join("\n")
      : "No sessions recorded in that window yet.",
    fields: [
      { name: "Weeks counted", value: String(data.weeks ?? weeks), inline: true },
      { name: "Roster size", value: String(data.guild_totals?.roster_size ?? "—"), inline: true },
      { name: "Best Glory week", value: formatNumber(glory.best), inline: true },
    ],
    footer: {
      text: "Attendance = participated or stood in as a sub. Glory and unapproved scores excluded, " +
        "the same rule your admin page and the Portal use. Your guild's figure is pooled across every member's own opportunities.",
    },
    timestamp: new Date().toISOString(),
  };

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/**
 * /verifications -- the held verifications an officer would otherwise never see.
 *
 * ADR-020 writes a `discord_verification_refused` audit row for every refusal,
 * but `system_audit_logs` is readable in the app by super_admin ONLY, so a
 * guild_admin has no way to learn that someone is waiting. This is that view.
 *
 * Three guards: the guild comes from the verification-channel map or the
 * caller's own linked account and NEVER from a command option; Discord's own
 * ManageMessages permission gates the command (the permission the provisioner
 * grants an R4), so there is no coupling to app roles; the reply is ephemeral and
 * the row count is bounded.
 */
async function handleVerifications(interaction) {
  const days = Math.min(Math.max(interaction.options.getInteger("days") ?? 7, 1), 30);

  let fgfGuild = channelToGuild.get(interaction.channelId);
  if (!fgfGuild) {
    const linked = await resolveLinkedAccount(interaction.user.id).catch(() => null);
    if (linked && linked.guild) fgfGuild = linked.guild;
  }
  if (!fgfGuild) {
    await interaction.reply({
      content: "Could not determine which guild you mean. Run this in a channel configured for verification, or link your account with `/link`.",
      ephemeral: true,
    });
    return;
  }

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase
    .from("system_audit_logs")
    .select("created_at, pseudo, uid, message, metadata")
    .eq("guild", fgfGuild)
    .eq("action_type", "discord_verification_refused")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    await interaction.reply({ content: `Couldn't read the verification log: ${error.message}`, ephemeral: true });
    return;
  }

  const rows = data || [];
  if (rows.length === 0) {
    await interaction.reply({
      content: `✅ No held verifications for **${fgfGuild}** in the last ${days} day(s).`,
      ephemeral: true,
    });
    return;
  }

  const reasonLabel = {
    absent: "not on the roster",
    pseudo_conflict: "pseudo already on file under a different UID",
    ambiguous_pseudo: "several roster entries share that pseudo",
    scan_truncated: "roster read failed — retry",
  };

  const lines = rows.map((r) => {
    const m = r.metadata || {};
    const reason = reasonLabel[m.reason] || m.reason || "refused";
    const others = Array.isArray(m.other_guilds) && m.other_guilds.length
      ? ` · also on ${m.other_guilds.join(", ")}`
      : "";
    const who = m.discord_user_id ? `<@${m.discord_user_id}>` : "unknown Discord user";
    return `• **${r.pseudo}** (UID \`${r.uid}\`) — ${reason}${others}\n  ${who} · ${String(r.created_at).slice(0, 16).replace("T", " ")}`;
  });

  await interaction.reply({
    embeds: [{
      color: 0x3b82f6,
      title: `⏳ Held verifications — ${fgfGuild}`,
      description: lines.join("\n"),
      footer: { text: `Last ${days} day(s), newest first, up to 20. Add the player in the Guild Management tool, then ask them to post their screenshot again.` },
      timestamp: new Date().toISOString(),
    }],
    ephemeral: true,
    // Never ping the players being listed.
    allowedMentions: { parse: [] },
  });
}

/** Same rule as the Edge Function's normalizeTag: strip brackets, trim, upper. */
function normalizeTag(raw) {
  return (raw || "").replace(/[[\]]/g, "").trim().toUpperCase();
}

const pendingReconciles = new Map();

/**
 * /reconcile-roles -- who still holds the guild role without a roster row.
 *
 * ADR-020 stops the role being GRANTED wrongly; it says nothing about someone who
 * held it legitimately and then left the guild. This is that gap, and it is a
 * report first: the removal only happens behind a confirmation button, only ever
 * takes the tag role off, and never kicks anybody.
 *
 * Identity, in order: the player's linked account, else the `[TAG] Pseudo #Server`
 * nickname this bot wrote itself. Someone the bot cannot identify is listed as
 * "unidentified" and is NEVER touched -- guessing there would remove the role of
 * a member whose nickname an officer happened to edit.
 */
async function handleReconcileRoles(interaction) {
  if (!interaction.guild) {
    await interaction.reply({ content: "❌ This command only works inside a Discord server.", ephemeral: true });
    return;
  }
  if (!MEMBERS_INTENT_ENABLED) {
    await interaction.reply({
      content:
        "❌ I can't list who holds a role yet: that needs Discord's **Server Members Intent**, which is privileged.\n" +
        "1. Discord Developer Portal ➔ your application ➔ **Bot** ➔ enable **Server Members Intent**.\n" +
        "2. On Render, set `DISCORD_GUILD_MEMBERS_INTENT=true` and restart the worker.\n" +
        "I deliberately do not request it by default: declaring it while the toggle is off makes me fail to log in entirely.",
      ephemeral: true,
    });
    return;
  }

  let fgfGuild = channelToGuild.get(interaction.channelId);
  if (!fgfGuild) {
    const linked = await resolveLinkedAccount(interaction.user.id).catch(() => null);
    if (linked && linked.guild) fgfGuild = linked.guild;
  }
  if (!fgfGuild) {
    await interaction.reply({
      content: "Could not determine which guild you mean. Run this in a channel configured for verification, or link your account with `/link`.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const { data: tagRow } = await supabase
    .from("guild_config")
    .select("value")
    .eq("guild", fgfGuild)
    .eq("key", "guild_tag")
    .maybeSingle();
  const tagDisplay = (tagRow?.value || "").trim() || `[${fgfGuild}]`;
  const wanted = normalizeTag(tagDisplay);

  const role = interaction.guild.roles.cache.find((r) => normalizeTag(r.name) === wanted);
  if (!role) {
    await interaction.editReply({
      content: `No role on this server matches **${fgfGuild}**'s tag \`${tagDisplay}\`. Nothing to reconcile.`,
    });
    return;
  }

  let holders;
  try {
    await interaction.guild.members.fetch();
    holders = [...role.members.values()];
  } catch (e) {
    await interaction.editReply({ content: `Couldn't list the members holding **${role.name}**: ${e.message}` });
    return;
  }

  const { data: roster, error: rosterErr } = await supabase
    .from("guild_members")
    .select("pseudo, uid")
    .eq("guild", fgfGuild)
    .limit(5000);
  if (rosterErr) {
    await interaction.editReply({ content: `Couldn't read the **${fgfGuild}** roster: ${rosterErr.message}` });
    return;
  }
  const rosterRows = roster || [];
  // A truncated roster read would report real members as strangers, so refuse.
  if (rosterRows.length >= 5000) {
    await interaction.editReply({ content: "The roster read came back truncated, so I won't report anyone as missing from it." });
    return;
  }
  const byUid = new Set(rosterRows.map((r) => (r.uid || "").trim()).filter(Boolean));
  const byPseudo = new Set(rosterRows.map((r) => (r.pseudo || "").normalize("NFKC").trim().toLowerCase()));

  const orphans = [];
  const unidentified = [];

  for (const member of holders) {
    const linked = await resolveLinkedAccount(member.id).catch(() => null);
    if (linked && linked.guild === fgfGuild && byUid.has((linked.uid || "").trim())) continue;

    // The nickname this bot writes is "[TAG] Pseudo #Server".
    const nick = member.nickname || member.user.username || "";
    const m = nick.match(/^\[[^\]]+\]\s+(.+?)(?:\s+#\d+)?$/);
    const pseudo = m ? m[1].trim() : null;

    if (linked && linked.guild && linked.guild !== fgfGuild) {
      orphans.push({ member, pseudo: pseudo || nick, why: `linked to ${linked.guild}` });
      continue;
    }
    if (!pseudo) {
      unidentified.push({ member, nick });
      continue;
    }
    if (!byPseudo.has(pseudo.normalize("NFKC").toLowerCase())) {
      orphans.push({ member, pseudo, why: "not on the roster" });
    }
  }

  if (orphans.length === 0) {
    await interaction.editReply({
      content:
        `✅ All ${holders.length} holder(s) of **${role.name}** are on the **${fgfGuild}** roster.` +
        (unidentified.length ? `\n\n⚠️ ${unidentified.length} I could not identify (no linked account and a nickname I did not write): ${unidentified.map((u) => `\`${u.nick}\``).join(", ")}. I never touch those.` : ""),
    });
    return;
  }

  const reconcileId = `${interaction.guild.id}_${Date.now()}`;
  pendingReconciles.set(reconcileId, {
    initiatorId: interaction.user.id,
    guildId: interaction.guild.id,
    roleId: role.id,
    roleName: role.name,
    fgfGuild,
    memberIds: orphans.map((o) => o.member.id),
  });
  setTimeout(() => pendingReconciles.delete(reconcileId), 10 * 60 * 1000);

  const list = orphans
    .slice(0, 25)
    .map((o) => `• **${o.pseudo}** — <@${o.member.id}> (${o.why})`)
    .join("\n");

  await interaction.editReply({
    embeds: [{
      color: 0xf59e0b,
      title: `🧹 ${orphans.length} holder(s) of ${role.name} are not on the ${fgfGuild} roster`,
      description: list + (orphans.length > 25 ? `\n… and ${orphans.length - 25} more.` : ""),
      footer: {
        text: unidentified.length
          ? `${unidentified.length} more could not be identified and will not be touched. Removing takes off ${role.name} only — nobody is kicked.`
          : `Removing takes off ${role.name} only — nobody is kicked.`,
      },
      timestamp: new Date().toISOString(),
    }],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`reconcile_confirm_${reconcileId}`).setLabel(`Remove ${role.name} from ${orphans.length}`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`reconcile_cancel_${reconcileId}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      ),
    ],
    allowedMentions: { parse: [] },
  });
}

async function handleReconcileButton(interaction) {
  const cancel = interaction.customId.startsWith("reconcile_cancel_");
  const reconcileId = interaction.customId.replace(/^reconcile_(confirm|cancel)_/, "");
  const pending = pendingReconciles.get(reconcileId);

  if (!pending) {
    await interaction.update({ content: "This reconciliation has expired. Run `/reconcile-roles` again.", embeds: [], components: [] });
    return;
  }
  // Only whoever asked may act on it, same rule as /setup-server's confirmation.
  if (interaction.user.id !== pending.initiatorId) {
    await interaction.reply({ content: "Only the officer who ran the command can confirm it.", ephemeral: true });
    return;
  }
  if (cancel) {
    pendingReconciles.delete(reconcileId);
    await interaction.update({ content: "Cancelled. No roles were changed.", embeds: [], components: [] });
    return;
  }

  pendingReconciles.delete(reconcileId);
  await interaction.update({ content: `Removing **${pending.roleName}** from ${pending.memberIds.length} member(s)…`, embeds: [], components: [] });

  let removed = 0;
  const failed = [];
  for (const id of pending.memberIds) {
    try {
      const member = await interaction.guild.members.fetch(id);
      await member.roles.remove(pending.roleId, `FGF roster reconciliation by ${interaction.user.tag}`);
      removed += 1;
    } catch (e) {
      failed.push(`<@${id}> (${e.message})`);
    }
  }

  await interaction.editReply({
    content:
      `✅ Removed **${pending.roleName}** from **${removed}** member(s).` +
      (failed.length ? `\n⚠️ Could not change ${failed.length}: ${failed.slice(0, 5).join(", ")}. Check my role sits above **${pending.roleName}** in Server Settings ➔ Roles.` : "") +
      `\nNobody was kicked and no other role was touched.`,
    allowedMentions: { parse: [] },
  });
}

const pendingSetups = new Map();



function generateProgressBar(percent) {
  const totalBars = 16;
  const clamped = Math.min(100, Math.max(0, percent));
  const filledBars = Math.round((clamped / 100) * totalBars);
  const emptyBars = Math.max(0, totalBars - filledBars);
  return `[${"█".repeat(filledBars)}${"░".repeat(emptyBars)}] ${clamped}%`;
}

async function handleSetupServer(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "❌ This command can only be run inside a Discord server.",
      ephemeral: true,
    });
    return;
  }

  // Permission check: Discord Administrator
  const isGuildOwner = interaction.guild.ownerId === interaction.user.id;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || isGuildOwner;
  if (!isAdmin) {
    await interaction.reply({
      content: "❌ You must have **Administrator** permissions on this Discord server to use `/setup-server`.",
      ephemeral: true,
    });
    return;
  }

  const rawGuild = interaction.options.getString("guild", true).trim().toUpperCase();
  const rawServer = interaction.options.getString("server_number");
  const cleanMode = interaction.options.getBoolean("clean_mode") || false;

  // `guilds` has no `name` column in production -- selecting it answered 42703,
  // so guildRow was null for EVERY guild and the two fallbacks below turned a
  // typo into 31 channels provisioned for a tenant that does not exist, on a
  // server number nobody had ever entered. An unresolved tenant fails visibly.
  const { data: guildRow, error: guildErr } = await supabase
    .from("guilds")
    .select("id, server_number")
    .eq("id", rawGuild)
    .maybeSingle();

  if (guildErr) {
    await interaction.reply({
      content: `❌ Could not read the guild list: ${guildErr.message}`,
      ephemeral: true,
    });
    return;
  }
  if (!guildRow) {
    await interaction.reply({
      content: `❌ Guild \`${rawGuild}\` is not registered in the Guild Management tool. Check the identifier (e.g. \`ALPHA\`, \`OMEGA\`, \`IMK\`) or create the guild in the app first — I won't build a server for a tenant that doesn't exist.`,
      ephemeral: true,
    });
    return;
  }

  const finalServerNumber = (rawServer ? rawServer.trim() : guildRow.server_number) || "";
  if (!finalServerNumber) {
    await interaction.reply({
      content: `❌ Guild \`${rawGuild}\` has no game-server number on file, and you didn't pass one. Set it in the app (Settings ➔ Guild ➔ Server Number) or re-run with \`server_number:\`. I won't invent one: the server number is what scopes guild-tag resolution and the server_admin role.`,
      ephemeral: true,
    });
    return;
  }

  // Resolve guild tag
  const { data: tagRow } = await supabase
    .from("guild_config")
    .select("value")
    .eq("guild", rawGuild)
    .eq("key", "guild_tag")
    .maybeSingle();

  const finalTag = tagRow?.value?.trim() || rawGuild;
  const setupId = `${interaction.guild.id}_${Date.now()}`;

  pendingSetups.set(setupId, {
    setupId,
    guildId: interaction.guild.id,
    targetGuild: rawGuild,
    guildName: rawGuild,
    guildTag: finalTag,
    serverNumber: finalServerNumber,
    cleanMode,
    initiatorId: interaction.user.id,
    createdAt: Date.now(),
  });

  // Auto expire after 5 minutes
  setTimeout(() => pendingSetups.delete(setupId), 5 * 60 * 1000);

  const confirmEmbed = {
    color: 0xf59e0b,
    title: `⚠️ Confirm Discord Server Setup: [${rawGuild}]`,
    description:
      `You are about to bootstrap and format this Discord server for **${rawGuild}**.\n\n` +
      `**Configuration Overview:**\n` +
      `• **FGF Guild**: \`${rawGuild}\` (Tag: \`[${finalTag}]\`)\n` +
      `• **Game Server**: \`#${finalServerNumber}\`\n` +
      `• **Clean Mode**: ${cleanMode ? "⚠️ **Enabled** (All existing channels will be wiped!)" : "Disabled (Existing channels preserved)"}\n` +
      `• **Roles to Create**: 👑 \`[${finalTag}] R5\`, ⭐ \`[${finalTag}] R4\`, 🛡️ \`[${finalTag}] Member\`, 👽 \`Visitor\`\n` +
      `• **Categories**: 7 (Welcome, Visitors, Game Updates, Reminders, Server #${finalServerNumber}, Dominion, 🔴 ${rawGuild})\n` +
      `• **Channels**: 28 Text, 3 Voice with Zero-Trust permission overrides\n` +
      `• **SaaS Auto-Wiring**: Connects \`#verification\`, \`#r4-chat\`, and member role into Supabase \`guild_config\`.\n\n` +
      `*Please confirm to launch the automated provisioning pipeline.*`,
    footer: { text: "FGF Server Provisioner • Administrator Authorized" },
    timestamp: new Date().toISOString(),
  };

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`setup_confirm_${setupId}`)
      .setLabel("🚀 Confirmer et Déployer")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`setup_cancel_${setupId}`)
      .setLabel("❌ Annuler")
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({
    embeds: [confirmEmbed],
    components: [actionRow],
  });
}

async function handleSetupButton(interaction) {
  const isConfirm = interaction.customId.startsWith("setup_confirm_");
  const setupId = interaction.customId.replace(isConfirm ? "setup_confirm_" : "setup_cancel_", "");

  const pending = pendingSetups.get(setupId);
  if (!pending) {
    await interaction.reply({
      content: "This setup request has expired or was already handled.",
      ephemeral: true,
    });
    return;
  }

  // Check if clicker is initiator or admin
  const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || isGuildOwner;
  if (interaction.user.id !== pending.initiatorId && !isAdmin) {
    await interaction.reply({
      content: "Only the administrator who initiated this setup can confirm it.",
      ephemeral: true,
    });
    return;
  }

  if (!isConfirm) {
    pendingSetups.delete(setupId);
    await interaction.update({
      embeds: [
        {
          color: 0xef4444,
          title: "❌ Server Setup Cancelled",
          description: `Server formatting for guild **${pending.targetGuild}** was cancelled by <@${interaction.user.id}>.`,
        },
      ],
      components: [],
    });
    return;
  }

  pendingSetups.delete(setupId);

  let lastEditTime = 0;
  const updateProgressEmbed = async (percent, messageText) => {
    const now = Date.now();
    if (now - lastEditTime < 1500 && percent < 100 && percent > 10) return;
    lastEditTime = now;

    const progressEmbed = {
      color: percent >= 100 ? 0x22c55e : 0x3b82f6,
      title: percent >= 100 ? "✅ Server Provisioning Complete!" : "⏳ Provisioning Discord Server...",
      description:
        `Formatting server for **${pending.guildName}** (\`[${pending.guildTag}]\`):\n\n` +
        `\`${generateProgressBar(percent)}\`\n\n` +
        `**Status**: ${messageText}`,
      footer: { text: "FGF Automated Server Architect" },
      timestamp: new Date().toISOString(),
    };

    try {
      await interaction.editReply({
        embeds: [progressEmbed],
        components: [],
      });
    } catch (err) {
      console.warn("Could not edit progress embed:", err.message);
    }
  };

  await interaction.update({
    embeds: [
      {
        color: 0x3b82f6,
        title: "⏳ Initializing Server Provisioning...",
        description: `Starting bootstrap for **${pending.guildName}**...\n\n\`${generateProgressBar(5)}\``,
      },
    ],
    components: [],
  });

  const res = await provisionDiscordServer(
    interaction.guild,
    {
      guildName: pending.targetGuild,
      guildTag: pending.guildTag,
      serverNumber: pending.serverNumber,
      cleanMode: pending.cleanMode,
    },
    {
      supabase,
      onProgress: updateProgressEmbed,
    }
  );

  if (!res.ok) {
    await interaction.editReply({
      embeds: [
        {
          color: 0xef4444,
          title: "❌ Server Provisioning Failed",
          description: `An error occurred during server formatting: \`${res.error}\`\nPlease verify that the bot has Administrator permissions and is placed at the top of the role hierarchy.`,
        },
      ],
      components: [],
    });
    return;
  }

  await refreshChannelMap();
  await refreshMemberRoleMap();
  await refreshAuditChannelMap();

  const successEmbed = {
    color: 0x22c55e,
    title: `🎉 Server Successfully Formatted for ${pending.targetGuild}!`,
    description:
      `The server structure has been created and customized for **${pending.guildName}**.\n\n` +
      `**Summary:**\n` +
      `• **Roles Created**: ${res.createdCounts.roles}\n` +
      `• **Categories**: ${res.createdCounts.categories}\n` +
      `• **Channels**: ${res.createdCounts.channels}\n` +
      `• **Verification Channel**: <#${res.autoWired.verificationChannelId || "unknown"}>\n` +
      `• **Audit / Officers Channel**: <#${res.autoWired.auditChannelId || "unknown"}>\n` +
      `• **Verification Roles**: \`[PENDING]\`, \`[VISITOR]\` and the guild tag role — drag my own role **above** all three in Server Settings ➜ Roles, or I cannot assign them.\n\n` +
      `**SaaS Integration:**\n` +
      `✅ \`guild_config\` has been automatically updated in the Supabase database. The OCR verification engine and absence notifications are now live for this server.\n` +
      `ℹ️ The roster gate is **off** for this guild: a verified screenshot will still create the roster entry. Turn it on in the app (Admin ➜ Discord Notifications ➜ Player Verification) to require an existing member-list entry before the guild role is granted.`,
    footer: { text: "FGF Guild Management • Server Architect" },
    timestamp: new Date().toISOString(),
  };

  await interaction.editReply({
    embeds: [successEmbed],
    components: [],
  });
}

async function sendVerificationDm(author, result, fgfGuild) {
  try {
    const isGuildMember = result.role === "guild_member";
    const isPending = result.role === "pending";
    // Three outcomes, three messages. A recruit the roster does not know yet is
    // NOT a visitor, and must not be told they are one (ADR-020).
    const color = isGuildMember ? 0x22c55e : isPending ? 0x3b82f6 : 0xf59e0b;
    const title = isGuildMember
      ? `🎉 Welcome to ${fgfGuild}! Profile Verified`
      : isPending
        ? `⏳ Verification held — waiting on an officer`
        : `👋 Welcome! Assigned Visitor Role`;
    const description = isGuildMember
      ? `Your profile has been verified and registered into the **${fgfGuild}** roster!`
      : isPending
        ? `I read your profile, but you are not in the **${fgfGuild}** member list yet, so I can't give you the guild role. Your officers have been notified — once they add you in the Guild Management tool, post your screenshot again.`
        : `You have been assigned the **Visitor** role. Check in with guild officers if this is unexpected.`;
    const roleLabel = isGuildMember ? `Member (${fgfGuild})` : isPending ? "Pending" : "Visitor";
    const embed = {
      color,
      title,
      description,
      fields: [
        { name: "In-Game Pseudo", value: result.pseudo || "—", inline: true },
        { name: "UID", value: result.uid || "—", inline: true },
        { name: "Assigned Nickname", value: result.nickname || "—", inline: true },
        { name: "Power", value: formatNumber(result.power), inline: true },
        { name: "Total Glory", value: formatNumber(result.glory), inline: true },
        { name: "Role", value: roleLabel, inline: true },
      ],
      footer: { text: "FGF Guild Management • Use /profile or /top anytime" },
      timestamp: new Date().toISOString(),
    };
    await author.send({ embeds: [embed] });
    return true;
  } catch (e) {
    console.log(`Could not send verification DM to ${author.id}: ${e.message}`);
    return false;
  }
}

async function postVerificationAuditLog(guild, auditChannelId, author, result, fgfGuild) {
  if (!auditChannelId) return;
  try {
    const channel = await guild.channels.fetch(auditChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const status = result.role === "guild_member"
      ? (result.is_new_player ? "🆕 New Player" : result.uid_backfilled ? "🔗 UID Claimed" : "🔄 Roster Updated")
      : result.role === "pending"
        ? `⏳ Pending (${result.reason || "not on roster"})`
        : "👋 Visitor";
    const embed = {
      color: result.role === "guild_member" ? 0x6366f1 : result.role === "pending" ? 0x3b82f6 : 0xf59e0b,
      title: `📋 Verification Audit Log — ${result.pseudo}`,
      fields: [
        { name: "Discord User", value: `<@${author.id}> (${author.username})`, inline: true },
        { name: "Guild", value: fgfGuild, inline: true },
        { name: "Status", value: status, inline: true },
        { name: "UID", value: result.uid || "—", inline: true },
        { name: "Power", value: formatNumber(result.power), inline: true },
        { name: "Nickname", value: result.nickname || "—", inline: true },
      ],
      footer: { text: "FGF Verification Audit System" },
      timestamp: new Date().toISOString(),
    };
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.warn(`Failed to post audit log to ${auditChannelId}:`, e.message);
  }
}

async function postOfficerAbsenceAlert(guild, auditChannelId, pseudo, fgfGuild, startDate, endDate, reason) {
  if (!auditChannelId) return;
  try {
    const channel = await guild.channels.fetch(auditChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const embed = {
      color: 0xf59e0b,
      title: `📢 Absence Declared — ${pseudo}`,
      fields: [
        { name: "Player", value: pseudo, inline: true },
        { name: "Guild", value: fgfGuild, inline: true },
        { name: "Period", value: `${startDate} to ${endDate}`, inline: false },
        { name: "Reason", value: reason || "*No reason provided*", inline: false },
      ],
      timestamp: new Date().toISOString(),
    };
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.warn(`Failed to post absence alert to ${auditChannelId}:`, e.message);
  }
}

async function safeReplyToInteraction(interaction, content) {
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (e) {
    console.error("Failed to reply to interaction:", e);
  }
}

client.once("ready", async () => {
  console.log(`discord-verification-worker logged in as ${client.user.tag}`);
  // A successful login looks identical whether the privileged GuildMembers intent
  // was declared and accepted or never requested at all, so say which --
  // otherwise there is no way to confirm DISCORD_GUILD_MEMBERS_INTENT took
  // effect short of running /reconcile-roles and reading its refusal.
  console.log(
    MEMBERS_INTENT_ENABLED
      ? "GuildMembers intent: REQUESTED and accepted -- /reconcile-roles is available."
      : "GuildMembers intent: not requested (DISCORD_GUILD_MEMBERS_INTENT is unset) -- /reconcile-roles will explain how to enable it."
  );
  discordReady = true;
  await refreshChannelMap();
  await refreshMemberRoleMap();
  await refreshAuditChannelMap();
  await registerSlashCommands();
  setInterval(async () => {
    await refreshChannelMap();
    await refreshMemberRoleMap();
    await refreshAuditChannelMap();
  }, 5 * 60 * 1000);

  if (!(DISCORD_MEMBER_ROLE_ID || "").trim() && memberRoleByGuild.size === 0) {
    console.log("DISCORD_MEMBER_ROLE_ID not set and no guild_config fallback (discord_member_role_id) -- verified-role auto-assignment disabled.");
  } else {
    console.log("Verified-role auto-assignment enabled (DISCORD_MEMBER_ROLE_ID or guild_config fallback).");
  }
});

client.on("guildCreate", async (guild) => {
  // Deliberately does NOT register commands. It used to copy the global set into
  // this guild's scope for instant availability, which is the same duplication
  // the boot path just stopped doing: Discord lists the two scopes separately,
  // so a command in both appears twice. Global commands already reach every
  // server the bot is in, including this one.
  console.log(`Bot joined new server: ${guild.name} (${guild.id}); global commands already apply.`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const fgfGuild = channelToGuild.get(message.channel.id);
    if (!fgfGuild) return;

    const imageAttachment = message.attachments.find(
      (a) => a.contentType && a.contentType.startsWith("image/")
    );
    if (!imageAttachment) return;

    // Immediate feedback: let the player know their screenshot is being
    // processed before the (slower) OCR round-trip completes.
    await addReaction(message, "⏳");

    const imgRes = await fetch(imageAttachment.url);
    if (!imgRes.ok) {
      console.warn(`Failed to download attachment (${imgRes.status}) from ${message.channel.id}`);
      await settleFeedback(message, false);
      return;
    }
    const buf = Buffer.from(await imgRes.arrayBuffer());

    const res = await fetch(VERIFICATION_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DISCORD_WORKER_SECRET}`,
      },
      body: JSON.stringify({
        discord_user_id: message.author.id,
        discord_username: message.author.username,
        discord_server_id: message.guild.id,
        channel_id: message.channel.id,
        fgf_guild: fgfGuild,
        image_base64: buf.toString("base64"),
        mime_type: imageAttachment.contentType,
      }),
    });

    let result = null;
    try {
      result = await res.json();
    } catch {
      result = null;
    }

    const activeGuild = result?.target_guild || fgfGuild;

    if (res.ok && result?.ok === true) {
      await settleFeedback(message, true);
      // ONLY for a confirmed roster member. `discord_member_role_id` is
      // auto-wired by server-provisioner.js to a tag-bearing "[TAG] Member"
      // role, so granting it on the visitor outcome would hand out exactly
      // what the roster gate exists to withhold (ADR-020).
      if (result.role === "guild_member") {
        await addVerifiedRole(message, activeGuild);
      }

      // 1. Send Welcome DM
      const dmSent = await sendVerificationDm(message.author, result, activeGuild);
      if (!dmSent) {
        const fallbackNotice = await message.channel.send({
          content: `✅ <@${message.author.id}> Verified: **${result.nickname || result.pseudo}**! Welcome to **${activeGuild}**.`,
          allowedMentions: { users: [message.author.id], roles: [] },
        }).catch(() => null);
        if (fallbackNotice) setTimeout(() => fallbackNotice.delete().catch(() => {}), 15000);
      }

      // 2. Post to officer audit log if configured
      const auditChannelId = result.audit_channel_id || auditChannelByGuild.get(activeGuild) || auditChannelByGuild.get(fgfGuild);
      if (auditChannelId && message.guild) {
        await postVerificationAuditLog(message.guild, auditChannelId, message.author, result, activeGuild);
      }

      // 3. Auto-delete user's screenshot message after 5s for privacy & clean channel
      setTimeout(() => {
        message.delete().catch((delErr) => {
          console.warn(`Could not delete verification screenshot in ${message.channel.id} (needs Manage Messages permission):`, delErr.message);
        });
      }, 5000);

      // 4. Auto-delete bot's channel confirmation message after 15s to keep #verification clean
      if (result?.bot_message_id) {
        setTimeout(async () => {
          try {
            const botMsg = await message.channel.messages.fetch(result.bot_message_id).catch(() => null);
            if (botMsg) await botMsg.delete().catch(() => {});
          } catch (_) {}
        }, 15000);
      }
    } else if (result?.role === "pending") {
      // Not an error and not a visitor: a real recruit the roster does not
      // know yet. The Edge Function already replied in-channel, posted the
      // durable officer message and assigned the [PENDING] role; the worker
      // only adds the Gateway-only parts (reaction, DM, audit embed) and
      // never the verified-member role.
      await settleFeedback(message, false);
      const dmSent = await sendVerificationDm(message.author, result, activeGuild);
      if (!dmSent) {
        console.log(`Could not DM pending player ${message.author.id}; the channel reply stands.`);
      }

      const auditChannelId = result.audit_channel_id || auditChannelByGuild.get(activeGuild) || auditChannelByGuild.get(fgfGuild);
      if (auditChannelId && message.guild) {
        await postVerificationAuditLog(message.guild, auditChannelId, message.author, result, activeGuild);
      }

      // Same privacy cleanup as a success: the officer channel now holds the
      // durable record, so the screenshot itself does not need to stay.
      setTimeout(() => {
        message.delete().catch(() => {});
      }, 5000);
      if (result?.bot_message_id) {
        setTimeout(async () => {
          try {
            const botMsg = await message.channel.messages.fetch(result.bot_message_id).catch(() => null);
            if (botMsg) await botMsg.delete().catch(() => {});
          } catch (_) {}
        }, 15000);
      }
    } else {
      const error = (result && result.error) || `http_${res.status}`;
      console.warn(`discord-profile-verification returned ${res.status} (${error}) for user ${message.author.id}`);
      await settleFeedback(message, false);

      // Auto-delete failed screenshot after 15s to prevent clutter
      setTimeout(() => {
        message.delete().catch(() => {});
      }, 15000);

      // Auto-delete bot's error message after 15s as well
      if (result?.bot_message_id) {
        setTimeout(async () => {
          try {
            const botMsg = await message.channel.messages.fetch(result.bot_message_id).catch(() => null);
            if (botMsg) await botMsg.delete().catch(() => {});
          } catch (_) {}
        }, 15000);
      }
    }
  } catch (e) {
    console.error("Error handling messageCreate for profile verification:", e);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("cta_")) {
        await handleCtaButton(interaction);
      } else if (interaction.customId.startsWith("setup_")) {
        await handleSetupButton(interaction);
      } else if (interaction.customId.startsWith("reconcile_")) {
        await handleReconcileButton(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "link") {
      await handleLink(interaction);
    } else if (interaction.commandName === "myinfo") {
      await handleMyInfo(interaction);
    } else if (interaction.commandName === "profile") {
      await handleProfile(interaction);
    } else if (interaction.commandName === "absent") {
      await handleAbsent(interaction);
    } else if (interaction.commandName === "top") {
      await handleTop(interaction);
    } else if (interaction.commandName === "absences") {
      await handleAbsences(interaction);
    } else if (interaction.commandName === "call-to-arms") {
      await handleCallToArms(interaction);
    } else if (interaction.commandName === "setup-server") {
      await handleSetupServer(interaction);
    } else if (interaction.commandName === "reconcile-roles") {
      await handleReconcileRoles(interaction);
    } else if (interaction.commandName === "mystats") {
      await handleMyStats(interaction);
    } else if (interaction.commandName === "verifications") {
      await handleVerifications(interaction);
    } else if (FORWARDED_COMMANDS.has(interaction.commandName)) {
      await forwardInteraction(interaction);
    }
  } catch (e) {
    console.error(`Error handling interaction /${interaction.commandName || interaction.customId}:`, e);
    await safeReplyToInteraction(interaction, "Something went wrong. Please try again.");
  }
});

client.login(DISCORD_BOT_TOKEN);

