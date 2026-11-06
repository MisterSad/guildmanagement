/**
 * src/modules/migration/migration.service.ts
 *
 * Writes and queries of the cross-server migration groups (super_admin only),
 * used by the migration-groups admin panel and by cross-server transfers (M4b):
 * each query returns the builder or promise, and the caller awaits it. The
 * Migration Hub wiki that also lived here was removed on 2026-11-06.
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { GuildWriteError } from '../../core/api/guild-rpc';
import type { DbClient } from '../../core/api/db-client';

/**
 * Opens a migration group with its servers in one transaction (M4a). The two
 * inserts this replaces could leave an "open" group with no servers.
 * Throws GuildWriteError on refusal (`bad_request`, `forbidden`).
 */
export async function createMigrationGroup(
  name: string,
  servers: string[]
): Promise<{ ok: true; id: string; servers: number }> {
  const client = getSupabaseClient();
  if (!client) throw new GuildWriteError('no_client', 'The database is not available.');
  const { data, error } = await client.rpc('gm_create_migration_group', { p_name: name, p_servers: servers });
  if (error) throw new GuildWriteError(error.code || 'db_error', error.message);
  if (!data || (data as { ok?: boolean }).ok !== true) {
    const code = (data && (data as { error?: string }).error) || 'failed';
    throw new GuildWriteError(code, code);
  }
  return data as { ok: true; id: string; servers: number };
}

// ---------------------------------------------------------------------------
// Migration groups admin panel (super_admin)
// ---------------------------------------------------------------------------

/** Every migration group, newest first. */
export function queryMigrationGroups(db: DbClient) {
  return db.from('server_migration_groups').select('id, name, status').order('created_at', { ascending: false });
}

/** Every (group, server) link. */
export function queryMigrationGroupServers(db: DbClient) {
  return db.from('server_migration_group_servers').select('group_id, server_number');
}

/** Updates a migration group (open/close). */
export function updateMigrationGroup(db: DbClient, groupId: string, updatePayload: Record<string, unknown>) {
  return db.from('server_migration_groups').update(updatePayload).eq('id', groupId);
}
