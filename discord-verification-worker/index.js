/**
 * discord-verification-worker/index.js
 *
 * The ONLY reason this worker exists: reacting to a message posted in a
 * Discord channel requires the Gateway (a persistent WebSocket), which a
 * stateless Supabase Edge Function cannot hold open. This worker is
 * deliberately kept "dumb" -- it does nothing but listen for image
 * attachments in configured verification channels and forward them to the
 * discord-profile-verification Edge Function, which owns every actual
 * decision (OCR, validation, database writes, role assignment, nickname
 * change, and the reply posted back into the channel). No business logic,
 * no direct database writes beyond reading the channel->guild map, and no
 * Discord REST actions belong here.
 */
import { createServer } from "node:http";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { createClient } from "@supabase/supabase-js";

const {
  DISCORD_BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  VERIFICATION_FUNCTION_URL,
  DISCORD_WORKER_SECRET,
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

client.once("ready", async () => {
  console.log(`discord-verification-worker logged in as ${client.user.tag}`);
  discordReady = true;
  await refreshChannelMap();
  setInterval(refreshChannelMap, 5 * 60 * 1000);
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

    const imgRes = await fetch(imageAttachment.url);
    if (!imgRes.ok) {
      console.warn(`Failed to download attachment (${imgRes.status}) from ${message.channel.id}`);
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

    if (!res.ok) {
      console.warn(`discord-profile-verification returned ${res.status} for user ${message.author.id}`);
    }
  } catch (e) {
    console.error("Error handling messageCreate for profile verification:", e);
  }
});

client.login(DISCORD_BOT_TOKEN);
