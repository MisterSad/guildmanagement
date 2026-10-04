/**
 * tests/app_state.test.js
 *
 * Sous-lot 6.2 — unit suite for the unified app-state store
 * (src/core/state/app-state.ts): defaults, the absence of any window.*
 * mirror since M4c, Set persistence, reset isolation, and non-regression on
 * the roles.ts / combat.ts consumers of the state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initAppState, getAppState, patchAppState, resetAppState } from '../src/core/state/app-state';
import * as roles from '../src/core/auth/roles';
import { getRoleInfo } from '../src/core/scoring/combat';

beforeEach(() => {
  localStorage.clear();
  resetAppState();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAppState();
  localStorage.clear();
});

describe('defaults', () => {
  it('initializes every mirrored field with its documented default', () => {
    const s = getAppState();
    expect(s.currentGuildRestriction).toBeNull();
    expect(s.currentServerRestriction).toBeNull();
    // FINDING H2, and this assertion is the finding: the "documented default"
    // was a real, populated tenant. A session that could not resolve a guild
    // started pointed at ALPHA, and a super_admin or in-scope server_admin has
    // rights there -- so the default was a cross-tenant read, and potentially a
    // cross-tenant write, with no error anywhere.
    expect(s.currentGuild).toBeNull();
    expect(s.guildsList).toEqual([]);
    expect(s.guildsData).toEqual({});
    expect(s.guildAbsences).toEqual([]);
    expect(s.adminSelectedMembers).toBeInstanceOf(Set);
    expect(s.adminSelectedMembers.size).toBe(0);
    expect(s.adminMembersViewMode).toBe('cards');
    expect(s.collapsedRoles).toEqual({ R5: false, R4: false, R3: false, R2: false, R1: false });
  });

  it('seeds currentGuild from localStorage when present', () => {
    localStorage.setItem('gm_current_guild', 'OMEGA');
    resetAppState();
    expect(getAppState().currentGuild).toBe('OMEGA');
  });

  it('initAppState neither reads nor writes window (no mirror since M4c)', () => {
    patchAppState({ currentGuildRestriction: 'CLAW', currentGuild: 'CLAW', guildsList: ['CLAW'] });
    initAppState();
    const s = getAppState();
    expect(s.currentGuildRestriction).toBe('CLAW');
    expect(s.currentGuild).toBe('CLAW');
    expect(s.guildsList).toEqual(['CLAW']);
    expect('currentGuild' in window).toBe(false);
  });
});

// Until M4c every write was mirrored onto `window` and every read hydrated
// from it. The mirror is gone: the store is the only home of this state, and
// these tests pin both halves of that -- every documented key round-trips
// through patchAppState/getAppState, and nothing leaks onto (or is read back
// from) `window`.
const MIRRORED_GLOBALS = [
  'currentGuildRestriction',
  'currentServerRestriction',
  'currentGuild',
  'guildsList',
  'guildsData',
  'guildAbsences',
  'adminMembersViewMode',
  'adminSelectedMembers',
  'GM_COLLAPSED_ROLES',
];

describe('patchAppState — the store is the only home (no window mirror)', () => {
  it('round-trips every documented key and writes none of them on window', () => {
    patchAppState({
      currentGuildRestriction: 'ALPHA',
      currentServerRestriction: '1234',
      currentGuild: 'ALPHA',
      guildsList: ['ALPHA', 'BETA'],
      guildsData: { ALPHA: { server_number: '1234' } },
      guildAbsences: [{ id: 1 }],
      adminMembersViewMode: 'matrix',
      collapsedRoles: { R5: true, R4: false, R3: false, R2: false, R1: false },
      adminSelectedMembers: new Set(['p1']),
    });

    const s = getAppState();
    expect(s.currentGuildRestriction).toBe('ALPHA');
    expect(s.currentServerRestriction).toBe('1234');
    expect(s.currentGuild).toBe('ALPHA');
    expect(s.guildsList).toEqual(['ALPHA', 'BETA']);
    expect(s.guildsData.ALPHA.server_number).toBe('1234');
    expect(s.guildAbsences).toEqual([{ id: 1 }]);
    expect(s.adminMembersViewMode).toBe('matrix');
    expect(s.collapsedRoles.R5).toBe(true);
    expect(s.adminSelectedMembers.has('p1')).toBe(true);

    for (const key of MIRRORED_GLOBALS) expect(key in window).toBe(false);
  });

  it('a partial patch keeps the other fields as they were', () => {
    patchAppState({ guildsData: { ALPHA: { server_number: '9' } }, guildsList: ['ALPHA'] });
    patchAppState({ currentGuild: 'BETA' });
    const s = getAppState();
    expect(s.guildsData.ALPHA.server_number).toBe('9');
    expect(s.guildsList).toEqual(['ALPHA']);
    expect(s.currentGuild).toBe('BETA');
  });

  // Deliberate absence guard: the one place this suite writes a former mirror
  // global, to prove the store no longer hydrates from it.
  it('ignores external window writes (they are no longer read back)', () => {
    window.currentGuildRestriction = 'BABE';
    try {
      expect(getAppState().currentGuildRestriction).toBeNull();
    } finally {
      delete window.currentGuildRestriction;
    }
  });

  it('getAppState returns a copy of collapsedRoles, so mutating it does not write state', () => {
    getAppState().collapsedRoles.R5 = true;
    expect(getAppState().collapsedRoles.R5).toBe(false);
  });
});

describe('adminSelectedMembers — Set identity', () => {
  it('keeps a single Set instance across reads', () => {
    const set = getAppState().adminSelectedMembers;
    set.add('p2');
    expect(getAppState().adminSelectedMembers).toBe(set);
    expect(getAppState().adminSelectedMembers.has('p2')).toBe(true);
  });

  it('adopts a replacement Set from patchAppState', () => {
    const replacement = new Set(['x', 'y']);
    patchAppState({ adminSelectedMembers: replacement });
    expect(getAppState().adminSelectedMembers).toBe(replacement);
    expect(getAppState().adminSelectedMembers.size).toBe(2);
  });
});

describe('resetAppState', () => {
  it('restores defaults on the store, without touching window', () => {
    patchAppState({
      currentGuild: 'OMEGA',
      currentGuildRestriction: 'OMEGA',
      guildsList: ['OMEGA'],
      adminMembersViewMode: 'matrix',
      adminSelectedMembers: new Set(['z']),
    });

    resetAppState();

    const s = getAppState();
    expect(s.currentGuild).toBeNull();
    expect(s.currentGuildRestriction).toBeNull();
    expect(s.guildsList).toEqual([]);
    expect(s.adminMembersViewMode).toBe('cards');
    expect(s.adminSelectedMembers.size).toBe(0);
    for (const key of MIRRORED_GLOBALS) expect(key in window).toBe(false);
  });
});

describe('non-regression — existing consumers', () => {
  it('roles.canWriteGuild reads the mirrored restriction', () => {
    localStorage.setItem('gm_role', 'R4');
    patchAppState({ currentGuildRestriction: 'ALPHA', currentGuild: 'ALPHA' });
    expect(roles.canWriteGuild('ALPHA')).toBe(true);
    expect(roles.canWriteGuild('BETA')).toBe(false);
  });

  it('roles.canWriteGuild blocks without a guild restriction', () => {
    localStorage.setItem('gm_role', 'R4');
    patchAppState({ currentGuildRestriction: null, currentGuild: 'ALPHA' });
    expect(roles.canWriteGuild('ALPHA')).toBe(false);
  });

  it('roles.getActiveGuild reads the mirrored globals', () => {
    patchAppState({ currentGuildRestriction: 'CLAW', currentGuild: 'ALPHA' });
    expect(roles.getActiveGuild()).toBe('CLAW');
  });

  it('combat.getRoleInfo reads the guild restriction from the store', async () => {
    // No client is installed, so the live session lookup yields nothing and
    // the role comes from localStorage + the store's restriction.
    localStorage.setItem('gm_role', 'member');
    patchAppState({ currentGuildRestriction: 'ALPHA' });

    const info = await getRoleInfo();
    expect(info.role).toBe('guild_admin');
    expect(info.guild).toBe('ALPHA');
    expect(info.isGuildAdmin).toBe(true);
    expect(info.isAdmin).toBe(true);
  });
});
