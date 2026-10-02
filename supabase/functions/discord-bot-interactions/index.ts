/**
 * supabase/functions/discord-bot-interactions/index.ts
 *
 * Holds the business logic for the player-facing slash commands. Public
 * endpoint (verify_jwt: false), authenticated EITHER by an Ed25519 signature
 * (a direct Discord Interactions webhook) OR by the shared worker secret (the
 * Gateway worker forwarding an interaction it received). Runtime support for
 * crypto.subtle.verify('Ed25519', ...) confirmed live against this exact
 * Supabase project before this file was written.
 *
 * WHY BOTH. Measured on 2026-09-28: this function was invoked **0 times** in 24
 * hours while discord-profile-verification was invoked 15 times, and the worker
 * logs it registering nine commands over the Gateway. Discord delivers
 * interactions over ONE transport, and for this application it is the Gateway --
 * so no Interactions Endpoint URL is configured and the Ed25519 path has never
 * carried a single request. Meanwhile /power, /glory, /timezone, /challenges and
 * /absence exist on Discord (scripts/register-discord-commands.mjs registered
 * them, and the worker preserves commands it does not own), the worker had no
 * handler for any of them, and a player running one got "The application did not
 * respond".
 *
 * Rather than reimplement five validated, audited commands in the worker's Node
 * process, the worker forwards the raw interaction here with the worker secret
 * and relays the reply. One implementation, one transport. The Ed25519 path is
 * kept because it costs nothing and is the only thing that would work if the
 * owner ever switches Discord to an Interactions Endpoint URL.
 *
 * /link (retired 2026-10-03) and /myinfo are answered by the Gateway worker,
 * not here. An account is linked by signing in to the app with Discord.
 *
 * Forwarded commands (all require a linked account): /power, /glory, /timezone, /challenges, /absence (set/list/
 * cancel). Every write goes through _shared/player-actions.ts -- the exact
 * same validated, audited code path member-portal uses, not a
 * reimplementation.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { EdgeLogger } from "../_shared/logger.ts";
import { isGuildInScope, normalizeRole } from "../_shared/admin-authz.ts";
import { postChannelMessage } from "../_shared/discord-verification.ts";
import {
  updatePlayerPower,
  updatePlayerGlory,
  updatePlayerTimezone,
  getPlayerChallenges,
  listPlayerAbsences,
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
const DISCORD_WORKER_SECRET = Deno.env.get("DISCORD_WORKER_SECRET") || "";

/** Constant-time compare, same as discord-profile-verification's. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ephemeral(content: string, embeds?: unknown[], components?: unknown[]) {
  return discordJson({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, embeds, components, flags: EPHEMERAL_FLAG },
  });
}

/** One LINK button (style 5) to the app; the worker relays link buttons only. */
function appLinkRow(label: string): unknown[] {
  return [{ type: 1, components: [{ type: 2, style: 5, label, url: APP_URL }] }];
}

// Signing in to the app with Discord is what links an account now (/link is
// retired), so that is what this tells people to do.
const APP_URL = (Deno.env.get("APP_DEFAULT_ORIGIN") ?? "https://guildmanagement.vercel.app").replace(/\/+$/, "");
const NOT_LINKED_MSG =
  "Your Discord account isn't linked to a player account yet. Sign in to FGF Guild Management with " +
  "**Continue with Discord** and it is linked automatically.";
const NO_UID_MSG = "Your linked account doesn't have an in-game UID on file. Contact your guild admin.";

/**
 * One Discord identity may hold SEVERAL accounts since migration
 * 20260927120000 re-keyed `discord_account_links` to
 * (discord_user_id, account_id) -- an administrator who is also a player.
 * `.maybeSingle()` ERRORS on that rather than picking one, so it is not used
 * here; and a tie is never broken silently, because silently picking is how an
 * admin's command lands on their player account. Only ACTIVE accounts count.
 */
