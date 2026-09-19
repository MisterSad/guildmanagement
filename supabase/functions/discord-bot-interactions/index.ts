/**
 * supabase/functions/discord-bot-interactions/index.ts
 *
 * Receives Discord Interactions (slash commands only -- no Gateway
 * connection, see _shared/discord.ts). Public endpoint (verify_jwt: false),
 * authenticated by Ed25519 signature instead of a Supabase JWT. Runtime
 * support for crypto.subtle.verify('Ed25519', ...) confirmed live against
 * this exact Supabase project before this file was written.
 *
 * Phase 1 commands:
 *   /link    -- generates a short-lived code, confirmed from the already-
 *               authenticated web Portal (My Info -> Link Discord). The
 *               code alone never proves account ownership; the Portal
 *               confirmation does.
 *   /myinfo  -- reads the caller's own stats via the same guild_members
 *               lookup member-portal uses (_shared/member-lookup.ts),
 *               once their Discord account is linked.
 *
 * Phase 2 commands (all require a linked account, same resolution as
 * /myinfo): /power, /glory, /timezone, /challenges, /absence (set/list/
 * cancel). Every write goes through _shared/player-actions.ts -- the exact
 * same validated, audited code path member-portal uses, not a
 * reimplementation.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { getPlayer } from "../_shared/member-lookup.ts";
import {
  updatePlayerPower,
  updatePlayerGlory,
  updatePlayerTimezone,
  getPlayerChallenges,
  listPlayerAbsences,
  setPlayerAbsence,
  deletePlayerAbsence,
} from "../_shared/player-actions.ts";
import {
  verifyDiscordSignature,
  discordPublicKeyHex,
  InteractionType,
  InteractionResponseType,
  EPHEMERAL_FLAG,
  discordJson,
} from "../_shared/discord.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function ephemeral(content: string, embeds?: unknown[]) {
  return discordJson({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, embeds, flags: EPHEMERAL_FLAG },
  });
}

function randomLinkCode(): string {
  // 6 uppercase alphanumeric chars, unambiguous alphabet (no 0/O/1/I).
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const NOT_LINKED_MSG = "Your Discord account isn't linked yet. Run `/link` first, then confirm the code in the Player Portal (My Info -> Link Discord).";
const NO_UID_MSG = "Your linked account doesn't have an in-game UID on file. Contact your guild admin.";

async function resolveLinkedAccount(
  admin: ReturnType<typeof createClient>,
  discordUserId: string
): Promise<{ ok: true; uid: string; guild: string } | { ok: false; message: string }> {
  const { data: link } = await admin
    .from("discord_account_links")
    .select("account_id")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();
  if (!link) return { ok: false, message: NOT_LINKED_MSG };

  const { data: account } = await admin
    .from("accounts")
    .select("uid, guild")
    .eq("id", link.account_id)
    .maybeSingle();
  if (!account?.uid) return { ok: false, message: NO_UID_MSG };

  return { ok: true, uid: account.uid, guild: account.guild };
}

function getOptionValue(options: any[] | undefined, name: string): any {
  return options?.find((o: any) => o.name === name)?.value;
}

Deno.serve(async (req: Request) => {
  const logger = new EdgeLogger("discord-bot-interactions", req);
  if (req.method !== "POST") return discordJson({ error: "method_not_allowed" }, 405);

  const publicKey = discordPublicKeyHex();
  if (!publicKey) {
    logger.error("DISCORD_PUBLIC_KEY is not configured");
    return discordJson({ error: "not_configured" }, 500);
  }

  const signature = req.headers.get("x-signature-ed25519") || "";
  const timestamp = req.headers.get("x-signature-timestamp") || "";
  const rawBody = await req.text();

  const valid = await verifyDiscordSignature(publicKey, signature, timestamp, rawBody);
  if (!valid) {
    logger.warn("Rejected interaction with invalid signature");
    return discordJson({ error: "invalid_signature" }, 401);
  }

  let interaction: any;
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return discordJson({ error: "bad_payload" }, 400);
  }

  if (interaction.type === InteractionType.PING) {
    return discordJson({ type: InteractionResponseType.PONG });
  }

  if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
    return discordJson({ error: "unsupported_interaction_type" }, 400);
  }

  const discordUser = interaction.member?.user || interaction.user;
  const discordUserId: string | undefined = discordUser?.id;
  const discordUsername: string | undefined = discordUser?.username;
  const commandName: string = interaction.data?.name || "";

  if (!discordUserId) {
    return ephemeral("Could not identify your Discord account for this command.");
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  logger.setContext({ userId: discordUserId });

  if (commandName === "link") {
    const code = randomLinkCode();
    // Replace any still-pending code for this Discord user, so running
    // /link again invalidates a previous unused code instead of leaving
    // multiple valid codes around.
    await admin.from("discord_link_codes").delete().eq("discord_user_id", discordUserId);
    const { error } = await admin.from("discord_link_codes").insert({
      code,
      discord_user_id: discordUserId,
      discord_username: discordUsername || null,
    });
    if (error) {
      logger.error("Failed to create discord_link_codes row", error);
      return ephemeral("Something went wrong generating your link code. Please try again.");
    }
    logger.info("Generated Discord link code");
    return ephemeral(
      `Your link code is **${code}**. It expires in 10 minutes.\n\n` +
      `Go to the FGF Guild Management web app -> Player Portal -> My Info -> "Link Discord", ` +
      `sign in if needed, and enter this code to finish linking your account.`
    );
  }

  if (commandName === "myinfo") {
    const resolved = await resolveLinkedAccount(admin, discordUserId);
    if (!resolved.ok) return ephemeral(resolved.message);

    const member = await getPlayer(admin, resolved.uid, resolved.guild);
    if (!member) {
      return ephemeral("Couldn't find your roster entry. Your admin may need to re-scan the roster.");
    }

    const embed = {
      title: `${member.pseudo} — ${member.guild}`,
      color: 0x6366f1,
      fields: [
        { name: "Overall Power", value: member.overall_power != null ? member.overall_power.toLocaleString("en-US") : "—", inline: true },
        { name: "Glory", value: member.glory_score != null ? member.glory_score.toLocaleString("en-US") : "—", inline: true },
        { name: "Role", value: member.role || "—", inline: true },
        { name: "Fleet Rating", value: member.fleet_rating != null ? member.fleet_rating.toLocaleString("en-US") : "—", inline: true },
        { name: "Tech Power", value: member.tech_power != null ? member.tech_power.toLocaleString("en-US") : "—", inline: true },
        {
          name: "Timezone",
          value: member.timezone
            ? `${member.timezone} (UTC${(member.timezone_offset ?? 0) >= 0 ? "+" : ""}${member.timezone_offset ?? 0})`
            : (member.timezone_offset != null ? `UTC${member.timezone_offset >= 0 ? "+" : ""}${member.timezone_offset}` : "—"),
          inline: true
        },
      ],
    };
    return ephemeral("", [embed]);
  }

  if (commandName === "power") {
    const resolved = await resolveLinkedAccount(admin, discordUserId);
    if (!resolved.ok) return ephemeral(resolved.message);

    const value = getOptionValue(interaction.data?.options, "value");
    const res = await updatePlayerPower(admin, resolved.uid, resolved.guild, value);
    if (!res.ok) {
      const msg = res.error === "invalid_power"
        ? "That doesn't look like a valid power value."
        : "Couldn't update your power. Please try again later.";
      return ephemeral(msg);
    }
    logger.info("Player updated power via Discord", { power: res.power });
    return ephemeral(`Power updated to **${res.power!.toLocaleString("en-US")}**.`);
  }

  if (commandName === "glory") {
    const resolved = await resolveLinkedAccount(admin, discordUserId);
    if (!resolved.ok) return ephemeral(resolved.message);

    const value = getOptionValue(interaction.data?.options, "value");
    const res = await updatePlayerGlory(admin, resolved.uid, resolved.guild, value);
    if (!res.ok) {
      const msg = res.error === "invalid_glory"
        ? "That doesn't look like a valid Glory value."
        : "Couldn't submit your Glory score. Please try again later.";
      return ephemeral(msg);
    }
    logger.info("Player updated glory via Discord", { week: res.week, glory: res.glory });
    return ephemeral(`Glory score for week ${res.week} submitted: **${res.glory!.toLocaleString("en-US")}**.`);
  }

  if (commandName === "timezone") {
    const resolved = await resolveLinkedAccount(admin, discordUserId);
    if (!resolved.ok) return ephemeral(resolved.message);

    const offset = Number(getOptionValue(interaction.data?.options, "offset"));
    const res = await updatePlayerTimezone(admin, resolved.uid, resolved.guild, offset);
    if (!res.ok) return ephemeral("Couldn't update your timezone. Please try again later.");
    logger.info("Player updated timezone via Discord", { offset });
    return ephemeral(`Timezone set to **UTC${offset >= 0 ? "+" : ""}${offset}**.`);
  }

  if (commandName === "challenges") {
    const resolved = await resolveLinkedAccount(admin, discordUserId);
    if (!resolved.ok) return ephemeral(resolved.message);

    const res = await getPlayerChallenges(admin, resolved.uid, resolved.guild);
    if (!res.ok) return ephemeral("Couldn't load your weekly challenges. Please try again later.");

    const embed = {
      title: `Weekly Challenges — ${res.week}`,
      color: 0x6366f1,
      description: `Season level: **${res.season!.level}** (${res.season!.events} events)`,
      fields: (res.challenges || []).map((c) => ({
        name: `${c.done ? "✅" : "⬜"} ${c.label}`,
        value: `${c.progress}/${c.target}`,
        inline: true,
      })),
    };
    return ephemeral("", [embed]);
  }

  if (commandName === "absence") {
    const resolved = await resolveLinkedAccount(admin, discordUserId);
    if (!resolved.ok) return ephemeral(resolved.message);

    const sub = interaction.data?.options?.[0];
    const subName: string = sub?.name || "";
    const subOptions = sub?.options;

    if (subName === "set") {
      const startDate = getOptionValue(subOptions, "start_date");
      const endDate = getOptionValue(subOptions, "end_date");
      const note = getOptionValue(subOptions, "note");
      const res = await setPlayerAbsence(admin, resolved.uid, resolved.guild, {
        startDate,
        endDate,
        kind: "full",
        note: note || null,
      });
      if (!res.ok) {
        const msg = res.error === "missing_dates"
          ? "You need to provide both a start and end date."
          : "Couldn't save your absence. Make sure the dates are valid (YYYY-MM-DD, end date on or after start date) and try again.";
        return ephemeral(msg);
      }
      return ephemeral(`Absence declared from **${startDate}** to **${endDate}**.`);
    }

    if (subName === "list") {
      const res = await listPlayerAbsences(admin, resolved.uid);
      if (!res.ok) return ephemeral("Couldn't load your absences. Please try again later.");
      const absences = res.absences || [];
      if (absences.length === 0) return ephemeral("You have no declared absences.");
      const lines = absences.map(
        (a: any) => `\`${a.id}\` — ${a.start_date} to ${a.end_date}${a.note ? ` (${a.note})` : ""}`
      );
      return ephemeral(`Your absences:\n${lines.join("\n")}\n\nUse \`/absence cancel\` with the ID to remove one.`);
    }

    if (subName === "cancel") {
      const id = getOptionValue(subOptions, "id");
      const res = await deletePlayerAbsence(admin, resolved.uid, resolved.guild, id);
      if (!res.ok) {
        const msg = res.error === "missing_id"
          ? "You need to provide the absence ID (see `/absence list`)."
          : "Couldn't cancel that absence. Check the ID and try again.";
        return ephemeral(msg);
      }
      return ephemeral("Absence cancelled.");
    }

    return ephemeral("Unknown /absence subcommand.");
  }

  return ephemeral("Unknown command.");
});
