/**
 * src/modules/app/members/members.store.ts
 *
 * Sous-lot 6.6 (Strangler) — in-memory member/banned/transfer state ported from
 * app.js (`guildMembers`, `bannedPlayers`, `pendingTransfers`), shared by the
 * controller, renderer and banned modules.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GuildMember {
  pseudo: string;
  uid?: string | null;
  role?: string;
  guild?: string;
  overall_power?: number | string | null;
  fleet_rating?: number | null;
  tech_power?: number | null;
  flagship_power?: number | null;
  champion_power?: number | null;
  crew_power?: number | null;
  glory_score?: number | null;
  timezone_offset?: number | null;
  created_at?: string;
  [key: string]: any;
}

export interface BannedPlayer {
  uid: string;
  pseudo?: string | null;
  reason?: string | null;
  created_by?: string | null;
  created_at?: string;
  [key: string]: any;
}

export interface PendingTransfer {
  id: string;
  uid: string;
  pseudo: string;
  source_guild: string;
  target_guild: string;
  [key: string]: any;
}

let guildMembers: GuildMember[] = [];
let bannedPlayers: BannedPlayer[] = [];
let pendingTransfers: PendingTransfer[] = [];

export function getGuildMembers(): GuildMember[] {
  return guildMembers;
}
export function setGuildMembers(list: GuildMember[] | null | undefined): void {
  guildMembers = Array.isArray(list) ? list : [];
}
export function pushGuildMember(member: GuildMember): void {
  guildMembers.push(member);
}
export function filterGuildMembersOut(predicate: (m: GuildMember) => boolean): void {
  guildMembers = guildMembers.filter((m) => !predicate(m));
}
export function findGuildMember(pseudo: string): GuildMember | undefined {
  return guildMembers.find((m) => m.pseudo === pseudo);
}

export function getBannedPlayers(): BannedPlayer[] {
  return bannedPlayers;
}
export function setBannedPlayers(list: BannedPlayer[] | null | undefined): void {
  bannedPlayers = Array.isArray(list) ? list : [];
}
export function removeBannedPlayer(uid: string): void {
  bannedPlayers = bannedPlayers.filter((b) => b.uid !== uid);
}

export function getPendingTransfers(): PendingTransfer[] {
  return pendingTransfers;
}
export function setPendingTransfers(list: PendingTransfer[] | null | undefined): void {
  pendingTransfers = Array.isArray(list) ? list : [];
}

export function clearMembersStore(): void {
  guildMembers = [];
  bannedPlayers = [];
  pendingTransfers = [];
}