async function resolveLinkedAccount(
  admin: ReturnType<typeof createClient>,
  discordUserId: string
): Promise<{ ok: true; uid: string; guild: string } | { ok: false; message: string; components?: unknown[] }> {
  const { data: links } = await admin
    .from("discord_account_links")
    .select("account_id")
    .eq("discord_user_id", discordUserId);
  if (!links || links.length === 0) {
    return { ok: false, message: NOT_LINKED_MSG, components: appLinkRow("Continue with Discord") };
  }

  const { data: accounts } = await admin
    .from("accounts")
    .select("id, uid, guild, role, status")
    .in("id", (links as { account_id: string }[]).map((l) => l.account_id));

  const usable = ((accounts as { id: string; uid?: string; guild?: string; role?: string; status?: string }[]) || [])
    .filter((a) => a.status === "active" && a.uid && a.guild);

  if (usable.length === 0) return { ok: false, message: NO_UID_MSG };
  if (usable.length > 1) {
    const list = usable
      .map((a) => `${a.guild} (\`${a.id}\`)`)
      .sort()
      .join(", ");
    return {
      ok: false,
      message: `Your Discord account is linked to ${usable.length} player accounts — ${list} — so I don't know which one you mean. Use the app for this, or ask an admin to unlink the other.`,
    };
  }

  return { ok: true, uid: usable[0].uid!, guild: usable[0].guild! };
}

function getOptionValue(options: any[] | undefined, name: string): any {
  return options?.find((o: any) => o.name === name)?.value;
}

