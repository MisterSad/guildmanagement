/**
 * src/modules/app/state/app-state.ts
 *
 * Sous-lot 6.2 (Strangler) — Unified global app state for the root `app.js`
 * monolith. Holds the cross-cutting `window.*` globals in one typed store and
 * mirrors every write back onto `window` so the still-loaded classic script
 * (`app.js`) and the `/src` modules stay coherent during the migration.
 *
 * Call-time `window` reads/writes only; `app.js` is intentionally untouched.
 * This module never assigns a new `window.GM_*` global (bridge lives in main.ts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CollapsedRoles {
  R5: boolean;
  R4: boolean;
  R3: boolean;
  R2: boolean;
  R1: boolean;
}

/** Roster view mode as actually used by app.js/index.html ('cards' | 'matrix'). */
export type AdminMembersViewMode = 'cards' | 'matrix';

export interface AppState {
  currentGuildRestriction: string | null;
  currentServerRestriction: string | null;
  currentGuild: string;
  guildsList: string[];
  guildsData: Record<string, unknown>;
  guildAbsences: unknown[];
  adminSelectedMembers: Set<string>;
  adminMembersViewMode: AdminMembersViewMode;
  collapsedRoles: CollapsedRoles;
}

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function ls(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function defaultCollapsedRoles(): CollapsedRoles {
  return { R5: false, R4: false, R3: false, R2: false, R1: false };
}

function defaultCurrentGuild(): string {
  try {
    const store = ls();
    return (store ? store.getItem('gm_current_guild') : null) || 'ALPHA';
  } catch (_) {
    return 'ALPHA';
  }
}

function createDefaultState(): AppState {
  return {
    currentGuildRestriction: null,
    currentServerRestriction: null,
    currentGuild: defaultCurrentGuild(),
    guildsList: [],
    guildsData: {},
    guildAbsences: [],
    adminSelectedMembers: new Set<string>(),
    adminMembersViewMode: 'cards',
    collapsedRoles: defaultCollapsedRoles()
  };
}

let state: AppState = createDefaultState();

function isViewMode(value: unknown): value is AdminMembersViewMode {
  return value === 'cards' || value === 'matrix';
}

/**
 * Fills any missing `window.*` mirror key with the current internal value.
 * Existing values (e.g. written by the still-loaded app.js) are preserved.
 */
function ensureWindowMirror(): void {
  const w = winAny();
  if (w.currentGuildRestriction === undefined) w.currentGuildRestriction = state.currentGuildRestriction;
  if (w.currentServerRestriction === undefined) w.currentServerRestriction = state.currentServerRestriction;
  if (typeof w.currentGuild !== 'string' || !w.currentGuild) w.currentGuild = state.currentGuild;
  if (!Array.isArray(w.guildsList)) w.guildsList = state.guildsList;
  if (!w.guildsData || typeof w.guildsData !== 'object') w.guildsData = state.guildsData;
  if (!Array.isArray(w.guildAbsences)) w.guildAbsences = state.guildAbsences;
  if (!(w.adminSelectedMembers instanceof Set)) w.adminSelectedMembers = state.adminSelectedMembers;
  if (!isViewMode(w.adminMembersViewMode)) w.adminMembersViewMode = state.adminMembersViewMode;
  if (!w.GM_COLLAPSED_ROLES || typeof w.GM_COLLAPSED_ROLES !== 'object') {
    w.GM_COLLAPSED_ROLES = { ...state.collapsedRoles };
  }
}

/** Imports any externally-written `window.*` values into the internal state. */
function hydrateFromWindow(): void {
  const w = winAny();
  if (w.currentGuildRestriction !== undefined) state.currentGuildRestriction = w.currentGuildRestriction ?? null;
  if (w.currentServerRestriction !== undefined) state.currentServerRestriction = w.currentServerRestriction ?? null;
  if (typeof w.currentGuild === 'string' && w.currentGuild) state.currentGuild = w.currentGuild;
  if (Array.isArray(w.guildsList)) state.guildsList = w.guildsList;
  if (w.guildsData && typeof w.guildsData === 'object') state.guildsData = w.guildsData;
  if (Array.isArray(w.guildAbsences)) state.guildAbsences = w.guildAbsences;
  if (w.adminSelectedMembers instanceof Set) state.adminSelectedMembers = w.adminSelectedMembers;
  if (isViewMode(w.adminMembersViewMode)) state.adminMembersViewMode = w.adminMembersViewMode;
  if (w.GM_COLLAPSED_ROLES && typeof w.GM_COLLAPSED_ROLES === 'object') {
    state.collapsedRoles = { ...state.collapsedRoles, ...w.GM_COLLAPSED_ROLES };
  }
}

/** Writes every mirrored key back onto `window` from the internal state. */
function syncToWindow(): void {
  const w = winAny();
  w.currentGuildRestriction = state.currentGuildRestriction;
  w.currentServerRestriction = state.currentServerRestriction;
  w.currentGuild = state.currentGuild;
  w.guildsList = state.guildsList;
  w.guildsData = state.guildsData;
  w.guildAbsences = state.guildAbsences;
  w.adminSelectedMembers = state.adminSelectedMembers;
  w.adminMembersViewMode = state.adminMembersViewMode;
  w.GM_COLLAPSED_ROLES = { ...state.collapsedRoles };
}

/**
 * Registers the mirror at boot. Safe to call before the app bootstrap: it only
 * fills `window` keys that are still undefined, so app.js-authored values win.
 */
export function initAppState(): void {
  ensureWindowMirror();
  hydrateFromWindow();
}

/** Returns a snapshot of the unified state (Set/array members shared by ref). */
export function getAppState(): AppState {
  ensureWindowMirror();
  hydrateFromWindow();
  return { ...state, collapsedRoles: { ...state.collapsedRoles } };
}

/** Merges a partial update into the state and mirrors the result on `window`. */
export function patchAppState(patch: Partial<AppState>): void {
  hydrateFromWindow();
  state = { ...state, ...patch };
  syncToWindow();
}

/** Clears the state back to defaults and resets the `window` mirror (tests). */
export function resetAppState(): void {
  state = createDefaultState();
  syncToWindow();
}
