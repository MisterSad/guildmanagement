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
}

export async function validateCallerAuth(
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceKey: string
): Promise<CallerInfo> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) {
    return {
      authenticated: false,
      userId: null,
      accountId: null,
      role: null,
      guild: null,
      serverNumber: null,
      status: null,
    };
  }

  const jwt = match[1].trim();
  const anonClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data: { user }, error: authErr } = await anonClient.auth.getUser(jwt);

  if (authErr || !user) {
    return {
      authenticated: false,
      userId: null,
      accountId: null,
      role: null,
      guild: null,
      serverNumber: null,
      status: null,
    };
  }

  const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: acc } = await adminClient
    .from("accounts")
    .select("id, role, guild, server_number, status")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc) {
    return {
      authenticated: true,
      userId: user.id,
      accountId: null,
      role: null,
      guild: null,
      serverNumber: null,
      status: null,
    };
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
  };
}
