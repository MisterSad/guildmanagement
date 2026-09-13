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
import { Client, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
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

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
// ApplicationCommandOptionType: 6 = USER, 3 = STRING.
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

// Registers /profile and /absent via the REST API, merging into whatever
// global commands already exist so other commands (/link, /myinfo, ...) are
// never wiped on a redeploy.
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
      ["profile", PROFILE_COMMAND],
      ["absent", ABSENT_COMMAND],
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
      if (!desired.has(cmd.name)) body.push(cmd);
    }

    // Debug surface: if a legacy Edge Function command overlaps the new /
    // profile + /absent surface, report it so an operator can clean it up
    // manually (deleting it here could break the endpoint it belongs to).
    const legacyOverlap = existing.filter((c) => ["absence", "myinfo"].includes(c.name));
    if (legacyOverlap.length > 0) {
      console.log(`Preserved legacy commands overlapping the new slash surface: ${legacyOverlap.map((c) => `/${c.name}`).join(", ")}.`);
    }

    await rest.put(Routes.applicationCommands(appId), { body });
    console.log("Slash commands registered: /profile, /absent");
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

async function resolveLinkedAccount(discordUserId) {
  const { data: link, error: linkError } = await supabase
    .from("discord_account_links")
    .select("account_id")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (linkError) throw linkError;
  if (!link) return null;

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("uid, guild")
    .eq("id", link.account_id)
    .maybeSingle();
  if (accountError) throw accountError;
  if (!account?.uid || !account?.guild) return null;

  return { uid: account.uid, guild: account.guild };
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

  const embed = {
    color: 0x6366f1,
    title: `${member.pseudo} — ${member.guild}`,
    fields: [
      { name: "Role", value: member.role || "—", inline: true },
      { name: "Overall Power", value: formatNumber(member.overall_power), inline: true },
      { name: "Fleet", value: formatNumber(member.fleet_rating), inline: true },
      { name: "Tech", value: formatNumber(member.tech_power), inline: true },
      { name: "Flagship", value: formatNumber(member.flagship_power), inline: true },
      { name: "Champs", value: formatNumber(member.champion_power), inline: true },
      { name: "Crew", value: formatNumber(member.crew_power), inline: true },
      { name: "Timezone", value: timezoneLabel(member.timezone_offset), inline: true },
    ],
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
  discordReady = true;
  await refreshChannelMap();
  await refreshMemberRoleMap();
  await registerSlashCommands();
  setInterval(async () => {
    await refreshChannelMap();
    await refreshMemberRoleMap();
  }, 5 * 60 * 1000);

  if (!(DISCORD_MEMBER_ROLE_ID || "").trim() && memberRoleByGuild.size === 0) {
    console.log("DISCORD_MEMBER_ROLE_ID not set and no guild_config fallback (discord_member_role_id) -- verified-role auto-assignment disabled.");
  } else {
    console.log("Verified-role auto-assignment enabled (DISCORD_MEMBER_ROLE_ID or guild_config fallback).");
  }
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

    if (res.ok && result?.ok === true) {
      await settleFeedback(message, true);
      // Best-effort: add the verified-member role now that the profile is
      // confirmed. Failure here must never undo the ✅ reaction.
      await addVerifiedRole(message, fgfGuild);
    } else {
      const error = (result && result.error) || `http_${res.status}`;
      console.warn(`discord-profile-verification returned ${res.status} (${error}) for user ${message.author.id}`);
      await settleFeedback(message, false);
    }
  } catch (e) {
    console.error("Error handling messageCreate for profile verification:", e);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "profile") {
      await handleProfile(interaction);
    } else if (interaction.commandName === "absent") {
      await handleAbsent(interaction);
    }
  } catch (e) {
    console.error(`Error handling /${interaction.commandName}:`, e);
    await safeReplyToInteraction(interaction, "Something went wrong. Please try again.");
  }
});

client.login(DISCORD_BOT_TOKEN);
