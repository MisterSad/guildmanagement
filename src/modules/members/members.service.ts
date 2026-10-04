/**
 * src/modules/members/members.service.ts
 *
 * Bulk member role helpers and the bug-report description formatter, ported
 * from gm-utils.js.
 */


import { APP_VERSION } from '../../core/config/constants';
import { detectClientEnvironment } from '../../core/auth/roles';
import { guildWrite } from '../../core/api/guild-rpc';
import type { DbClient } from '../../core/api/db-client';

const ALLOWED_BULK_ROLES = ['R1', 'R2', 'R3', 'R4'];

export function getAllowedBulkRoles(): string[] {
  return ALLOWED_BULK_ROLES.slice();
}

export function isRoleAllowedForBulk(role: string): boolean {
  return ALLOWED_BULK_ROLES.indexOf(role) !== -1;
}

export interface BulkEligibleResult {
  eligiblePseudos: string[];
  excludedR5Count: number;
}

/**
 * Filters selected pseudos against the roster: keeps existing members and
 * excludes any R5 (guild leadership is protected).
 */
export function filterBulkEligibleMembers(
  members: Array<{ pseudo?: string; role?: string }> | null | undefined,
  selectedPseudos: string[] | Set<string> | null | undefined
): BulkEligibleResult {
  const list = members || [];
  const selArr = Array.isArray(selectedPseudos)
    ? selectedPseudos
    : (selectedPseudos && typeof (selectedPseudos as any).forEach === 'function' ? Array.from(selectedPseudos as Set<string>) : []);

  const selSet: Record<string, boolean> = {};
  selArr.forEach((p) => { if (p) selSet[String(p).toLowerCase()] = true; });

  const eligible: string[] = [];
  let excludedR5 = 0;

  list.forEach((m) => {
    if (!m || !m.pseudo) return;
    if (selSet[m.pseudo.toLowerCase()]) {
      if (m.role === 'R5') excludedR5++;
      else eligible.push(m.pseudo);
    }
  });

  return { eligiblePseudos: eligible, excludedR5Count: excludedR5 };
}

export interface TicketDescriptionSections {
  currentBehavior?: string;
  expectedBehavior?: string;
  steps?: string;
  additionalContext?: string;
  env?: { appVersion?: string; os?: string; browser?: string };
}

/** Formats a bug-report description with an environment footer. */
export function formatTicketDescription(sections: TicketDescriptionSections): string {
  if (!sections || typeof sections !== 'object') return '';
  const parts: string[] = [];

  if (sections.currentBehavior && sections.currentBehavior.trim()) parts.push('**Current Behavior / Issue**\n' + sections.currentBehavior.trim());
  if (sections.expectedBehavior && sections.expectedBehavior.trim()) parts.push('**Expected Behavior**\n' + sections.expectedBehavior.trim());
  if (sections.steps && sections.steps.trim()) parts.push('**Steps to Reproduce**\n' + sections.steps.trim());
  if (sections.additionalContext && sections.additionalContext.trim()) parts.push('**Additional Context / Information**\n' + sections.additionalContext.trim());

  const env = sections.env || detectClientEnvironment();
  parts.push(
    '**Environment**\n' +
    '• FGF Mgmt Tool Version: ' + (env.appVersion || APP_VERSION) + '\n' +
    '• OS + Version: ' + (env.os || 'Unknown OS') + '\n' +
    '• Browser + Version: ' + (env.browser || 'Unknown Browser')
  );

  return parts.join('\n\n');
}

// ── Transactional roster writes (M4a) ───────────────────────────────────────
// Each is one database function: all of it happens, or none of it.

/** Bans a UID and removes it from the roster together. Throws on refusal (`already_banned`, an R5...). */
export function banMember(uid: string, pseudo: string | null, reason: string | null): Promise<{ ok: true; removed: string | null }> {
  return guildWrite('gm_ban_member', { p_uid: uid, p_pseudo: pseudo, p_reason: reason });
}

export interface NewMember {
  pseudo: string; uid: string; role: string; overall_power: number;
  fleet_rating?: number; tech_power?: number; flagship_power?: number;
  champion_power?: number; crew_power?: number; glory_score?: number;
}

/** Adds a member, its first metrics snapshot and its enrolment in running events. Returns the stored row. */
export function addMember(member: NewMember): Promise<{ ok: true; member: any; added_events: number }> {
  return guildWrite('gm_add_member', { p_member: member });
}

/**
 * Updates a member -- profile, metrics snapshot, this week's Glory, and the
 * name-history row of a rename -- together. `update` holds only the fields
 * that change; the server refuses any other key.
 */
