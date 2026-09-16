/**
 * supabase/functions/_shared/discord-verification.ts
 *
 * Pure-ish decision logic for the Discord profile-verification feature,
 * extracted out of discord-profile-verification/index.ts so it can be
 * exercised with real execution against a fake Supabase client in tests
 * (same pattern as _shared/player-actions.ts), rather than only static
 * regex checks on the Deno.serve handler. The handler stays a thin caller:
 * OCR, the Discord role-by-tag-name lookup (owner's rule: assign the role
 * matching the guild tag if it already exists on the server, else
 * "Visitor" -- decided entirely from the server's live role list, which
 * only the handler can fetch), and the confirmation/error reply all live
 * there. This module only runs once the handler has already confirmed a
 * matching guild role exists -- the Visitor path never reaches it, so no
 * guild_members row is ever created/updated for an unrecognized tag.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logPlayerAction } from "./player-actions.ts";

// Same default tags gm-utils.js's getGuildTag() falls back to when no
// guild_config 'guild_tag' override is set for that guild.
export const DEFAULT_GUILD_TAGS: Record<string, string> = {
  ALPHA: "[PR1M]",
  OMEGA: "[OMG]",
  BABE: "[BABE]",
  IMK: "[IMK]",
  YARR: "[YARR]",
  CLAW: "[CLAW]",
  DEMO: "[DEMO]",
};

export function normalizeTag(raw: string | null | undefined): string {
  return (raw || "").replace(/[\[\]]/g, "").trim().toUpperCase();
}

export async function resolveExpectedTag(
  admin: ReturnType<typeof createClient>,
  fgfGuild: string
): Promise<string> {
  const { data: tagConfigRow } = await admin
    .from("guild_config")
    .select("value")
    .eq("guild", fgfGuild)
    .eq("key", "guild_tag")
    .maybeSingle();
  const stored = (tagConfigRow as { value?: string } | null)?.value;
  if (stored && stored.trim()) return stored.trim();
  return DEFAULT_GUILD_TAGS[fgfGuild] || `[${fgfGuild}]`;
}

export interface TagGuildMatch {
  fgfGuild: string;
  tagDisplay: string;
  serverNumber: string | null;
}

// Inverse of resolveExpectedTag: given a normalized tag (from an OCR read),
// find which FGF guild (if any) it belongs to -- checked across every
// guild_config 'guild_tag' override first, then the same DEFAULT_GUILD_TAGS
// fallback resolveExpectedTag itself falls back to for guilds with no
// override. Needed so the Visitor path can still set a "[TAG] Pseudo
// #Server" nickname even when the screenshot's guild isn't the one this
// verification channel belongs to (e.g. an ally posting in a shared
// channel), not just when it matches the channel's own guild.
export async function resolveTagToGuild(
  admin: ReturnType<typeof createClient>,
  tagNormalized: string
): Promise<TagGuildMatch | null> {
  if (!tagNormalized) return null;

  const { data: overrideRows } = await admin
    .from("guild_config")
    .select("guild, value")
    .eq("key", "guild_tag");

  const overridden = new Set<string>();
  for (const row of ((overrideRows as { guild: string; value: string }[]) || [])) {
    overridden.add(row.guild);
    if (row.value && normalizeTag(row.value) === tagNormalized) {
      return withServerNumber(admin, row.guild, row.value.trim());
    }
  }

  for (const [guildId, tagValue] of Object.entries(DEFAULT_GUILD_TAGS)) {
    if (overridden.has(guildId)) continue; // that guild's override already lost the match above
    if (normalizeTag(tagValue) === tagNormalized) {
      return withServerNumber(admin, guildId, tagValue);
    }
  }

  return null;
}

async function withServerNumber(
  admin: ReturnType<typeof createClient>,
  fgfGuild: string,
  tagDisplay: string
): Promise<TagGuildMatch> {
  const { data: guildRow } = await admin.from("guilds").select("server_number").eq("id", fgfGuild).maybeSingle();
  return { fgfGuild, tagDisplay, serverNumber: (guildRow as { server_number?: string } | null)?.server_number || null };
}

export async function resolveAuditChannelId(
  admin: ReturnType<typeof createClient>,
  fgfGuild: string
): Promise<string | null> {
  const { data: rows } = await admin
    .from("guild_config")
    .select("key, value")
    .eq("guild", fgfGuild)
    .in("key", ["discord_audit_channel_id", "discord_officer_channel_id"]);
  const map = new Map((rows || []).map((r: { key: string; value?: string }) => [r.key, (r.value || "").trim()]));
  return map.get("discord_audit_channel_id") || map.get("discord_officer_channel_id") || null;
}

export interface ExtractedProfile {
  pseudo: string;
  uid: string;
  power: number;
  glory: number | null;
}

export type VerificationResult =
  | { ok: false; error: "banned" }
  | { ok: false; error: "uid_registered_elsewhere" }
  | { ok: false; error: "db_error" }
  | { ok: true; finalPseudo: string; isNewPlayer: boolean; power: number; glory: number | null; previousPower?: number | null };

// Called only once the caller has already resolved a live Discord role
// matching the guild's tag (see discord-profile-verification/index.ts) --
// this function's job is strictly the guild_members / ban / cross-guild
// decision, not tag matching.
export async function evaluateVerification(
  admin: ReturnType<typeof createClient>,
  fgfGuild: string,
  discordUserId: string,
  extracted: ExtractedProfile
): Promise<VerificationResult> {
  const { data: banRow } = await admin
    .from("banned_players")
    .select("uid")
    .eq("guild", fgfGuild)
    .eq("uid", extracted.uid)
    .maybeSingle();
  if (banRow) {
    return { ok: false, error: "banned" };
  }

  const { data: findRes } = await admin.rpc("gm_find_player_by_uid", { p_uid: extracted.uid });
  const found = !!(findRes as { found?: boolean } | null)?.found;
  const existingPlayer = found
    ? (findRes as { player: { pseudo: string; guild: string; overall_power: number } }).player
    : null;

  if (existingPlayer && existingPlayer.guild !== fgfGuild) {
    return { ok: false, error: "uid_registered_elsewhere" };
  }

  let finalPseudo = extracted.pseudo;

  if (existingPlayer) {
    finalPseudo = existingPlayer.pseudo;
    const { error: updateErr } = await admin
      .from("guild_members")
      .update({
        overall_power: extracted.power || existingPlayer.overall_power,
        ...(extracted.glory != null ? { glory_score: extracted.glory } : {}),
      })
      .eq("guild", fgfGuild)
      .eq("uid", extracted.uid);
    if (updateErr) return { ok: false, error: "db_error" };
  } else {
    const { error: insertErr } = await admin.from("guild_members").insert({
      pseudo: extracted.pseudo,
      uid: extracted.uid,
      guild: fgfGuild,
      overall_power: extracted.power,
      glory_score: extracted.glory || 0,
      role: "R1",
    });
    if (insertErr) return { ok: false, error: "db_error" };
  }

  await logPlayerAction(admin, {
    action_type: "discord_verification",
    pseudo: finalPseudo,
    uid: extracted.uid,
    guild: fgfGuild,
    message: `Verified via Discord screenshot: ${finalPseudo} (${extracted.uid}) -- power ${extracted.power.toLocaleString("en-US")}${existingPlayer ? " [existing player]" : " [new player added to roster]"}`,
    metadata: { discord_user_id: discordUserId, power: extracted.power, glory: extracted.glory, is_new_player: !existingPlayer },
  });

  return {
    ok: true,
    finalPseudo,
    isNewPlayer: !existingPlayer,
    power: extracted.power,
    glory: extracted.glory,
    ...(existingPlayer ? { previousPower: existingPlayer.overall_power } : {}),
  };
}
