/**
 * src/modules/migration/migration.service.ts
 *
 * Writes of the cross-server migration groups (super_admin only).
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { GuildWriteError } from '../../core/api/guild-rpc';

/**
 * Opens a migration group with its servers in one transaction (M4a). The two
 * inserts this replaces could leave an "open" group with no servers.
 * Throws GuildWriteError on refusal (`bad_request`, `forbidden`).
 */
export async function createMigrationGroup(name: string, servers: string[]): Promise<{ ok: true; id: string; servers: number }> {
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
