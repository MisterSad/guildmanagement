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
 * there.
 *
 * TWO GUARDS, added 2026-09-28 (ADR-020), because a tag read off a
 * screenshot used to be enough to be handed a guild's Discord role AND to be
 * written into that guild's roster:
 *
 *  1. A tag only ever resolves among the guilds that share the verification
 *     channel's own `guilds.server_number`. A guild carrying the same tag on
 *     another game server resolves to nothing, so it can neither be granted
 *     nor be blocked by a screenshot from elsewhere. The scope is read from
 *     data -- there is no game-server literal and no tenant name in this file.
 *  2. When the target guild has `guild_config.discord_verification_require_roster
 *     = 'true'`, the roster is the authority: the role is granted only to a
 *     player who is already in `guild_members` for that guild. Nothing is
 *     inserted. Everyone else is refused with `not_on_roster`, which the
 *     caller turns into the "pending" state.
 *
 * Trust model unchanged otherwise: this only ever writes to guild_members
 * (roster/stats), never to accounts.
 */
import { logPlayerAction } from "./player-actions.ts";
import type { AdminClient } from "./db.ts";

export const AUDIT_SERVICE = "discord-profile-verification";

// One read of a roster, bounded (AGENTS rule 3). The largest guild in
// production holds 200 members, so this cap is never reached in practice --
// and a read that DOES come back at the cap is reported as an error, never as
// "this player is absent", because refusing a real member on a truncated read
// is the one failure that would look exactly like the feature working.
export const ROSTER_SCAN_CAP = 5000;

export function normalizeTag(raw: string | null | undefined): string {
  return (raw || "").replace(/[[\]]/g, "").trim().toUpperCase();
}

/**
 * The bracketed display form of a tag, mirroring getGuildTag() in
 * src/core/config/guild-config.ts so the two sides cannot drift.
 *
 * There is deliberately NO table of per-guild default tags here. One used to
 * exist (ALPHA -> [PR1M], ...); the frontend copy was deleted as an ADR-003
 * violation (finding H2) after two of its seven values turned out to be wrong,
 * and this copy is the same violation. A guild with no stored `guild_tag` falls
 * back to its own id, from data.
 */
export function bracketed(raw: string | null | undefined): string {
  const t = (raw || "").trim();
  if (!t) return "";
  if (t.startsWith("[") && t.endsWith("]")) return t;
  return `[${t}]`;
}

export async function resolveExpectedTag(admin: AdminClient, fgfGuild: string): Promise<string> {
  const { data: tagConfigRow } = await admin
    .from("guild_config")
    .select("value")
    .eq("guild", fgfGuild)
    .eq("key", "guild_tag")
    .maybeSingle();
  const stored = (tagConfigRow as { value?: string } | null)?.value;
  return bracketed(stored && stored.trim() ? stored : fgfGuild);
}

/** The game-server number of the guild this verification channel belongs to. */
export async function resolveHomeServerNumber(admin: AdminClient, fgfGuild: string): Promise<string | null> {
  const { data: guildRow } = await admin.from("guilds").select("server_number").eq("id", fgfGuild).maybeSingle();
  const raw = (guildRow as { server_number?: string | null } | null)?.server_number;
  const trimmed = (raw || "").trim();
  return trimmed ? trimmed : null;
}

export type TagResolution =
  | { kind: "match"; fgfGuild: string; tagDisplay: string; serverNumber: string }
  | { kind: "none" }
  | { kind: "ambiguous"; serverNumber: string; candidates: string[] }
  | { kind: "home_server_unknown"; homeGuild: string };

/**
 * Inverse of resolveExpectedTag, scoped to one game server.
 *
 * The previous version scanned every tenant's `guild_config`, so a tag
 * resolved across game servers: a screenshot from another server's guild that
 * happened to share a tag would resolve here, and the first row that iterated
 * silently won a collision. Now the candidates are exactly the guilds sharing
 * `homeServerNumber`, a collision is reported as `ambiguous` rather than
 * guessed, and a missing home server number fails visibly instead of widening
 * back to a global scan.
 */
