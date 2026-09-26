// The store moved to `src/core/state/app-state.ts` and became the single write
// path for the app's cross-cutting state.
//
// Two separate claims, both of which failed before this work:
//
//   1. STRUCTURAL -- the store belongs in `core/`. It is imported by
//      `core/auth/roles.ts` and `core/gm-bridge.ts`, and `core/` must not reach
//      into `modules/`. It qualifies because it imports nothing at all.
//
//   2. BEHAVIOURAL -- reads are pure and hydration is absence-aware. Asking for
//      the active guild used to CREATE `window.GM_COLLAPSED_ROLES` as a side
//      effect, and deleting a global used to be undone by the next read
//      refilling it from the previous value.
//
// The single-write-path check is a source scan rather than a runtime assertion,
// because a stray `window.currentGuild = …` is invisible to both `tsc` and any
// behavioural test -- it simply wins, silently.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getAppState,
  patchAppState,
  initAppState,
  resetAppState
} from '../src/core/state/app-state.ts';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const STORE = 'src/core/state/app-state.ts';
const STATE_KEYS = [
  'currentGuild',
  'currentGuildRestriction',
  'currentServerRestriction',
  'guildsList',
  'guildsData',
  'guildAbsences',
  'adminSelectedMembers',
  'adminMembersViewMode',
  'GM_COLLAPSED_ROLES'
];

describe('the store lives in core/ and can', () => {
  it('exists at its core path, and not at the old modules path', () => {
    expect(fs.existsSync(path.join(rootDir, STORE))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'src/modules/app/state/app-state.ts'))).toBe(false);
  });

  it('imports nothing, which is what makes it core-compatible', () => {
    // `core/` must not depend on `modules/`. A module with zero imports cannot
    // violate that, now or after a later edit.
    const imports = stripComments(read(STORE)).match(/^\s*import\s/gm) || [];
    expect(imports, `the store now imports something: check the layering`).toEqual([]);
  });

  it('is what core/auth/roles.ts resolves the active guild through', () => {
    // roles.ts used to read the raw globals itself, which is how the store and
    // the actual active tenant could disagree.
    const roles = stripComments(read('src/core/auth/roles.ts'));
    expect(roles).toContain("from '../state/app-state'");
    expect(roles).toContain('getAppState()');
    expect(roles).toContain('patchAppState(');
  });
});

describe('the store is the single write path', () => {
  it('is the only module that assigns the state globals on window', () => {
    const offenders = [];
    for (const f of walk('src')) {
      if (f === STORE) continue;
      const code = stripComments(read(f));
      for (const key of STATE_KEYS) {
        // Matches `w.currentGuild =`, `winAny().currentGuild =`,
        // `(window as any).currentGuild =`, `ww.guildsData =` -- any receiver,
        // since every one of them is `window` in practice. `===`/`==`/`=>` are
        // excluded so comparisons and arrows do not read as assignments.
        const re = new RegExp(`\\.${key}\\s*=(?![=>])`, 'g');
        if (re.test(code)) offenders.push(`${f} → ${key}`);
      }
    }
    expect(offenders, `direct window writes outside the store:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('is reached by name from every module that needs to write state', () => {
    // Guards the guard: if the scan above matched nothing because the state
    // keys were renamed, this fails too rather than going quietly green.
    const writers = walk('src').filter(
      (f) => f !== STORE && /patchAppState\s*\(/.test(stripComments(read(f)))
    );
    expect(writers.length, `modules writing through the store: ${writers.join(', ')}`)
      .toBeGreaterThanOrEqual(5);
  });
});

describe('a read does not write', () => {
  beforeEach(() => {
    resetAppState();
    for (const k of STATE_KEYS) delete window[k];
    localStorage.clear();
  });
  afterEach(() => {
    for (const k of STATE_KEYS) delete window[k];
    localStorage.clear();
  });

  it('does not create the collapsed-roles mirror merely by being asked for state', () => {
    // This is the concrete bug: `getActiveGuild()` calls `getAppState()`, and
    // `getAppState()` used to run `ensureWindowMirror()`, so a read installed
    // `window.GM_COLLAPSED_ROLES`. Anything that then wrote to that object
    // wrote to a mirror the store would overwrite on its next patch.
    expect(window.GM_COLLAPSED_ROLES).toBeUndefined();
    getAppState();
    expect(window.GM_COLLAPSED_ROLES, 'a read installed the mirror').toBeUndefined();
    expect(window.guildsList).toBeUndefined();
  });

  it('establishes the mirror at boot, and refreshes it on every write', () => {
    initAppState();
    expect(window.GM_COLLAPSED_ROLES).toBeTypeOf('object');
    expect(Array.isArray(window.guildsList)).toBe(true);

    patchAppState({ currentGuild: 'OMEGA' });
    expect(window.currentGuild).toBe('OMEGA');
    expect(getAppState().currentGuild).toBe('OMEGA');
  });
});

describe('hydration is absence-aware', () => {
  beforeEach(() => {
    resetAppState();
    for (const k of STATE_KEYS) delete window[k];
    localStorage.clear();
  });
  afterEach(() => {
    for (const k of STATE_KEYS) delete window[k];
    localStorage.clear();
  });

  it('clears a field when its global is deleted, rather than refilling it', () => {
    // The mirror used to be sticky: `ensureWindowMirror()` ran BEFORE
    // `hydrateFromWindow()`, so a deleted global was rewritten from the stale
    // in-memory value and then read back as if it had never been cleared.
    patchAppState({ currentGuildRestriction: 'ALPHA' });
    expect(getAppState().currentGuildRestriction).toBe('ALPHA');

    delete window.currentGuildRestriction;
    expect(getAppState().currentGuildRestriction, 'a deleted restriction came back').toBeNull();
  });

  it('picks up a value assigned straight onto window, which is how the tests seed state', () => {
    window.currentGuild = 'BABE';
    expect(getAppState().currentGuild).toBe('BABE');
  });

  it('hands back a copy of collapsedRoles, so a caller cannot mutate the store', () => {
    initAppState();
    const snapshot = getAppState();
    snapshot.collapsedRoles.R5 = true;
    expect(getAppState().collapsedRoles.R5, 'the snapshot was the store itself').toBe(false);
  });
});
