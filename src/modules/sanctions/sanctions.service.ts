/**
 * src/modules/sanctions/sanctions.service.ts
 *
 * Queries of the Sanctions page (M4b). Each returns the builder; the view
 * awaits it and keeps its own error handling.
 */

import type { DbClient } from '../../core/api/db-client';

/** The guild's member pseudos, alphabetical (for the datalist). */
export function queryMemberPseudos(db: DbClient, currentG: string | null) {
  return db.from('guild_members').select('pseudo').eq('guild', currentG).order('pseudo', { ascending: true });
}

/** The guild's sanctions, newest first. */
export function querySanctions(db: DbClient, currentG: string | null) {
  return db.from('sanctions').select('*').eq('guild', currentG).order('created_at', { ascending: false });
}

/** Records a sanction and returns the inserted row. */
export function insertSanction(db: DbClient, currentG: string | null, pseudo: string, comment: string) {
  return db.from('sanctions').insert([{ guild: currentG, pseudo, comment }]).select();
}

/** Deletes a sanction. */
export function deleteSanction(db: DbClient, id: any) {
  return db.from('sanctions').delete().eq('id', id);
}