export async function resolveTagToGuildOnServer(
  admin: AdminClient,
  tagNormalized: string,
  homeServerNumber: string | null,
  homeGuild: string
): Promise<TagResolution> {
  if (!tagNormalized) return { kind: "none" };
  if (!homeServerNumber) return { kind: "home_server_unknown", homeGuild };

  const { data: guildRows } = await admin.from("guilds").select("id").eq("server_number", homeServerNumber);

  const ids = ((guildRows as { id: string }[]) || []).map((r) => r.id).filter(Boolean);
  if (ids.length === 0) return { kind: "none" };

  const { data: tagRows } = await admin
    .from("guild_config")
    .select("guild, value")
    .eq("key", "guild_tag")
    .in("guild", ids);

  const stored = new Map<string, string>();
  for (const row of (tagRows as { guild: string; value?: string }[]) || []) {
    const value = (row.value || "").trim();
    if (value) stored.set(row.guild, value);
  }

  const matches: { fgfGuild: string; tagDisplay: string }[] = [];
  for (const id of ids) {
    const tagDisplay = bracketed(stored.get(id) || id);
    if (normalizeTag(tagDisplay) === tagNormalized) matches.push({ fgfGuild: id, tagDisplay });
  }

  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      serverNumber: homeServerNumber,
      candidates: matches.map((m) => m.fgfGuild).sort(),
    };
  }
  return {
    kind: "match",
    fgfGuild: matches[0].fgfGuild,
    tagDisplay: matches[0].tagDisplay,
    serverNumber: homeServerNumber,
  };
}

/**
 * Whether a stored UID is a real in-game identifier or a placeholder.
 *
 * Same rule as getUidStatus() in src/modules/ocr/ocr.service.ts: missing,
 * TEMP-/TMP- (what the roster OCR generates when the member list screen shows
 * no UID -- 11 OMEGA and 55 PSA rows in production carry one), non-numeric, or
 * outside the 6-10 digit game range. The two copies exist because a Deno Edge
 * Function cannot import from src/; tests/discord_verification.test.js pins
 * them to a shared case table.
 */
export function isPlaceholderUid(uid: string | null | undefined): boolean {
  const clean = (uid || "").trim();
  if (!clean || clean === "-") return true;
  if (/^TEMP[-_]/i.test(clean) || /^TMP[-_]/i.test(clean) || clean.toUpperCase() === "TEMP") return true;
  if (!/^[0-9]+$/.test(clean)) return true;
  return clean.length < 6 || clean.length > 10;
}

function normalizePseudo(raw: string | null | undefined): string {
  return (raw || "").normalize("NFKC").trim().toLowerCase();
}

export type RosterMatch =
  | { kind: "uid_match"; pseudo: string; uid: string; overallPower: number }
  | { kind: "pseudo_claim"; pseudo: string; overallPower: number; staleUid: string | null }
  | { kind: "pseudo_conflict"; pseudo: string; onFileUid: string }
  | { kind: "ambiguous_pseudo"; pseudo: string; count: number }
  | { kind: "scan_truncated" }
  | { kind: "absent" };

interface RosterRow {
  pseudo: string;
  uid: string | null;
  overall_power: number | null;
}

/**
 * Is this player already in that guild's member list?
 *
 * One bounded read, then matched in JS. Deliberately NOT an `ilike` filter on
 * OCR output: `%` and `_` in a pseudo are wildcards to PostgREST, which is
 * finding M16 all over again -- a pseudo containing `%` would match half the
 * roster.
 */
