/**
 * src/modules/app/admin/admin.service.ts
 *
 * Queries of the admin panels -- guilds, accounts, guild requests (M4b). Each
 * returns the builder; the controller awaits it and keeps its own error
 * handling.
 */

import type { DbClient } from '../../../core/api/db-client';
import { escapeLike } from '../../../core/utils/text';

/** Every guild with its server number, by id. */
export function queryGuildList(db: DbClient) {
  return db.from('guilds').select('id, server_number').order('id');
}

/** Sets (or clears) a guild's server number and returns the updated row. */
export function updateGuildServerNumber(db: DbClient, guildId: string, serverNum: string) {
  return db
    .from('guilds')
    .update({ server_number: serverNum || null })
    .eq('id', guildId)
    .select();
}

/** Deletes a guild and its data (gm_delete_guild). */
export function deleteGuild(db: DbClient, guildId: string) {
  return db.rpc('gm_delete_guild', { p_guild_id: guildId });
}

/** Creates a guild on a server. */
export function insertGuild(db: DbClient, guildName: string, serverNum: any) {
  return db.from('guilds').insert({ id: guildName, server_number: serverNum });
}

/** Pending member accounts that asked to join a guild (case-insensitive match). */
export function queryPendingMemberAccounts(db: DbClient, guild: string | null | undefined) {
  return db
    .from('accounts')
    .select('id, uid, status, role, guild, created_at')
    .eq('status', 'pending')
    .eq('role', 'member')
    .ilike('guild', escapeLike(guild || ''));
}
