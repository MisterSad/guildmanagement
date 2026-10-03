/**
 * src/modules/glory/glory.service.ts
 *
 * Data access for the weekly Glory tracker (medium-term plan, M4b). Each
 * function builds one query on the client the view hands it and returns the
 * builder/promise for the caller to await; error handling stays in the view.
 */

import type { DbClient } from '../../core/api/db-client';

/** List the guild's member pseudos, alphabetically. */
export function fetchGloryMembers(db: DbClient, guild: string | null) {
  return db.from('guild_members').select('pseudo').eq('guild', guild).order('pseudo', { ascending: true });
}

/** List the guild's Glory scores for one week. */
export function fetchGloryWeekScores(db: DbClient, guild: string | null, week: string | null) {
  return db.from('event_participants').select('pseudo,score').eq('guild', guild).eq('event_name', 'Glory').eq('week_start', week);
}

/** Upsert one player's Glory score for a week through `gm_upsert_player_glory`. */
export function upsertPlayerGlory(db: DbClient, guild: string | null, pseudo: string, week: string | null, glory: number) {
  return db.rpc('gm_upsert_player_glory', {
    p_guild: guild,
    p_pseudo: pseudo,
    p_week_start: week,
    p_glory: glory
  });
}
