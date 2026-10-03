/**
 * supabase/functions/admin-accounts/schemas.ts
 *
 * Zod schemas for every admin-accounts action body (AGENTS.md rule 3), and
 * the limits the actions enforce.
 */

import { z } from "https://esm.sh/zod@3.23.8";

// Per-action body schemas. Field names/shape mirror the manual extraction
// this replaces exactly — only bounds and type-safety are new, no business
// logic changes.
export const idField = z.string().trim().min(1).max(128);
export const guildField = z.string().trim().min(1).max(64).nullish();
export const ResetPasswordSchema = z.object({ id: idField });
export const CreateSchema = z.object({
  id: idField,
  // Accepted and ignored, for clients built before the server generated it.
  password: z.string().max(256).optional(),
  serverNumber: z.string().trim().max(32).nullish(),
  guild: guildField,
  role: z.string().trim().max(32).optional(),
});
export const UpdateRoleSchema = z.object({
  id: idField,
  role: z.string().trim().min(1).max(32),
  serverNumber: z.string().trim().max(32).nullish(),
  guild: guildField,
});
export const DeleteSchema = z.object({ id: idField });
export const DiscordUnlinkSchema = z.object({ id: idField });
/** A relink code has to survive a Discord conversation and a time zone. */
export const RELINK_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AdminInviteSchema = z.object({
  guild: guildField,
  role: z.enum(["guild_admin", "server_admin", "super_admin"]),
});
/** Same window as a relink code: long enough to cross a Discord conversation. */
export const INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Outstanding invitations per guild. A guardrail in code, per the owner's
 * decision -- changing it is a migration, not a settings toggle someone can
 * quietly raise. BABE has 11 admins today, so 5 open at once is generous.
 */
export const MAX_OPEN_INVITES_PER_GUILD = 5;
export const UpdateGuildSchema = z.object({ id: idField, guild: guildField });
export const SetJoinCodeSchema = z.object({ guild: guildField, code: z.string().trim().min(1).max(64) });
export const GetJoinCodeSchema = z.object({ guild: guildField });
export const ApproveRejectSchema = z.object({ id: idField });
export const GuildRequestIdSchema = z.object({ id: z.string().trim().uuid() });
export const RejectGuildRequestSchema = z.object({ id: z.string().trim().uuid(), reason: z.string().trim().max(500).nullish() });
