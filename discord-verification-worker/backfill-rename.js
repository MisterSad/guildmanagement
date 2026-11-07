#!/usr/bin/env node
/**
 * discord-verification-worker/backfill-rename.js
 *
 * Renames the authors of every screenshot already posted in a rename-only
 * channel (public.discord_channel_modes), each after their most recent valid
 * screenshot. The live bot only sees new messages; this catches up the history.
 *
 * On the VM (reads the bot's own env file, so run it as root):
 *
 *   sudo node /opt/fgf-guild-management/discord-verification-worker/backfill-rename.js --channel <id> --dry-run
 *   sudo node /opt/fgf-guild-management/discord-verification-worker/backfill-rename.js --channel <id>
 *
 * --dry-run   reads every screenshot and prints the nickname each author would
 *             get; renames nobody and records nothing.
 * --state F   where progress is recorded (default
 *             /var/lib/fgf-discord-bot/rename-backfill-<channel>.json).
 * --bot-env  the bot's env file (default /etc/fgf-discord-bot/env); variables
 *             already set in the environment win.
 *
 * Safe to re-run: an author already settled is skipped unless they posted a
 * newer screenshot; a member who left is skipped; Discord's rate limits are
 * waited out (the REST client for reads, retry_after for renames). Every
 * screenshot read counts against the per-user attempt throttle of the Edge
 * Function (5 per 10 minutes), so an author with many unreadable screenshots
 * may be reported "deferred": run it again later and only they are retried.
 *
 * It refuses a channel that is not configured rename_only in the database: the
 * channel list lives there, not in this script.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { REST, Routes } from "discord.js";
import { createClient } from "@supabase/supabase-js";
import { forwardScreenshot, listChannelMessages, runBackfill } from "./rename-only.js";

function parseArgs(argv) {
  const args = { dryRun: false, channel: "", state: "", envFile: "/etc/fgf-discord-bot/env" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--channel") args.channel = argv[++i] || "";
    else if (a === "--state") args.state = argv[++i] || "";
    else if (a === "--bot-env") args.envFile = argv[++i] || "";
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/** KEY=value lines, as systemd's EnvironmentFile reads them. Values are never printed. */
function loadEnvFile(file) {
  if (!file || !existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined || process.env[m[1]] === "") process.env[m[1]] = value;
  }
}

function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { authors: {} };
  }
}

function saveStateTo(file) {
  return async (state) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !/^[0-9]{17,20}$/.test(args.channel)) {
    console.log("Usage: node backfill-rename.js --channel <channel id> [--dry-run] [--state <file>] [--bot-env <file>]");
    process.exit(args.help ? 0 : 2);
  }
  loadEnvFile(args.envFile);
  const { DISCORD_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VERIFICATION_FUNCTION_URL, DISCORD_WORKER_SECRET } = process.env;
  for (const [name, value] of Object.entries({ DISCORD_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VERIFICATION_FUNCTION_URL, DISCORD_WORKER_SECRET })) {
    if (!value) {
      console.error(`Missing ${name} (looked in the environment and ${args.envFile}).`);
      process.exit(1);
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: modeRow, error } = await supabase
    .from("discord_channel_modes")
    .select("channel_id, discord_server_id, mode")
    .eq("channel_id", args.channel)
    .maybeSingle();
  if (error) {
    console.error(`Could not read discord_channel_modes: ${error.message}`);
    process.exit(1);
  }
  if (!modeRow || modeRow.mode !== "rename_only") {
    console.error(`Channel ${args.channel} is not configured rename_only in discord_channel_modes; refusing.`);
    process.exit(1);
  }
  const serverId = modeRow.discord_server_id;

  // The REST client queues requests per rate-limit bucket and waits out 429s.
  const rest = new REST({ version: "10" }).setToken(DISCORD_BOT_TOKEN);

  const channel = await rest.get(Routes.channel(args.channel));
  if (channel?.guild_id !== serverId) {
    console.error(`Channel ${args.channel} belongs to server ${channel?.guild_id}, not ${serverId}; refusing.`);
    process.exit(1);
  }

  console.log(`${args.dryRun ? "DRY RUN -- " : ""}reading the history of #${channel.name} (${args.channel}) on server ${serverId}`);
  const messages = await listChannelMessages(
    (before) => rest.get(Routes.channelMessages(args.channel), { query: new URLSearchParams({ limit: "100", ...(before ? { before } : {}) }) }),
    { onPage: (n) => process.stdout.write(`\r  ${n} messages read`) }
  );
  process.stdout.write("\n");

  const stateFile = args.state || `/var/lib/fgf-discord-bot/rename-backfill-${args.channel}.json`;
  const state = loadState(stateFile);

  async function isMember(userId) {
    try {
      await rest.get(Routes.guildMember(serverId, userId));
      return true;
    } catch (e) {
      if (e?.status === 404) return false;
      throw e;
    }
  }

  // Attachment URLs are signed and expire; a long run re-reads the message
  // for a fresh URL when the download fails.
  async function forward(author, candidate, { dryRun }) {
    const send = (attachment) =>
      forwardScreenshot({
        fetchImpl: fetch,
        functionUrl: VERIFICATION_FUNCTION_URL,
        secret: DISCORD_WORKER_SECRET,
        userId: author.userId,
        username: author.username,
        serverId,
        channelId: args.channel,
        attachment,
        dryRun,
      });
    let answer = await send(candidate.attachment);
    if (answer.result?.error === "download_failed") {
      try {
        const fresh = await rest.get(Routes.channelMessage(args.channel, candidate.messageId));
        const att = (fresh.attachments || []).find((a) => (a.content_type || "").startsWith("image/"));
        if (att) answer = await send({ url: att.url, contentType: att.content_type });
      } catch {
        /* deleted since: stays download_failed */
      }
    }
    return answer;
  }

  const summary = await runBackfill({
    messages,
    state,
    isMember,
    forward,
    sleep,
    log: (line) => console.log(`  ${line}`),
    saveState: saveStateTo(stateFile),
    dryRun: args.dryRun,
  });

  console.log(`\n${args.dryRun ? "Dry run" : "Backfill"} finished: ${JSON.stringify(summary)}`);
  if (!args.dryRun) console.log(`Progress recorded in ${stateFile}`);
  if (summary.deferred > 0) console.log(`${summary.deferred} author(s) deferred: run the same command again in about 10 minutes.`);
}

main().catch((e) => {
  console.error("Backfill failed:", e?.message || e);
  process.exit(1);
});
