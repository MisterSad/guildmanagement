/**
 * discord-verification-worker/server-provisioner.js
 *
 * Automated Discord server bootstrap and templating engine.
 * Takes any clean/empty Discord server and constructs a full guild infrastructure:
 * - Dynamic roles matching the guild tag (Leader R5, Officer R4, Member, Visitor).
 * - Full category and channel hierarchy mirroring the FGF Guild standard template.
 * - Dynamic channel names (slugified guild name & tag, server number).
 * - Multi-tier permission overwrites (Public, Visitors, Guild Members, R4/R5 Officers).
 * - Automatic binding of newly created verification & audit channels into Supabase `guild_config`.
 * - Rate-limit throttled sequential provisioning with real-time progress reporting.
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";

/**
 * Converts a text string into a clean lowercase slug suitable for Discord channel names.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeSlug(text) {
  if (!text) return "guild";
  return String(text)
    .toLowerCase()
    .replace(/[\[\]]/g, "")
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Builds the complete template blueprint for a target guild.
 * @param {Object} params
 * @param {string} params.guildName - e.g. "ALPHA" or "BABE"
 * @param {string} params.guildTag - e.g. "PR1M" or "BABE"
 * @param {string|number} params.serverNumber - e.g. "1058"
 * @returns {Object} Template definition with roles and categories
 */
