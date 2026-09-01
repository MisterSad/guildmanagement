#!/usr/bin/env node
/**
 * Registers (or updates) the bot's global slash commands with Discord.
 * Run manually, once per command-set change -- not part of any build step.
 *
 * Requires two environment variables (never commit these):
 *   DISCORD_APPLICATION_ID
 *   DISCORD_BOT_TOKEN
 *
 * Usage:
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/register-discord-commands.mjs
 *
 * Global commands can take up to ~1 hour to propagate to all servers the
 * first time. For faster iteration during development, register against a
 * single test guild instead (see the commented alternative endpoint below).
 */

const APP_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID || !BOT_TOKEN) {
  console.error("Missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN in the environment.");
  process.exit(1);
}

const COMMANDS = [
  {
    name: "link",
    description: "Link your Discord account to your FGF Guild Management player account",
    type: 1,
  },
  {
    name: "myinfo",
    description: "Show your linked player stats (power, glory, role, timezone)",
    type: 1,
  },
];

// Global registration (propagates to every server the bot is in).
const url = `https://discord.com/api/v10/applications/${APP_ID}/commands`;
// For instant propagation during development, register to one test guild
// instead: `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`

const res = await fetch(url, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${BOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(COMMANDS),
});

const body = await res.json();
if (!res.ok) {
  console.error(`Discord API error (${res.status}):`, JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(`Registered ${body.length} command(s):`);
for (const cmd of body) {
  console.log(`  /${cmd.name} — ${cmd.description}`);
}
