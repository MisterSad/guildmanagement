/**
 * supabase/functions/_shared/admin-authz.ts
 *
 * Pure TypeScript authorization matrix for FGF Admin Account management.
 * Zero Deno-specific dependencies to allow direct testing under Vitest.
 */

export type Role = "super_admin" | "server_admin" | "guild_admin" | "member";

/**
 * Strict role normalization: only the canonical four roles are recognized.
 * Legacy in-game ranks ('R5', 'R4') and the historical 'admin' alias fall back
 * to "member" (lowest privilege) -- they must NOT grant admin powers now that
 * the accounts CHECK constraint forbids them. This mirrors the SQL helpers in
 * supabase/migrations/20260913130000_roles_rls_session_hardening.sql.
 */
export function normalizeRole(r: string | null | undefined): Role {
  if (!r) return "member";
  const s = String(r).toLowerCase().trim();
  if (s === "super_admin") return "super_admin";
  if (s === "server_admin") return "server_admin";
  if (s === "guild_admin") return "guild_admin";
  if (s === "member") return "member";
  return "member";
}

export interface CallerCtx {
  role: Role | null;
  guild: string | null;
  serverNumber: string | number | null;
}

export interface TargetCtx {
  role: Role | null;
  guild: string | null;
  serverNumber: string | number | null;
}

function normalizeServer(s: string | number | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const str = String(s).trim();
  return str.length > 0 ? str : null;
}

function normalizeGuild(g: string | null | undefined): string | null {
  if (!g) return null;
  const str = String(g).trim().toUpperCase();
  return str.length > 0 ? str : null;
}

/**
 * Returns the maximum role level an admin is allowed to assign/create/scope.
 * super_admin -> super_admin
 * server_admin -> guild_admin
 * guild_admin -> guild_admin
 * member/null -> null
 */
export function maxAssignableRole(role: Role | null): Role | null {
  if (!role) return null;
  if (role === "super_admin") return "super_admin";
  if (role === "server_admin") return "guild_admin";
  if (role === "guild_admin") return "guild_admin";
  return null;
}

/**
 * Checks whether a target guild (and its resolved server number) is within the caller's authorized scope.
 */
export function isGuildInScope(
  caller: CallerCtx,
  targetGuild: string | null,
  targetServer: string | number | null
): boolean {
  if (!caller.role) return false;
  if (caller.role === "super_admin") return true;

  const tGuild = normalizeGuild(targetGuild);
  const cGuild = normalizeGuild(caller.guild);
  const tServer = normalizeServer(targetServer);
  const cServer = normalizeServer(caller.serverNumber);

  if (caller.role === "server_admin") {
    if (!cServer) return false;
    return tServer !== null && tServer === cServer;
  }

  if (caller.role === "guild_admin") {
    if (!cGuild) return false;
    return tGuild !== null && tGuild === cGuild;
  }

  return false;
}

/**
 * Evaluates if a caller is authorized to manage (reset-password, delete, scope, approve/reject) a target account.
 */
export function canManageAccount(caller: CallerCtx, target: TargetCtx): boolean {
  if (!caller.role) return false;
  if (caller.role === "super_admin") return true;

  // Non-super_admin callers can NEVER manage super_admin accounts
  if (target.role === "super_admin") return false;

  const cServer = normalizeServer(caller.serverNumber);
  const tServer = normalizeServer(target.serverNumber);
  const cGuild = normalizeGuild(caller.guild);
  const tGuild = normalizeGuild(target.guild);

  if (caller.role === "server_admin") {
    // server_admin can only manage accounts within their assigned server
    if (!cServer) return false;
    return tServer !== null && tServer === cServer;
  }

  if (caller.role === "guild_admin") {
    // guild_admin can NEVER manage server_admin or super_admin accounts
    if (target.role === "server_admin") return false;
    // guild_admin can only manage accounts belonging strictly to their own single guild
    if (!cGuild) return false;
    return tGuild !== null && tGuild === cGuild;
  }

  return false;
}