export function buildServerTemplate({ guildName, guildTag, serverNumber }) {
  const cleanName = (guildName || "ALPHA").trim().toUpperCase();
  const cleanTag = (guildTag || cleanName).replace(/[\[\]]/g, "").trim().toUpperCase();
  // No "1000" fallback: handleSetupServer refuses to run without a real server
  // number, because that number is what scopes guild-tag resolution (ADR-020)
  // and the server_admin role.
  const cleanServer = String(serverNumber || "").replace(/[^0-9]/g, "");
  if (!cleanServer) throw new Error("server_number_required");

  const guildSlug = sanitizeSlug(cleanName);
  const tagSlug = sanitizeSlug(cleanTag);

  return {
    guildName: cleanName,
    guildTag: cleanTag,
    serverNumber: cleanServer,
    guildSlug,
    tagSlug,

    // Defined from lowest to highest in server hierarchy
    roles: [
      // The names here are a CONTRACT with discord-profile-verification, which
      // resolves roles by name: findRoleByNormalizedName compares
      // normalizeTag(role.name), and normalizeTag only strips brackets and
      // upper-cases. "👽 Visitor" therefore normalises to "👽 VISITOR",
      // which matched nothing -- every freshly provisioned server hit the
      // no_matching_role dead end. Personality goes in the colour, not the name.
      {
        key: "visitor",
        name: "[VISITOR]",
        color: 0x9b59b6, // Purple
        hoist: true,
        mentionable: true,
        permissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
        ],
      },
      {
        // Named exactly after the tag: this is the role the verification flow
        // grants, so the channel permissions attached to it land on verified
        // members. It used to be `🛡️ [TAG] Member`, which normalised to
        // "🛡️ [TAG] MEMBER" and could never be matched.
        key: "member",
        name: `[${cleanTag}]`,
        color: 0x2ecc71, // Green
        hoist: true,
        mentionable: true,
        permissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AddReactions,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
          PermissionFlagsBits.UseApplicationCommands,
        ],
      },
      {
        // Held by someone whose screenshot was read but who is not in the
        // guild's member list yet (ADR-020). Same read-only reach as a visitor:
        // the point is that officers can SEE them waiting.
        key: "pending",
        name: "[PENDING]",
        color: 0x3b82f6, // Blue
        hoist: true,
        mentionable: true,
        permissions: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AddReactions,
        ],
      },
      {
        key: "officer",
        name: `⭐ [${cleanTag}] R4`,
        color: 0x3498db, // Blue
        hoist: true,
        mentionable: true,
        permissions: [
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.MuteMembers,
          PermissionFlagsBits.DeafenMembers,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.MentionEveryone,
        ],
      },
      {
        key: "leader",
        name: `👑 [${cleanTag}] R5`,
        color: 0xf1c40f, // Gold
        hoist: true,
        mentionable: true,
        permissions: [
          PermissionFlagsBits.Administrator,
        ],
      },
    ],

    categories: [
      {
        name: "🛂 WELCOME",
        // Category baseline: readable by everyone, locked to send messages
        overwrites: {
          everyone: { ViewChannel: true, SendMessages: false },
          member: { ViewChannel: true, SendMessages: false },
          visitor: { ViewChannel: true, SendMessages: false },
        },
        channels: [
          {
            name: "🌀・teleportation",
            type: ChannelType.GuildText,
            topic: "Server rules and orientation teleportation hub.",
          },
          {
            name: "🔐・verification",
            type: ChannelType.GuildText,
            topic: "Post your in-game profile screenshot here to get verified and gain access.",
            // In verification channel, @everyone can post screenshots
            overwrites: {
              everyone: {
                ViewChannel: true,
                SendMessages: true,
                AttachFiles: true,
                ReadMessageHistory: true,
              },
            },
            isVerificationChannel: true,
          },
        ],
      },
      {
        name: "👽 CROSS SERVER VISITORS",
        overwrites: {
          everyone: { ViewChannel: false },
          visitor: { ViewChannel: true, SendMessages: true },
          member: { ViewChannel: true, SendMessages: true },
        },
        channels: [
          { name: "👋・visitors-chat", type: ChannelType.GuildText, topic: "Cross-server diplomacy and friendly visitor chat." },
          { name: "🚪・server-migration", type: ChannelType.GuildText, topic: "Player transfers, migration requests, and recruitment discussions." },
          { name: "📨・player-transfer-info", type: ChannelType.GuildText, topic: "Transfer windows and immigration schedules." },
        ],
      },
      {
        name: "GAME UPDATES",
        overwrites: {
          everyone: { ViewChannel: true, SendMessages: false },
          visitor: { ViewChannel: true, SendMessages: false },
          member: { ViewChannel: true, SendMessages: false },
          officer: { SendMessages: true },
        },
        channels: [
          { name: "📢・announcements", type: ChannelType.GuildText, topic: "Official game updates and leadership announcements." },
        ],
      },
      {
        name: "⌛ EVENT REMINDERS",
        overwrites: {
          everyone: { ViewChannel: true, SendMessages: false },
          visitor: { ViewChannel: true, SendMessages: false },
          member: { ViewChannel: true, SendMessages: false },
        },
        channels: [
          { name: "☠️・calamity-befalls", type: ChannelType.GuildText, topic: "Automated event alerts for Calamity Befalls." },
          { name: "💥・guild-vs-guild", type: ChannelType.GuildText, topic: "Automated reminders for Guild vs Guild (GvG) war." },
          { name: "⚔️・dominion-warzone", type: ChannelType.GuildText, topic: "Automated reminders for Dominion Warzone (SvS)." },
        ],
      },
      {
        name: `🪐 SERVER #${cleanServer}`,
        overwrites: {
          everyone: { ViewChannel: false },
          member: { ViewChannel: true, SendMessages: true },
          visitor: { ViewChannel: true, SendMessages: true },
        },
        channels: [
          {
            name: "🚓・server-rules",
            type: ChannelType.GuildText,
            topic: `Server #${cleanServer} laws and combat guidelines.`,
            overwrites: {
              member: { SendMessages: false },
              visitor: { SendMessages: false },
              officer: { SendMessages: true },
            },
            isRulesChannel: true,
          },
          { name: "💬・universe-chat", type: ChannelType.GuildText, topic: "General server community discussion." },
          { name: "😂・memes", type: ChannelType.GuildText, topic: "Game memes and humor." },
          { name: "📸・screenshots-n-videos", type: ChannelType.GuildText, topic: "Media and screenshots." },
          { name: "✨・show-off", type: ChannelType.GuildText, topic: "Lucky rolls, upgrades, and battle achievements." },
          { name: "🎁・gift-codes", type: ChannelType.GuildText, topic: "Active promotional redemption codes." },
          { name: "🐱・only-pets", type: ChannelType.GuildText, topic: "Furry companions and pet pictures." },
          { name: "📖・fgf-wiki", type: ChannelType.GuildText, topic: "Game knowledge and documentation." },
          { name: "💡・tips-and-guides", type: ChannelType.GuildText, topic: "Strategy guides and tips." },
          { name: "🎬・clips-and-highlights", type: ChannelType.GuildText, topic: "Epic war highlights and tournament clips." },
        ],
      },
      {
        name: "🚨 DOMINION WARZONE",
        overwrites: {
          everyone: { ViewChannel: false },
          visitor: { ViewChannel: false },
          member: { ViewChannel: true, SendMessages: true },
        },
        channels: [
          { name: "💬・discussion", type: ChannelType.GuildText, topic: "SvS Warzone strategy discussion." },
          { name: "🗺️・plan", type: ChannelType.GuildText, topic: "War map assignments and staging zones." },
          {
            name: "🎯・battle-plans",
            type: ChannelType.GuildText,
            topic: "Classified battle plans and targeting orders.",
            overwrites: {
              member: { SendMessages: false },
              officer: { SendMessages: true },
            },
          },
          { name: "🧩・intel", type: ChannelType.GuildText, topic: "Enemy fleet scouting and war intelligence." },
          { name: "📊・svs-results", type: ChannelType.GuildText, topic: "War scoreboard and after-action combat reports." },
          { name: "🛰️・dominion-coordination", type: ChannelType.GuildVoice, topic: "Dominion Warzone voice command channel." },
        ],
      },
      {
        name: `🔴 ${cleanName}`,
        overwrites: {
          everyone: { ViewChannel: false },
          visitor: { ViewChannel: false },
          member: { ViewChannel: true, SendMessages: true },
          officer: { ViewChannel: true, SendMessages: true },
        },
        channels: [
          { name: `📡・${guildSlug}-chat`, type: ChannelType.GuildText, topic: `${cleanName} main private guild chat.` },
          { name: "🚀・arms-race", type: ChannelType.GuildText, topic: "Arms race objectives and event milestones." },
          { name: "🛡️・defend-trade-route", type: ChannelType.GuildText, topic: "Trade convoy defense operations." },
          { name: "🌑・shadowfront", type: ChannelType.GuildText, topic: "Shadowfront coordination and timings." },
          { name: "📊・shadowfront-battle-report", type: ChannelType.GuildText, topic: "Shadowfront combat logs." },
          { name: `🗓️・${tagSlug}-leave-and-absence`, type: ChannelType.GuildText, topic: "Official absence notices and leave tracker." },
          { name: "📊・gvg-intel", type: ChannelType.GuildText, topic: "Guild vs Guild scouting and opponent stats." },
          {
            name: "👑・r4-chat",
            type: ChannelType.GuildText,
            topic: "Classified leadership room for R4 Officers and R5 Leaders.",
            overwrites: {
              member: { ViewChannel: false },
              officer: { ViewChannel: true, SendMessages: true },
            },
            isAuditChannel: true,
          },
          { name: `🎧・${tagSlug}-voice`, type: ChannelType.GuildVoice, topic: `${cleanName} squad voice comms.` },
          {
            name: "R4 VC",
            type: ChannelType.GuildVoice,
            topic: "Officers tactical voice conference.",
            overwrites: {
              member: { ViewChannel: false },
              officer: { ViewChannel: true, Connect: true, Speak: true },
            },
          },
        ],
      },
    ],
  };
}

