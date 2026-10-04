/**
 * src/core/state/app-state.ts
 *
 * The app's cross-cutting state: active tenant, guild list, roster selection,
 * collapsed role groups. Lives in `core/` because `core/auth/roles.ts` needs
 * it, and this module imports nothing.
 *
 * A plain module singleton, and the only writer of this state (AGENTS.md).
 * Until M4c it also mirrored every write onto `window` (`window.currentGuild`,
 * `window.GM_COLLAPSED_ROLES`...) and re-read it on every access, for the GM_*
 * bridge and for tests that seeded state by assigning the globals. Both are
 * gone; tests call patchAppState().
 */

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
    collapsedRoles: defaultCollapsedRoles(),
  };
}

let state: AppState = createDefaultState();

/**
 * Kept for the boot sequence's call order. The state is a plain module
 * singleton since M4c: there is no `window` mirror left to establish.
 */
export function initAppState(): void {
  /* nothing to mirror */
}

/** Returns a snapshot of the unified state (Set/array members shared by ref). */
export function getAppState(): AppState {
  return { ...state, collapsedRoles: { ...state.collapsedRoles } };
}

/** Merges a partial update into the state. */
export function patchAppState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
}

/** Clears the state back to defaults (tests). */
export function resetAppState(): void {
  state = createDefaultState();
}
