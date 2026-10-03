/**
 * src/modules/app/auth/auth.service.ts
 *
 * The account lookups the auth controller makes to resolve a session's guild
 * or server restriction (M4b). Each returns the builder; the controller awaits
 * it and keeps its own error handling. Supabase Auth calls stay in the
 * controller: they are not table queries.
 */

import type { DbClient } from '../../../core/api/db-client';
import { escapeLike } from '../../../core/utils/text';

/** An account's guild, matched case-insensitively on its id. */
export function fetchAccountGuild(client: DbClient, accountId: string) {
  return client.from('accounts').select('guild').ilike('id', escapeLike(accountId)).maybeSingle();
}

/** An account's guild and server number, matched case-insensitively on its id. */
export function fetchAccountGuildAndServer(client: DbClient, accountId: string) {
  return client.from('accounts').select('guild, server_number').ilike('id', escapeLike(accountId)).maybeSingle();
}

/** A guild's server number. */
export function fetchGuildServerNumber(client: DbClient, guildId: string) {
  return client.from('guilds').select('server_number').eq('id', guildId).maybeSingle();
}