export async function findRosterMember(
  admin: AdminClient,
  fgfGuild: string,
  uid: string,
  pseudo: string
): Promise<RosterMatch> {
  const { data, error } = await admin
    .from("guild_members")
    .select("pseudo, uid, overall_power")
    .eq("guild", fgfGuild)
    .limit(ROSTER_SCAN_CAP);

  if (error) return { kind: "scan_truncated" };
  const rows = (data as RosterRow[]) || [];
  if (rows.length >= ROSTER_SCAN_CAP) return { kind: "scan_truncated" };

  const wantedUid = (uid || "").trim();
  if (wantedUid) {
    const byUid = rows.find((r) => (r.uid || "").trim() === wantedUid);
    if (byUid) {
      return {
        kind: "uid_match",
        pseudo: byUid.pseudo,
        uid: wantedUid,
        overallPower: Number(byUid.overall_power) || 0,
      };
    }
  }

  const wantedPseudo = normalizePseudo(pseudo);
  if (!wantedPseudo) return { kind: "absent" };

  const byPseudo = rows.filter((r) => normalizePseudo(r.pseudo) === wantedPseudo);
  if (byPseudo.length === 0) return { kind: "absent" };
  // UNIQUE (guild, pseudo) is case-SENSITIVE, so it does not guarantee one row
  // per lowercased name. Measured zero collisions across all 28 guilds today;
  // refuse rather than pick if that ever changes.
  if (byPseudo.length > 1) {
    return { kind: "ambiguous_pseudo", pseudo: byPseudo[0].pseudo, count: byPseudo.length };
  }

  const row = byPseudo[0];
  const onFileUid = (row.uid || "").trim();
  if (isPlaceholderUid(onFileUid)) {
    return {
      kind: "pseudo_claim",
      pseudo: row.pseudo,
      overallPower: Number(row.overall_power) || 0,
      staleUid: onFileUid || null,
    };
  }
  // A real, different UID on file: a rename or an impostor. An officer decides.
  return { kind: "pseudo_conflict", pseudo: row.pseudo, onFileUid };
}

/** Opt-in per guild (owner decision): absent means the historical behaviour. */
export async function requiresRosterMembership(admin: AdminClient, fgfGuild: string): Promise<boolean> {
  const { data: row } = await admin
    .from("guild_config")
    .select("value")
    .eq("guild", fgfGuild)
    .eq("key", "discord_verification_require_roster")
    .maybeSingle();
  return ((row as { value?: string } | null)?.value || "").trim() === "true";
}

/**
 * Which OTHER guilds hold a roster row with this UID.
 *
 * Information for the officer message and the audit trail, never a verdict.
 * The old code asked `gm_find_player_by_uid`, which is guild-blind
 * (`WHERE uid = ... ORDER BY created_at DESC LIMIT 1`) and refused the
 * legitimate member of whichever guild happened to be older -- four real
 * members are in that position in production today.
 */
export async function findOtherGuildMemberships(admin: AdminClient, fgfGuild: string, uid: string): Promise<string[]> {
  const clean = (uid || "").trim();
  if (!clean) return [];
  const { data } = await admin.from("guild_members").select("guild").eq("uid", clean).neq("guild", fgfGuild);
  return [...new Set(((data as { guild: string }[]) || []).map((r) => r.guild).filter(Boolean))].sort();
}

export async function resolveAuditChannelId(admin: AdminClient, fgfGuild: string): Promise<string | null> {
  const { data: rows } = await admin
    .from("guild_config")
    .select("key, value")
    .eq("guild", fgfGuild)
    .in("key", ["discord_audit_channel_id", "discord_officer_channel_id"]);
  const map = new Map((rows || []).map((r: { key: string; value?: string }) => [r.key, (r.value || "").trim()]));
  return map.get("discord_audit_channel_id") || map.get("discord_officer_channel_id") || null;
}

/**
 * Posts a durable message to a guild's Discord audit channel.
 *
 * Deliberately NOT the auto-deleting variant used for verification replies:
 * this is the record of a privileged action, so it must survive. Best-effort
 * by design — an announcement that fails must never fail the action it
 * describes, because the database write is the authoritative audit trail and
 * Discord is the notification.
 *
 * `allowed_mentions: { parse: [] }` is not optional: an account id or guild
 * name containing `@everyone` would otherwise ping the whole server.
 */
