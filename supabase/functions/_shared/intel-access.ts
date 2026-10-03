/**
 * supabase/functions/_shared/intel-access.ts
 *
 * Who may read Migration Hub intel, for the service-role AI summary.
 *
 * `migration-summary` reads pages with the service role, so RLS does not stand
 * between the caller and the data: this is the check. It mirrors the wiki's own
 * policies:
 *   - Guild Intel: that guild's admins, server admins of the guild's server,
 *     super admins.
 *   - Server Intel: guild and server admins whose server is that server, super
 *     admins.
 *
 * It must be applied to the scope of the data actually read -- for a single
 * page, the PAGE's stored scope, guild and server, never the ones the request
 * claims. Checking the request's values is how any admin could summarise
 * another tenant's page by passing its id with their own guild in the body.
 */

import { isGuildAdmin, isServerAdmin, isSuperAdmin } from "./admin-authz.ts";

export interface IntelCaller {
  role: string | null;
  guild: string | null;
  serverNumber: string | null;
}

export interface IntelTarget {
  scope: "guild" | "server" | string;
  guildId: string | null;
  serverNumber: string | null;
  /** The server of `guildId`, looked up server-side (Guild Intel only). */
  guildServerNumber?: string | null;
}

export function canReadIntel(caller: IntelCaller, target: IntelTarget): boolean {
  if (isSuperAdmin(caller.role)) return true;
  if (!isGuildAdmin(caller.role) && !isServerAdmin(caller.role)) return false;

  if (target.scope === "guild") {
    if (!target.guildId) return false;
    if (isGuildAdmin(caller.role)) return !!caller.guild && caller.guild === target.guildId;
    return !!caller.serverNumber && !!target.guildServerNumber && caller.serverNumber === target.guildServerNumber;
  }

  if (target.scope === "server") {
    return !!caller.serverNumber && !!target.serverNumber && caller.serverNumber === target.serverNumber;
  }

  return false;
}
