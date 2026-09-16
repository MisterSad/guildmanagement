#!/usr/bin/env node
/**
 * Registers (or updates) the bot's slash commands with Discord.
 * Run manually, once per command-set change -- not part of any build step.
 *
 * Requires two environment variables (never commit these):
 *   DISCORD_APPLICATION_ID
 *   DISCORD_BOT_TOKEN
 *
 * Optional third: DISCORD_GUILD_ID -- when set, registers to that one
 * server instead of globally. Guild-scoped commands propagate instantly;
 * global commands can take up to ~1 hour the first time. Use this while
 * testing, drop it once ready to go global.
 *
 * Usage:
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... [DISCORD_GUILD_ID=...] node scripts/register-discord-commands.mjs
 */

const APP_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

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
  {
    name: "power",
    description: "Update your overall power",
    type: 1,
    options: [
      { type: 4, name: "value", description: "Your current overall power (e.g. 1500000000)", required: true, min_value: 0 },
    ],
  },
  {
    name: "glory",
    description: "Submit your weekly Glory score",
    type: 1,
    options: [
      { type: 4, name: "value", description: "Your Glory score for this week", required: true, min_value: 0 },
    ],
  },
  {
    name: "timezone",
    description: "Set your timezone (UTC offset)",
    type: 1,
    options: [
      { type: 4, name: "offset", description: "UTC offset in hours (e.g. -5, 0, 8)", required: true, min_value: -12, max_value: 14 },
    ],
  },
  {
    name: "challenges",
    description: "Show your weekly challenges progress",
    type: 1,
  },
  {
    name: "absence",
    description: "Manage your absence declarations",
    type: 1,
    options: [
      {
        type: 1,
        name: "set",
        description: "Declare an absence period",
        options: [
          { type: 3, name: "start_date", description: "Start date (YYYY-MM-DD)", required: true },
          { type: 3, name: "end_date", description: "End date (YYYY-MM-DD)", required: true },
          { type: 3, name: "note", description: "Optional reason", required: false },
        ],
      },
      {
        type: 1,
        name: "list",
        description: "List your current absences",
      },
      {
        type: 1,
        name: "cancel",
        description: "Cancel a declared absence",
        options: [
          { type: 3, name: "id", description: "Absence ID (from /absence list)", required: true },
        ],
      },
    ],
  },
  {
    name: "profile",
    description: "View a member's combat stats from the FGF roster",
    type: 1,
    options: [
      { type: 6, name: "user", description: "Discord user to look up via their linked account", required: false },
      { type: 3, name: "ingame_name", description: "In-game pseudo to search in the roster", required: false },
    ],
  },
  {
    name: "absent",
    description: "Declare an absence for your guild",
    type: 1,
    options: [
      { type: 3, name: "start_date", description: "First day of absence (YYYY-MM-DD)", required: true },
      { type: 3, name: "end_date", description: "Last day of absence (YYYY-MM-DD)", required: true },
      { type: 3, name: "reason", description: "Reason for the absence", required: false },
    ],
  },
  {
    name: "top",
    description: "View top guild members leaderboard",
    type: 1,
    options: [
      {
        type: 3,
        name: "category",
        description: "Leaderboard category (power, glory, fleet)",
        required: false,
        choices: [
          { name: "Overall Power", value: "power" },
          { name: "Glory Score", value: "glory" },
          { name: "Fleet Rating", value: "fleet" },
        ],
      },
    ],
  },
  {
    name: "absences",
    description: "Check declared absences in your guild",
    type: 1,
    options: [
      {
        type: 3,
        name: "scope",
        description: "Timeframe to check",
        required: true,
        choices: [
          { name: "Today (Currently Active)", value: "today" },
          { name: "Upcoming (Next 7 Days)", value: "upcoming" },
        ],
      },
    ],
  },
  {
    name: "call-to-arms",
    description: "Launch an interactive war check-in with live presence and power tracking",
    type: 1,
    options: [
      { type: 3, name: "event_name", description: "Event name (e.g. SvS Invasion, GvG Saturday)", required: true },
      { type: 3, name: "description", description: "Battle objective or instructions", required: false },
    ],
  },
  {
    name: "update-stats",
    description: "Quickly update your combat power and/or glory score in the roster",
    type: 1,
    options: [
      { type: 4, name: "power", description: "Your current Overall Power (digits only)", required: false, min_value: 0 },
      { type: 4, name: "glory", description: "Your current Glory score", required: false, min_value: 0 },
    ],
  },
];

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

console.log(GUILD_ID ? `Registering to guild ${GUILD_ID} (instant)...` : "Registering globally (may take up to ~1h to propagate)...");

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
