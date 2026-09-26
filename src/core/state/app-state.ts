/**
 * src/core/state/app-state.ts
 *
 * The app's cross-cutting state: active tenant, guild list, roster selection,
 * collapsed role groups. Lives in `core/` because `core/auth/roles.ts` and
 * `core/gm-bridge.ts` both need it, and this module imports nothing.
 *
 * It still mirrors every write onto `window`, but no longer because a classic
 * `app.js` reads them -- that script is gone. The mirror survives for the
 * `GM_*` bridge and for the tests and e2e specs that seed state by assigning
 * the globals directly. Retiring it is the window-mirror collapse (M7).
 *
 * Two properties the mirror MUST keep, both of which it once broke:
 *   - a read does not write, so asking for the active guild cannot create
 *     `window.GM_COLLAPSED_ROLES` as a side effect;
 *   - hydration is absence-aware, so deleting a global clears the field
 *     instead of being refilled from the previous value.
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
  currentGuild: string | null;
  guildsList: string[];
  /**
   * Per-guild metadata, keyed by guild id. `server_number` is the only field
   * anything reads; it was `unknown` while the only consumers went through
   * `window` and cast it away, so typing it costs nothing and lets
   * `canWriteGuild()` compare server numbers without an `any`.
   */
  guildsData: Record<string, { server_number?: string | null } | undefined>;
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

/**
 * H2: returns null rather than 'ALPHA' when nothing is stored.
 *
 * Both the happy path and the catch used to hand back a real, populated tenant,
 * so a browser that blocks localStorage entirely started every session pointed
 * at ALPHA.
 */
function defaultCurrentGuild(): string | null {
  try {
    const store = ls();
    const stored = store ? store.getItem('gm_current_guild') : null;
    return typeof stored === 'string' && stored.trim() !== '' ? stored.trim() : null;
  } catch (_) {
    return null;
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

/**
 * Imports any externally-written `window.*` values into the internal state.
 *
 * The three scalars below are absence-AWARE: a key that is missing or blank
 * resets the field to null rather than leaving the previous value in place.
 * Without that, the mirror is sticky -- `ensureWindowMirror()` refills a missing
 * key from the state and `hydrateFromWindow()` reads it straight back, so once a
 * guild had been seen it could never be forgotten. That was invisible while
 * every reader went to `window` directly; it surfaced the moment
 * `getActiveGuild()` started reading the store, where clearing the global no
 * longer fell through to localStorage.
 */
function hydrateFromWindow(): void {
  const w = winAny();
  state.currentGuildRestriction = w.currentGuildRestriction ?? null;
  state.currentServerRestriction = w.currentServerRestriction ?? null;
  state.currentGuild = (typeof w.currentGuild === 'string' && w.currentGuild) ? w.currentGuild : null;
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
  hydrateFromWindow();
  ensureWindowMirror();
}

/** Returns a snapshot of the unified state (Set/array members shared by ref). */
export function getAppState(): AppState {
  // A READ does not write. `ensureWindowMirror()` used to run here too, which
  // meant merely asking for the active guild CREATED `window.GM_COLLAPSED_ROLES`
  // and friends as a side effect -- the opposite of what this move is for, and
  // caught by StatsView's cutover guard. The mirror is established at boot
  // (`initAppState`) and refreshed on every write (`patchAppState`), which is
  // when external consumers actually need it.
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
