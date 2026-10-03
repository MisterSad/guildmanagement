/**
 * src/modules/migration/migration.service.ts
 *
 * Writes of the cross-server migration groups (super_admin only), and the
 * queries of the Migration Hub wiki and the migration-groups admin panel (M4b):
 * each returns the builder or promise, and the caller awaits it.
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { GuildWriteError } from '../../core/api/guild-rpc';
import type { DbClient } from '../../core/api/db-client';

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

// ---------------------------------------------------------------------------
// Migration Hub wiki
// ---------------------------------------------------------------------------

/** The wiki pages of one scope (guild or server), pinned first then newest. */
export function queryWikiPages(db: DbClient, scope: string, currentG: string, serverNumber: any) {
  let query = db.from('migration_wiki_pages').select('*');

  if (scope === 'guild') {
    query = query.eq('scope', 'guild').eq('guild_id', currentG);
  } else {
    query = query.eq('scope', 'server').eq('server_number', serverNumber);
  }

  query = query.order('is_pinned', { ascending: false }).order('updated_at', { ascending: false });
  return query;
}

/** Updates an existing wiki page's editable fields. */
export function updateWikiPage(db: DbClient, pageId: any, title: any, category: any, content: any, isPinned: any, attachments: any) {
  return db
    .from('migration_wiki_pages')
    .update({
      title,
      category,
      content,
      is_pinned: isPinned,
      attachments
    })
    .eq('id', pageId);
}

/** Creates a wiki page and returns its id. */
export function insertWikiPage(db: DbClient, scope: string, serverNumber: any, currentG: string, category: any, title: any, content: any, isPinned: any, attachments: any, pseudo: string) {
  return db
    .from('migration_wiki_pages')
    .insert({
      scope,
      server_number: serverNumber,
      guild_id: scope === 'guild' ? currentG : null,
      category,
      title,
      content,
      is_pinned: isPinned,
      attachments,
      // Authorship and owner guild are stamped by the database from the
      // session; NOT NULL placeholders only (trg_migration_wiki_pages_stamp).
      created_by_pseudo: pseudo,
      updated_by_pseudo: pseudo
    })
    .select('id')
    .single();
}

/** Pins or unpins a wiki page. */
export function setWikiPagePinned(db: DbClient, pageId: any, newPinned: boolean) {
  return db
    .from('migration_wiki_pages')
    .update({ is_pinned: newPinned, updated_at: new Date().toISOString() })
    .eq('id', pageId);
}

/** Deletes a wiki page, returning the deleted rows (RLS filters a refusal to zero rows). */
export function deleteWikiPage(db: DbClient, pageId: any) {
  return db.from('migration_wiki_pages').delete().eq('id', pageId).select('id');
}

/** A wiki page's comments, oldest first. */
export function queryWikiComments(db: DbClient, pageId: string) {
  return db
    .from('migration_wiki_comments')
    .select('*')
    .eq('page_id', pageId)
    .order('created_at', { ascending: true });
}

/** Posts a comment on a wiki page. */
export function insertWikiComment(db: DbClient, pageId: any, content: any, pseudo: string) {
  return db.from('migration_wiki_comments').insert({
    page_id: pageId,
    content,
    // Author fields are stamped by the database from the session
    // (trg_migration_wiki_comments_stamp); NOT NULL placeholder only.
    author_pseudo: pseudo
  });
}

/** Deletes a wiki comment. */
export function deleteWikiComment(db: DbClient, commentId: string) {
  return db.from('migration_wiki_comments').delete().eq('id', commentId);
}

/** Asks the migration-summary Edge Function to summarise one page. */
export function requestPageSummary(db: DbClient, pageId: any, scope: any, guildId: any, serverNumber: any) {
  return db.functions.invoke('migration-summary', {
    body: {
      mode: 'page',
      pageId,
      scope,
      guildId,
      serverNumber
    }
  });
}

/** Asks the migration-summary Edge Function for the briefing of a whole scope. */
export function requestScopeBriefing(db: DbClient, scope: string, currentG: any, serverNumber: any) {
  return db.functions.invoke('migration-summary', {
    body: {
      mode: 'scope',
      scope,
      guildId: scope === 'guild' ? currentG : null,
      serverNumber
    }
  });
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