/**
 * Small delay helper to avoid hitting Discord rate limits (429 Too Many Requests).
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds permission overwrite objects for a Discord channel or category.
 */
function buildOverwrites(discordGuild, templateOverwrites, roleMap) {
  const result = [];
  const everyoneRole = discordGuild.roles.everyone;

  if (templateOverwrites?.everyone) {
    const allow = [];
    const deny = [];
    for (const [perm, granted] of Object.entries(templateOverwrites.everyone)) {
      if (PermissionFlagsBits[perm]) {
        if (granted) allow.push(PermissionFlagsBits[perm]);
        else deny.push(PermissionFlagsBits[perm]);
      }
    }
    result.push({ id: everyoneRole.id, allow, deny });
  }

  for (const roleKey of ["visitor", "member", "officer", "leader"]) {
    const roleId = roleMap[roleKey]?.id;
    const rule = templateOverwrites?.[roleKey];
    if (roleId && rule) {
      const allow = [];
      const deny = [];
      for (const [perm, granted] of Object.entries(rule)) {
        if (PermissionFlagsBits[perm]) {
          if (granted) allow.push(PermissionFlagsBits[perm]);
          else deny.push(PermissionFlagsBits[perm]);
        }
      }
      if (allow.length > 0 || deny.length > 0) {
        result.push({ id: roleId, allow, deny });
      }
    }
  }

  return result;
}

