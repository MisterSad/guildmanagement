/**
 * src/core/api/guild-rpc.ts
 *
 * The one way the browser calls a transactional guild write (medium-term plan,
 * M4a): gm_reschedule_event_session, gm_ban_member, gm_commit_ocr_roster...
 * Each of those used to be 2 to 6 table calls with no rollback; each is now one
 * SECURITY DEFINER function that does all of it or none of it.
 *
 * It keeps the promises db-guard.ts makes for table writes, which an RPC does
 * not pass through:
 *   - an unresolved tenant, or one the caller cannot write, is refused here
 *     with the same READ_ONLY_MESSAGE, before any request (the function would
 *     refuse it too, with 42501);
 *   - the Stats/History freshness markers of the guild are dropped.
 * And it makes failure loud: a transport error, a raised exception, or an
 * `{ ok: false, error }` answer all throw, so a caller cannot report success
 * for a write that did not happen.
 */

import { getClient, getSupabaseClient } from './supabase';
import { READ_ONLY_MESSAGE } from './db-guard';
import { canWriteGuild, getActiveGuild } from '../auth/roles';
import { invalidateGuildViews } from '../cache/cache';

export class GuildWriteError extends Error {
  /** The function's error code (`bad_request`, `already_banned`...) or the database message. */
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = 'GuildWriteError';
    this.code = code;
  }
}

/**
 * Calls `fn` for the active guild (passed as `p_guild`) and returns its
 * `{ ok: true, ... }` answer. Throws GuildWriteError otherwise.
 */
export async function guildWrite<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const guild = getActiveGuild();
  if (!guild || !canWriteGuild(guild)) throw new GuildWriteError('read_only', READ_ONLY_MESSAGE);
  const client = getClient() || getSupabaseClient();
  if (!client) throw new GuildWriteError('no_client', 'The database is not available.');

  invalidateGuildViews(guild);
  const { data, error } = await client.rpc(fn, { p_guild: guild, ...args });
  if (error) throw new GuildWriteError(error.code || 'db_error', error.message);
  if (!data || (data as any).ok !== true) {
    const code = (data && (data as any).error) || 'failed';
    throw new GuildWriteError(code, code);
  }
  return data as T;
}