export async function postAuditMessage(channelId: string, content: string): Promise<boolean> {
  const token = Deno.env.get("DISCORD_BOT_TOKEN");
  if (!token || !channelId) return false;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Posts a message (content, embeds, components) to a channel as the bot.
 * Mentions are always disabled. Returns whether Discord accepted it.
 */
export async function postChannelMessage(
  channelId: string,
  message: { content?: string; embeds?: unknown[]; components?: unknown[] }
): Promise<boolean> {
  const token = Deno.env.get("DISCORD_BOT_TOKEN");
  if (!token || !/^\d{17,20}$/.test(channelId || "")) return false;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Replaces a message the bot posted (content and components). Used to strip the
 * buttons off a join request once it is decided, so nobody clicks a stale one.
 */
export async function editChannelMessage(
  channelId: string,
  messageId: string,
  message: { content?: string; components?: unknown[] }
): Promise<boolean> {
  const token = Deno.env.get("DISCORD_BOT_TOKEN");
  if (!token || !/^\d{17,20}$/.test(channelId || "") || !/^\d{17,20}$/.test(messageId || "")) return false;
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Sends a direct message from the bot to one Discord user.
 *
 * Best-effort, like `postAuditMessage`: a person who blocks DMs from server
 * members, or who shares no server with the bot, makes Discord refuse the
 * channel or the message, and that must never fail the action being notified.
 * Returns whether Discord accepted it, for the caller's log line only.
 *
 * The recipient id must come from `discord_account_links`, never from a
 * request body: this is the bot speaking, and it only speaks to the person the
 * database says the account belongs to.
 */
export async function sendDirectMessage(discordUserId: string, content: string): Promise<boolean> {
  const token = Deno.env.get("DISCORD_BOT_TOKEN");
  if (!token || !/^\d{17,20}$/.test(discordUserId || "")) return false;
  const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };
  try {
    const ch = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers,
      body: JSON.stringify({ recipient_id: discordUserId }),
    });
    if (!ch.ok) return false;
    const channel = await ch.json();
    const channelId = String(channel?.id ?? "");
    if (!channelId) return false;
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ExtractedProfile {
  pseudo: string;
  uid: string;
  power: number;
  glory: number | null;
  serverNumber?: string | null;
}

export type RefusalReason = "absent" | "pseudo_conflict" | "ambiguous_pseudo" | "scan_truncated";

export type VerificationResult =
  | { ok: false; error: "banned" }
  | { ok: false; error: "db_error" }
  | {
      ok: false;
      error: "not_on_roster";
      reason: RefusalReason;
      onFileUid?: string;
      otherGuilds: string[];
    }
  | {
      ok: true;
      finalPseudo: string;
      isNewPlayer: boolean;
      power: number;
      glory: number | null;
      previousPower?: number | null;
      uidBackfilled?: boolean;
      otherGuilds: string[];
    };

async function logRefusal(
  admin: AdminClient,
  fgfGuild: string,
  discordUserId: string,
  extracted: ExtractedProfile,
  reason: RefusalReason,
  otherGuilds: string[],
  detail: Record<string, unknown> = {}
): Promise<void> {
  await logPlayerAction(admin, {
    action_type: "discord_verification_refused",
    pseudo: extracted.pseudo,
    uid: extracted.uid,
    guild: fgfGuild,
    service: AUDIT_SERVICE,
    level: "WARN",
    message:
      `Refused a Discord screenshot verification for ${extracted.pseudo} (${extracted.uid}) in ${fgfGuild}: ${reason}` +
      (otherGuilds.length ? ` -- that UID is on the roster of ${otherGuilds.join(", ")}` : ""),
    metadata: {
      discord_user_id: discordUserId,
      reason,
      other_guilds: otherGuilds,
      power: extracted.power,
      glory: extracted.glory,
      ...detail,
    },
  });
}

/**
 * Every ban / roster / gate decision for the guild whose tag matched.
 *
 * Called only once the caller has resolved a live Discord role matching that
 * guild's tag (see discord-profile-verification/index.ts). Tag matching and
 * the Discord side are the caller's job; this function's job is strictly what
 * the roster says.
 */
export async function evaluateVerification(
  admin: AdminClient,
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

  const match = await findRosterMember(admin, fgfGuild, extracted.uid, extracted.pseudo);
  const otherGuilds = await findOtherGuildMemberships(admin, fgfGuild, extracted.uid);

  // These three are refused whether or not the gate is on. With the gate off
  // an INSERT would either hit UNIQUE (guild, pseudo) and surface as a
  // meaningless db_error, or -- on a truncated read -- enrol a member who is
  // already there. An explicit refusal is strictly better in both cases.
  if (match.kind === "scan_truncated") {
    await logRefusal(admin, fgfGuild, discordUserId, extracted, "scan_truncated", otherGuilds);
    return { ok: false, error: "not_on_roster", reason: "scan_truncated", otherGuilds };
  }
  if (match.kind === "ambiguous_pseudo") {
    await logRefusal(admin, fgfGuild, discordUserId, extracted, "ambiguous_pseudo", otherGuilds, {
      matching_rows: match.count,
    });
    return { ok: false, error: "not_on_roster", reason: "ambiguous_pseudo", otherGuilds };
  }
  if (match.kind === "pseudo_conflict") {
    await logRefusal(admin, fgfGuild, discordUserId, extracted, "pseudo_conflict", otherGuilds, {
      on_file_uid: match.onFileUid,
    });
    return {
      ok: false,
      error: "not_on_roster",
      reason: "pseudo_conflict",
      onFileUid: match.onFileUid,
      otherGuilds,
    };
  }

  if (match.kind === "absent") {
    if (await requiresRosterMembership(admin, fgfGuild)) {
      await logRefusal(admin, fgfGuild, discordUserId, extracted, "absent", otherGuilds);
      return { ok: false, error: "not_on_roster", reason: "absent", otherGuilds };
    }

    const { error: insertErr } = await admin.from("guild_members").insert({
      pseudo: extracted.pseudo,
      uid: extracted.uid,
      guild: fgfGuild,
      overall_power: extracted.power,
      glory_score: extracted.glory || 0,
      role: "R1",
    });
    if (insertErr) return { ok: false, error: "db_error" };

    await logPlayerAction(admin, {
      action_type: "discord_verification",
      pseudo: extracted.pseudo,
      uid: extracted.uid,
      guild: fgfGuild,
      service: AUDIT_SERVICE,
      message: `Verified via Discord screenshot: ${extracted.pseudo} (${extracted.uid}) -- power ${extracted.power.toLocaleString("en-US")} [new player added to roster]`,
      metadata: {
        discord_user_id: discordUserId,
        power: extracted.power,
        glory: extracted.glory,
        is_new_player: true,
        other_guilds: otherGuilds,
      },
    });

    return {
      ok: true,
      finalPseudo: extracted.pseudo,
      isNewPlayer: true,
      power: extracted.power,
      glory: extracted.glory,
      otherGuilds,
    };
  }

  // Already on this guild's roster: update stats only, never identity.
  const finalPseudo = match.pseudo;
  const uidBackfilled = match.kind === "pseudo_claim";
  const staleUid = match.kind === "pseudo_claim" ? match.staleUid : null;
  const update: Record<string, unknown> = {
    overall_power: extracted.power || match.overallPower,
    ...(extracted.glory != null ? { glory_score: extracted.glory } : {}),
    // pseudo_claim: the roster row holds no real UID yet, so the one read off
    // the screenshot is written to it.
    ...(uidBackfilled ? { uid: extracted.uid } : {}),
  };

  // uid_match keys on the UID; pseudo_claim keys on the on-file pseudo, which
  // is UNIQUE (guild, pseudo) -- there is no unique index on (guild, uid).
  const { error: updateErr } = uidBackfilled
    ? await admin.from("guild_members").update(update).eq("guild", fgfGuild).eq("pseudo", finalPseudo)
    : await admin.from("guild_members").update(update).eq("guild", fgfGuild).eq("uid", extracted.uid);
  if (updateErr) return { ok: false, error: "db_error" };
  await logPlayerAction(admin, {
    action_type: "discord_verification",
    pseudo: finalPseudo,
    uid: extracted.uid,
    guild: fgfGuild,
    service: AUDIT_SERVICE,
    message:
      `Verified via Discord screenshot: ${finalPseudo} (${extracted.uid}) -- power ${extracted.power.toLocaleString("en-US")} [existing player]` +
      (uidBackfilled ? ` [UID backfilled, was ${staleUid || "empty"}]` : ""),
    metadata: {
      discord_user_id: discordUserId,
      power: extracted.power,
      glory: extracted.glory,
      is_new_player: false,
      matched_on: match.kind,
      ...(uidBackfilled ? { uid_backfilled: true, previous_uid: staleUid } : {}),
      other_guilds: otherGuilds,
    },
  });

  return {
    ok: true,
    finalPseudo,
    isNewPlayer: false,
    power: extracted.power,
    glory: extracted.glory,
    previousPower: match.overallPower,
    ...(uidBackfilled ? { uidBackfilled: true } : {}),
    otherGuilds,
  };
}
