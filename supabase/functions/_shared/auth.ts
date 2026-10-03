/**
 * supabase/functions/_shared/auth.ts
 *
 * The ONE place an Edge Function learns who is calling (audit ARC-03, BE-A-19).
 *
 * There used to be four: this module's validateCallerAuth (five functions),
 * admin-accounts' getCallerInfo, member-portal's getIdentity, and
 * discord-bot-interactions' officerAccounts. Each re-implemented the same
 * steps -- verify the JWT, load the account, refuse an inactive one, refuse a
 * revoked session, normalise the role, derive the server -- and they had
 * already drifted (one normalised the role, the others did not). A rule fixed
 * here now reaches every function.
 *
 * Authorisation DECISIONS (who may act on what) live in admin-authz.ts; this
 * module only establishes the facts they are decided on.
 */

import { anonClient, serviceClient } from "./clients.ts";
import { isSessionRevoked } from "./session-epoch.ts";
import { isMember, normalizeRole, type Role } from "./admin-authz.ts";
import type { AdminClient } from "./db.ts";

export interface CallerInfo {
  authenticated: boolean;
  userId: string | null;
  accountId: string | null;
  /** Normalised to the four roles; NULL whenever the caller may do nothing. */
  role: Role | null;
  guild: string | null;
  serverNumber: string | null;
  /** The account's in-game UID, if it claimed a player. */
  uid: string | null;
  status: string | null;
  /**
   * True only when the account exists AND `status === 'active'`.
   *
   * Finding M14: callers used to receive `status` and had to remember to check
   * it -- one of seven did. `role` is now NULL for any inactive account, so
   * the usual `!caller.role` gate covers it.
   */
  active: boolean;
  /**
   * The bearer token is authentic but older than `accounts.session_version`
   * (finding C1). RLS refuses such tokens; an Edge Function querying with the
   * service key must refuse them itself, and this is where it does.
   */
  sessionRevoked: boolean;
}

interface AccountRow {
  id: string;
  role: string | null;
  guild: string | null;
  server_number: string | null;
  status: string | null;
  uid?: string | null;
  session_version?: number | null;
}

/** The context an authorisation decision needs, derived from an account row. */
export interface AccountContext {
  id: string;
  role: Role;
  guild: string | null;
  serverNumber: string | null;
  uid: string | null;
}

function denied(partial: Partial<CallerInfo>): CallerInfo {
  return {
    authenticated: false,
    userId: null,
    accountId: null,
    role: null,
    guild: null,
    serverNumber: null,
    uid: null,
    status: null,
    active: false,
    sessionRevoked: false,
    ...partial,
  };
}

/**
 * Role normalised, and the server derived from the guild when the account has
 * none of its own. Shared by the JWT path and the Discord path.
 */
export async function accountContext(admin: AdminClient, acc: AccountRow): Promise<AccountContext> {
  let serverNumber = acc.server_number ?? null;
  if (!serverNumber && acc.guild) {
    const { data: g } = await admin.from("guilds").select("server_number").eq("id", acc.guild).maybeSingle();
    serverNumber = (g as { server_number?: string } | null)?.server_number ?? null;
  }
  return {
    id: acc.id,
    role: normalizeRole(acc.role),
    guild: acc.guild ?? null,
    serverNumber,
    uid: acc.uid ?? null,
  };
}

/**
 * Who is calling, from the request's bearer token. Never trusts anything the
 * client sent besides that token.
 */
export async function resolveCaller(req: Request, admin: AdminClient = serviceClient()): Promise<CallerInfo> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return denied({});

  const jwt = match[1].trim();
  const { data: { user }, error: authErr } = await anonClient().auth.getUser(jwt);
  if (authErr || !user) return denied({});

  const { data: acc } = await admin
    .from("accounts")
    .select("id, role, guild, server_number, status, uid, session_version")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const row = acc as AccountRow | null;

  if (!row) return denied({ authenticated: true, userId: user.id });

  // M14: a non-active account is authenticated but authorised for nothing.
  if (row.status !== "active") {
    return denied({ authenticated: true, userId: user.id, accountId: row.id, status: row.status });
  }

  // C1: the token's epoch must still be current. Absent-tolerant, matching
  // gm_session_is_valid() exactly: the two must not disagree, or an account
  // would be refused by RLS while the Edge Functions still served it.
  if (isSessionRevoked(jwt, row.session_version ?? null)) {
    return denied({ authenticated: true, userId: user.id, accountId: row.id, status: row.status, sessionRevoked: true });
  }

  const ctx = await accountContext(admin, row);
  return {
    authenticated: true,
    userId: user.id,
    accountId: ctx.id,
    role: ctx.role,
    guild: ctx.guild,
    serverNumber: ctx.serverNumber,
    uid: ctx.uid,
    status: row.status,
    active: true,
    sessionRevoked: false,
  };
}

/**
 * The ACTIVE officer accounts (any role above member) linked to a Discord
 * identity. The only source of authority for the bot's officer commands and
 * the join-request buttons: Discord roles and permissions grant nothing.
 */
export async function officerAccountsForDiscord(admin: AdminClient, discordUserId: string): Promise<AccountContext[]> {
  const { data: links } = await admin
    .from("discord_account_links")
    .select("account_id")
    .eq("discord_user_id", discordUserId);
  const ids = ((links as { account_id: string }[]) || []).map((l) => l.account_id);
  if (ids.length === 0) return [];
  const { data: accs } = await admin
    .from("accounts")
    .select("id, role, guild, server_number, status, uid")
    .in("id", ids);
  const out: AccountContext[] = [];
  for (const a of (accs as AccountRow[]) || []) {
    if (a.status !== "active") continue;
    const ctx = await accountContext(admin, a);
    if (isMember(ctx.role)) continue;
    out.push(ctx);
  }
  return out;
}
