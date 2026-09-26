/**
 * supabase/functions/_shared/auth.ts
 *
 * Shared authentication & authorization helper for Deno Edge Functions.
 * Cryptographically validates JWT via auth.getUser(jwt) and resolves
 * authoritative role, account id, and guild from the accounts table.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface CallerInfo {
  authenticated: boolean;
  userId: string | null;
  accountId: string | null;
  role: "super_admin" | "server_admin" | "guild_admin" | "member" | null;
  guild: string | null;
  serverNumber: string | null;
  status: string | null;
  /**
   * True only when the account exists AND `status === 'active'`.
   *
   * Finding M14: this helper used to RETURN `status` and leave every caller to
   * remember to check it -- and only one of seven did. A suspended or pending
   * admin kept full access to six endpoints, two of which spend billed Gemini
   * quota and one of which broadcasts to Discord.
   */
  active: boolean;
}

/**
 * Shape returned whenever the caller is not a usable, active account.
 *
 * `role` is deliberately NULL here even when the account exists but is
 * suspended: every caller already gates on `!caller.role`, so nulling it makes
 * the status check universal instead of something each endpoint must
 * re-implement. `status` is still reported so a caller can explain *why*.
 */
function denied(partial: Partial<CallerInfo>): CallerInfo {
  return {
    authenticated: false,
    userId: null,
    accountId: null,
    role: null,
    guild: null,
    serverNumber: null,
    status: null,
    active: false,
    ...partial,
  };
}

export async function validateCallerAuth(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceKey: string
): Promise<CallerInfo> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return denied({});

  const jwt = match[1].trim();
  const anonClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data: { user }, error: authErr } = await anonClient.auth.getUser(jwt);

  if (authErr || !user) return denied({});

  const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: acc } = await adminClient
    .from("accounts")
    .select("id, role, guild, server_number, status")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc) return denied({ authenticated: true, userId: user.id });

  // M14: a non-active account is authenticated but authorized for nothing.
  if (acc.status !== "active") {
    return denied({
      authenticated: true,
      userId: user.id,
      accountId: acc.id ?? null,
      status: acc.status ?? null,
    });
  }

  let serverNumber = acc.server_number ?? null;
  if (!serverNumber && acc.guild) {
    const { data: g } = await adminClient
      .from("guilds")
      .select("server_number")
      .eq("id", acc.guild)
      .maybeSingle();
    if (g && g.server_number) {
      serverNumber = g.server_number;
    }
  }

  return {
    authenticated: true,
    userId: user.id,
    accountId: acc.id ?? null,
    role: (acc.role as "super_admin" | "server_admin" | "guild_admin" | "member") ?? null,
    guild: acc.guild ?? null,
    serverNumber,
    status: acc.status ?? null,
    active: true,
  };
}