/**
 * Provisions a complete Discord server according to the target guild blueprint.
 *
 * @param {import("discord.js").Guild} discordGuild - Discord guild instance
 * @param {Object} params
 * @param {string} params.guildName - e.g. "ALPHA"
 * @param {string} [params.guildTag] - e.g. "PR1M"
 * @param {string|number} [params.serverNumber] - e.g. "1058"
 * @param {boolean} [params.cleanMode] - If true, removes existing channels
 * @param {Object} context
 * @param {import("@supabase/supabase-js").SupabaseClient} context.supabase - Supabase client
 * @param {Function} [context.onProgress] - Optional progress callback: (percent, statusText) => Promise<void>
 * @returns {Promise<{ ok: boolean, error?: string, createdCounts?: Object, autoWired?: Object }>}
 */
export async function provisionDiscordServer(
  discordGuild,
  { guildName, guildTag, serverNumber, cleanMode = false, rateLimitDelayMs = 250 },
  { supabase, onProgress = async () => {} }
) {
  if (!discordGuild) return { ok: false, error: "discord_guild_required" };

  const template = buildServerTemplate({ guildName, guildTag, serverNumber });
  const roleMap = {};
  const throttle = async (extraMs = 0) => {
    const delay = rateLimitDelayMs + extraMs;
    if (delay > 0) await sleep(delay);
  };

  try {
    await onProgress(5, "Analyzing Discord server and preparing role hierarchy...");

    // 1. Clean mode: remove existing default channels if requested
    if (cleanMode) {
      await onProgress(10, "Cleaning pre-existing channels...");
      const existingChannels = await discordGuild.channels.fetch();
      for (const channel of existingChannels.values()) {
        if (channel && channel.deletable) {
          try {
            await channel.delete("FGF Server Provisioning Clean Mode");
            await throttle();
          } catch (err) {
            console.warn(`Could not delete channel ${channel.name}:`, err.message);
          }
        }
      }
    }

    // 2. Roles creation (Visitor -> Member -> Officer -> Leader)
    await onProgress(15, "Generating dynamic roles...");
    const existingRoles = await discordGuild.roles.fetch();

    for (const roleDef of template.roles) {
      let role = existingRoles.find((r) => r.name === roleDef.name);
      if (!role) {
        role = await discordGuild.roles.create({
          name: roleDef.name,
          color: roleDef.color,
          hoist: roleDef.hoist,
          mentionable: roleDef.mentionable,
          permissions: roleDef.permissions,
          reason: `FGF Server Provisioning for Guild [${template.guildName}]`,
        });
        await throttle();
      }
      roleMap[roleDef.key] = role;
    }

    // 3. Categories and Channels creation
    const totalCategories = template.categories.length;
    let categoryIndex = 0;
    let createdChannelCount = 0;
    let verificationChannel = null;
    let auditChannel = null;
    let rulesChannel = null;

    for (const catDef of template.categories) {
      categoryIndex++;
      const currentProgress = Math.round(25 + (categoryIndex / totalCategories) * 60);
      await onProgress(
        currentProgress,
        `Creating category [${catDef.name}] and sub-channels (${categoryIndex}/${totalCategories})...`
      );

      const categoryOverwrites = buildOverwrites(discordGuild, catDef.overwrites, roleMap);
      const category = await discordGuild.channels.create({
        name: catDef.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: categoryOverwrites,
        reason: `FGF Server Provisioning Category: ${catDef.name}`,
      });
      await throttle(50);

      for (const chDef of catDef.channels) {
        const channelOverwrites = chDef.overwrites
          ? buildOverwrites(discordGuild, chDef.overwrites, roleMap)
          : undefined;

        const channel = await discordGuild.channels.create({
          name: chDef.name,
          type: chDef.type,
          parent: category.id,
          topic: chDef.topic,
          permissionOverwrites: channelOverwrites,
          reason: `FGF Server Provisioning Channel: ${chDef.name}`,
        });
        createdChannelCount++;
        await throttle();

        if (chDef.isVerificationChannel) verificationChannel = channel;
        if (chDef.isAuditChannel) auditChannel = channel;
        if (chDef.isRulesChannel) rulesChannel = channel;
      }
    }

    // 4. Supabase auto-wiring into `guild_config`
    await onProgress(90, "Wiring configuration into FGF SaaS database...");
    const autoWired = {};

    if (supabase) {
      const configRows = [];
      const now = new Date().toISOString();

      if (verificationChannel) {
        configRows.push({
          guild: template.guildName,
          key: "discord_verification_channel_id",
          value: verificationChannel.id,
          updated_at: now,
        });
        autoWired.verificationChannelId = verificationChannel.id;
      }

      if (auditChannel) {
        configRows.push({
          guild: template.guildName,
          key: "discord_audit_channel_id",
          value: auditChannel.id,
          updated_at: now,
        });
        autoWired.auditChannelId = auditChannel.id;
      }

      // `discord_member_role_id` is deliberately NOT wired any more. The tag
      // role above already carries membership and is granted by the verification
      // flow itself; a second, additive role granted by the worker was a second
      // thing that could leak -- it was handed out on every successful outcome,
      // including visitors, until ADR-020. An admin who wants a separate
      // "Verified" role can still set the key by hand.

      if (configRows.length > 0) {
        const { error: upsertErr } = await supabase
          .from("guild_config")
          .upsert(configRows, { onConflict: "guild,key" });
        if (upsertErr) {
          console.error("Failed to auto-wire guild_config:", upsertErr.message);
        }
      }
    }

    // 5. Post introductory embeds in verification and rules channels
    await onProgress(95, "Publishing onboarding instructions...");
    if (verificationChannel) {
      try {
        await verificationChannel.send({
          embeds: [
            {
              title: `🔐 Welcome to ${template.guildName} — Profile Verification`,
              description:
                `To access private guild operations, please take a screenshot of your **in-game Commander Profile** and upload it here.\n\n` +
                `**Requirements:**\n` +
                `• Profile picture and player name must be clearly visible.\n` +
                `• Overall Power and Glory score visible.\n` +
                `• Your guild tag \`[${template.guildTag}]\` must match this guild.\n\n` +
                `*Our AI verification engine will review your screenshot instantly, rename your Discord nickname, assign your <@&${roleMap.member?.id || ""}> role, and auto-delete your screenshot for privacy.*`,
              color: 0x3498db,
              footer: { text: "FGF Guild Management Automated Verification System" },
            },
          ],
        });
      } catch (err) {
        console.warn("Could not post verification welcome message:", err.message);
      }
    }

    if (rulesChannel) {
      try {
        await rulesChannel.send({
          embeds: [
            {
              title: `🪐 Server #${template.serverNumber} Guidelines & Rules`,
              description:
                `Welcome to **Server #${template.serverNumber}**!\n\n` +
                `1. **Respect & Civility**: Treat every commander and ally with dignity.\n` +
                `2. **No Friendly Fire**: Observe designated peace treaties and safe farming zones.\n` +
                `3. **Event Discipline**: Show up on time for Calamity, GvG, and Dominion Warzone.\n` +
                `4. **Security**: Never share battle plans or R4 Intel outside authorized guild channels.\n\n` +
                `*For questions or recruitment inquiries, please head to the visitors channels.*`,
              color: 0xe67e22,
              footer: { text: `Server #${template.serverNumber} Command Central` },
            },
          ],
        });
      } catch (err) {
        console.warn("Could not post rules message:", err.message);
      }
    }

    await onProgress(100, "Server bootstrap complete!");

    return {
      ok: true,
      createdCounts: {
        roles: Object.keys(roleMap).length,
        categories: totalCategories,
        channels: createdChannelCount,
      },
      autoWired,
    };
  } catch (error) {
    console.error("Error during server provisioning:", error);
    return { ok: false, error: error.message || "provisioning_failed" };
  }
}
