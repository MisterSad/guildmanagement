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
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { getPlayer } from "../_shared/member-lookup.ts";
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
    const { data: link } = await admin
      .from("discord_account_links")
      .select("account_id")
      .eq("discord_user_id", discordUserId)
      .maybeSingle();

    if (!link) {
      return ephemeral("Your Discord account isn't linked yet. Run `/link` first, then confirm the code in the Player Portal (My Info -> Link Discord).");
    }

    const { data: account } = await admin
      .from("accounts")
      .select("uid, guild")
      .eq("id", link.account_id)
      .maybeSingle();

    if (!account?.uid) {
      return ephemeral("Your linked account doesn't have an in-game UID on file. Contact your guild admin.");
    }

    const member = await getPlayer(admin, account.uid, account.guild);
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
        { name: "Timezone", value: member.timezone_offset != null ? `UTC${member.timezone_offset >= 0 ? "+" : ""}${member.timezone_offset}` : "—", inline: true },
      ],
    };
    return ephemeral("", [embed]);
  }

  return ephemeral("Unknown command.");
});