Deno.serve(async (req: Request) => {
  const logger = new EdgeLogger("discord-bot-interactions", req);
  if (req.method !== "POST") return discordJson({ error: "method_not_allowed" }, 405);

  const rawBody = await req.text();

  // Transport A: the Gateway worker, authenticated by the shared secret. Its
  // body wraps the interaction it received: { "interaction": { ... } }.
  const authHeader = req.headers.get("Authorization") || "";
  const authBearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const fromWorker = !!DISCORD_WORKER_SECRET && !!authBearer && safeEqual(authBearer, DISCORD_WORKER_SECRET);

  let interaction: any;
  if (fromWorker) {
    try {
      const wrapped = JSON.parse(rawBody);
      interaction = wrapped?.interaction ?? wrapped;
    } catch {
      return discordJson({ error: "bad_payload" }, 400);
    }
    if (!interaction || typeof interaction !== "object") {
      return discordJson({ error: "bad_payload" }, 400);
    }
    logger.info("Interaction forwarded by the Gateway worker");
  } else {
    // Transport B: a direct Discord Interactions webhook, Ed25519-signed.
    // An Authorization header that is present but wrong must NOT fall through
    // to the signature path and be treated as an unauthenticated request it
    // might accidentally satisfy -- refuse it outright.
    if (authBearer) {
      logger.warn("Rejected interaction with an invalid worker secret");
      return discordJson({ error: "unauthorized" }, 401);
    }

    const publicKey = discordPublicKeyHex();
    if (!publicKey) {
      logger.error("DISCORD_PUBLIC_KEY is not configured");
      return discordJson({ error: "not_configured" }, 500);
    }

    const signature = req.headers.get("x-signature-ed25519") || "";
    const timestamp = req.headers.get("x-signature-timestamp") || "";
    const valid = await verifyDiscordSignature(publicKey, signature, timestamp, rawBody);
    if (!valid) {
      logger.warn("Rejected interaction with invalid signature");
      return discordJson({ error: "invalid_signature" }, 401);
    }

    try {
      interaction = JSON.parse(rawBody);
    } catch {
      return discordJson({ error: "bad_payload" }, 400);
    }
  }

  if (interaction.type === InteractionType.PING) {
    return discordJson({ type: InteractionResponseType.PONG });
  }

  if (interaction.type !== InteractionType.APPLICATION_COMMAND) {
    return discordJson({ error: "unsupported_interaction_type" }, 400);
  }

  const discordUser = interaction.member?.user || interaction.user;
  const discordUserId: string | undefined = discordUser?.id;
  const commandName: string = interaction.data?.name || "";

  if (!discordUserId) {
    return ephemeral("Could not identify your Discord account for this command.");
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  logger.setContext({ userId: discordUserId });

  // /link and /myinfo are answered by the Gateway worker; /link is retired
  // (see RETIRED_COMMANDS in discord-verification-worker/index.js). Only the
  // forwarded commands below ever reach this function.

  // /invite -- an officer posts a "Join <TAG>" button in the channel. The
  // button is the guild's #join= invite link, so a player lands on Continue
  // with Discord with the join code already filled in. Authority comes from the
  // caller's LINKED app account and the same isGuildInScope() the app uses,
  // never from Discord permissions: anyone can be a Discord server admin.
  if (commandName === "invite") {
    const channelId: string | null = interaction.channel_id || null;
    if (!interaction.guild_id || !channelId) {
      return ephemeral("Run `/invite` in a channel of your Discord server, where your players can see it.");
    }

    const { data: links } = await admin
      .from("discord_account_links")
      .select("account_id")
      .eq("discord_user_id", discordUserId);
    const ids = ((links as { account_id: string }[]) || []).map((l) => l.account_id);
    const { data: accs } = ids.length
      ? await admin.from("accounts").select("id, role, guild, server_number, status").in("id", ids)
      : { data: [] };
    const officers = ((accs as any[]) || [])
      .filter((a) => a.status === "active")
      .map((a) => ({ id: a.id as string, role: normalizeRole(a.role), guild: a.guild ?? null, serverNumber: a.server_number ?? null }))
      .filter((a) => a.role !== "member");
    if (officers.length === 0) {
      return ephemeral(
        "Only a guild officer can post an invite. Sign in to the app with **Continue with Discord** using your officer account first.",
        undefined,
        appLinkRow("Continue with Discord"),
      );
    }

    const requested = String(getOptionValue(interaction.data?.options, "guild") ?? "").trim().toUpperCase();
    const ownGuilds = [...new Set(officers.map((o) => o.guild).filter(Boolean))] as string[];
    const target = requested || (ownGuilds.length === 1 ? ownGuilds[0] : "");
    if (!target) {
      return ephemeral("You manage more than one guild here. Run `/invite guild:<TAG>` to say which one.");
    }
    if (!/^[A-Z0-9_]{2,12}$/.test(target)) return ephemeral("That is not a guild tag.");

    const { data: guildRow } = await admin.from("guilds").select("id, server_number").eq("id", target).maybeSingle();
    if (!guildRow) return ephemeral(`I don't know a guild called **${target}**.`);
    const allowed = officers.some((o) => isGuildInScope(o, target, (guildRow as any).server_number ?? null));
    if (!allowed) {
      logger.warn("Refused /invite outside the caller's scope", { target });
      return ephemeral(`Your account is not an officer of **${target}**.`);
    }

    const { data: codeRes } = await admin.rpc("gm_get_join_code", { p_guild: target });
    const code = codeRes && typeof (codeRes as any).code === "string" ? String((codeRes as any).code).trim() : "";
    if (!code) {
      return ephemeral(
        `**${target}** has no join code yet. Open **Accounts & Access** in the app once and it is created.`,
        undefined,
        appLinkRow("Open FGF Guild Management"),
      );
    }

    const link = `${APP_URL}/#join=${encodeURIComponent(code)}`;
    const posted = await postChannelMessage(channelId, {
      embeds: [{
        color: 0x5865f2,
        title: `⚔️ Join ${target} on FGF Guild Management`,
        description:
          "Your events, scores and stats, in one place.\n\n" +
          `**1.** Press **Join ${target}** below.\n` +
          "**2.** Choose **Continue with Discord**.\n" +
          "**3.** Pick **I'm a player — join my guild**: the join code is already filled in, just type your in-game UID.\n" +
          "**4.** An officer approves you, and the bot DMs you when it's done.",
        footer: { text: "FGF Guild Management • Player Portal" },
      }],
      components: [{ type: 1, components: [{ type: 2, style: 5, label: `Join ${target}`, url: link }] }],
    });
    if (!posted) {
      return ephemeral("I couldn't post in this channel. Check that I can **Send Messages** and **Embed Links** here.");
    }
    logger.info("Invite posted", { target });
    return ephemeral(
      `Posted. Anyone who can read this channel can use the button; an officer still approves each request.`,
    );
  }

  // /update-stats replaces /power and /glory, which did the same two writes
  // under two more names. One command, both fields optional, and both writes go
  // through the same validated, audited helpers member-portal uses -- which the
  // worker's own /update-stats did NOT: it called the RPCs directly, so it
  // clamped nothing and wrote no audit row.
  if (commandName === "update-stats") {
    const resolved = await resolveLinkedAccount(admin, discordUserId);
    if (!resolved.ok) return ephemeral(resolved.message, undefined, resolved.components);

    const powerInput = getOptionValue(interaction.data?.options, "power");
    const gloryInput = getOptionValue(interaction.data?.options, "glory");
    if (powerInput === undefined && gloryInput === undefined) {
      return ephemeral("Give me a **power** or a **glory** value to update (or both).");
    }

    const lines: string[] = [];

    if (powerInput !== undefined) {
      const res = await updatePlayerPower(admin, resolved.uid, resolved.guild, powerInput);
      if (!res.ok) {
        return ephemeral(
          res.error === "invalid_power"
            ? "That doesn't look like a valid power value."
            : "Couldn't update your power. Please try again later."
        );
      }
      logger.info("Player updated power via Discord", { power: res.power });
      lines.push(`• **Power**: ${res.power!.toLocaleString("en-US")}`);
    }

    if (gloryInput !== undefined) {
      const res = await updatePlayerGlory(admin, resolved.uid, resolved.guild, gloryInput);
      if (!res.ok) {
        // Power may already have been written; say so rather than implying
        // nothing happened.
        const prefix = lines.length ? "Power was updated, but " : "";
        return ephemeral(
          prefix + (res.error === "invalid_glory"
            ? "that doesn't look like a valid Glory value."
            : `couldn't submit your Glory score (${res.error || "unknown error"}).`)
        );
      }
      logger.info("Player updated glory via Discord", { week: res.week, glory: res.glory });
      lines.push(`• **Glory** (week of ${res.week}): ${res.glory!.toLocaleString("en-US")}`);
    }

    return ephemeral(`✅ Updated:\n${lines.join("\n")}`);
  }

  if (commandName === "timezone") {
    const resolved = await resolveLinkedAccount(admin, discordUserId);
    if (!resolved.ok) return ephemeral(resolved.message, undefined, resolved.components);

    const offset = Number(getOptionValue(interaction.data?.options, "offset"));
    const res = await updatePlayerTimezone(admin, resolved.uid, resolved.guild, offset);
    if (!res.ok) return ephemeral("Couldn't update your timezone. Please try again later.");
    logger.info("Player updated timezone via Discord", { offset });
    return ephemeral(`Timezone set to **UTC${offset >= 0 ? "+" : ""}${offset}**.`);
  }

  if (commandName === "challenges") {
    const resolved = await resolveLinkedAccount(admin, discordUserId);
    if (!resolved.ok) return ephemeral(resolved.message, undefined, resolved.components);

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
    if (!resolved.ok) return ephemeral(resolved.message, undefined, resolved.components);

    const sub = interaction.data?.options?.[0];
    const subName: string = sub?.name || "";
    const subOptions = sub?.options;

    // `set` was retired on 2026-09-28: /absent does the same write AND alerts the
    // officer channel, which this never did. `list` and `cancel` stay, because
    // nothing else offers them -- /absences lists the GUILD's absences, not
    // the caller's own.
    if (subName === "set") {
      return ephemeral("Use `/absent <start_date> <end_date> [reason]` to declare an absence — it also notifies your officers.");
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