export function updateMember(pseudo: string, update: Record<string, unknown>): Promise<{ ok: true; pseudo: string }> {
  return guildWrite('gm_update_member', { p_pseudo: pseudo, p_update: update });
}

// ── Roster queries (M4b) ────────────────────────────────────────────────────
// Each returns the query builder (or promise) unchanged; the caller awaits it
// and keeps its own error handling. `db` is the guarded client the caller holds.

/** Lists a guild's roster, alphabetically by pseudo. */
export function listGuildMembers(db: DbClient, guild: string | null) {
  return db.from('guild_members').select('*').eq('guild', guild).order('pseudo', { ascending: true });
}

/** Lists every pending guild transfer, oldest first. */
export function listPendingTransfers(db: DbClient) {
  return db.from('guild_transfers').select('id, uid, pseudo, source_guild, target_guild, requested_by').eq('status', 'pending').order('created_at', { ascending: true });
}

/** Lists a guild's player absences. */
export function listPlayerAbsences(db: DbClient, guild: string | null) {
  return db.from('player_absences').select('*').eq('guild', guild);
}

/** Fetches each player's latest Glory score for a guild (one row per player). */
export function fetchLatestGloryScores(db: DbClient, guild: string | null) {
  return db.rpc('gm_latest_glory_scores', { p_guild: guild });
}

/** Approves or rejects a pending guild transfer. */
export function resolveGuildTransfer(db: DbClient, transferId: string, action: string) {
  return db.rpc('resolve_guild_transfer', { p_transfer_id: transferId, p_action: action });
}

/** Asks the player's current guild to release a UID into the target guild. */
export function requestGuildTransfer(db: DbClient, uid: string, targetGuild: string | null) {
  return db.rpc('gm_admin_request_transfer', { p_uid: uid, p_target_guild: targetGuild });
}

/** Tells whether a UID is already on any guild's roster. */
export function checkUidExistsGlobally(db: DbClient, uid: string) {
  return db.rpc('check_uid_exists_globally', { p_uid: uid });
}

/** Looks up the player holding a UID, across guilds. */
export function findPlayerByUid(db: DbClient, uid: string) {
  return db.rpc('gm_find_player_by_uid', { p_uid: uid });
}

/** Lists the ban rows matching a UID. */
export function findBannedUid(db: DbClient, uid: string) {
  return db.from('banned_players').select('uid').eq('uid', uid);
}

/** Removes a member from a guild's roster. */
export function deleteGuildMemberRow(db: DbClient, pseudo: string, guild: string | null) {
  return db.from('guild_members').delete().eq('pseudo', pseudo).eq('guild', guild);
}

/** Lists the guilds a member of this guild may be transferred to. */
export function listTransferEligibleGuilds(db: DbClient, guild: string | null) {
  return db.rpc('gm_list_transfer_eligible_guilds', { p_guild: guild });
}

/** Reads a guild's server number. */
export function fetchGuildServerNumber(db: DbClient, guild: string | null) {
  return db.from('guilds').select('server_number').eq('id', guild).maybeSingle();
}

/** Transfers a member to another guild. */
export function transferGuildMember(db: DbClient, uid: string, targetGuild: string | null, pseudo: string) {
  return db.rpc('gm_transfer_guild_member', { p_uid: uid, p_target_guild: targetGuild, p_pseudo: pseudo });
}

/** Lists a UID's name history, newest first. */
export function listNameHistory(db: DbClient, uid: string) {
  return db.from('player_name_history').select('*').eq('uid', uid).order('changed_at', { ascending: false });
}

/** Deletes one name-history entry. */
export function deleteNameHistoryEntry(db: DbClient, id: string) {
  return db.from('player_name_history').delete().eq('id', id);
}

/** Lists a guild's banned players, newest ban first. */
export function listBannedPlayers(db: DbClient, guild: string | null) {
  return db.from('banned_players').select('*').eq('guild', guild).order('created_at', { ascending: false });
}

/** Lifts a ban in a guild. */
export function deleteBannedPlayerRow(db: DbClient, uid: string, guild: string | null) {
  return db.from('banned_players').delete().eq('uid', uid).eq('guild', guild);
}

/** Sets the same role on several members of a guild. */
export function bulkSetMemberRole(db: DbClient, guild: string | null, pseudos: string[], targetRole: string) {
  return db.from('guild_members')
      .update({ role: targetRole, metrics_updated_at: new Date().toISOString() })
      .eq('guild', guild)
      .in('pseudo', pseudos);
}
