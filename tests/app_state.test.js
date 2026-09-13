/**
 * tests/app_state.test.js
 *
 * Sous-lot 6.2 — unit suite for the unified app-state store
 * (src/modules/app/state/app-state.ts): defaults, window.* mirroring,
 * Set persistence, reset isolation, and non-regression on the existing
 * roles.ts / combat.ts consumers of the mirrored globals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initAppState, getAppState, patchAppState, resetAppState } from '../src/modules/app/state/app-state';
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
    expect(s.currentGuild).toBe('ALPHA');
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

  it('initAppState preserves values already written on window (app.js wins)', () => {
    window.currentGuildRestriction = 'CLAW';
    window.currentGuild = 'CLAW';
    window.guildsList = ['CLAW'];
    initAppState();
    const s = getAppState();
    expect(s.currentGuildRestriction).toBe('CLAW');
    expect(s.currentGuild).toBe('CLAW');
    expect(s.guildsList).toEqual(['CLAW']);
  });
});

describe('patchAppState — window.* mirroring', () => {
  it('mirrors every documented key onto window', () => {
    patchAppState({
      currentGuildRestriction: 'ALPHA',
      currentServerRestriction: '1234',
      currentGuild: 'ALPHA',
      guildsList: ['ALPHA', 'BETA'],
      guildsData: { ALPHA: { server_number: '1234' } },
      guildAbsences: [{ id: 1 }],
      adminMembersViewMode: 'matrix',
      collapsedRoles: { R5: true, R4: false, R3: false, R2: false, R1: false },
      adminSelectedMembers: new Set(['p1'])
    });

    expect(window.currentGuildRestriction).toBe('ALPHA');
    expect(window.currentServerRestriction).toBe('1234');
    expect(window.currentGuild).toBe('ALPHA');
    expect(window.guildsList).toEqual(['ALPHA', 'BETA']);
    expect(window.guildsData.ALPHA.server_number).toBe('1234');
    expect(window.guildAbsences).toEqual([{ id: 1 }]);
    expect(window.adminMembersViewMode).toBe('matrix');
    expect(window.GM_COLLAPSED_ROLES.R5).toBe(true);
    expect(window.adminSelectedMembers.has('p1')).toBe(true);
  });

  it('does not clobber window values written directly by app.js', () => {
    window.guildsData = { ALPHA: { server_number: '9' } };
    window.guildsList = ['ALPHA'];
    patchAppState({ currentGuild: 'BETA' });
    expect(window.guildsData.ALPHA.server_number).toBe('9');
    expect(window.guildsList).toEqual(['ALPHA']);
    expect(window.currentGuild).toBe('BETA');
  });

  it('reads external window writes back through getAppState', () => {
    window.currentGuildRestriction = 'BABE';
    expect(getAppState().currentGuildRestriction).toBe('BABE');
  });
});

describe('adminSelectedMembers — Set identity', () => {
  it('keeps a single Set instance shared with window', () => {
    const set = getAppState().adminSelectedMembers;
    set.add('p2');
    expect(getAppState().adminSelectedMembers.has('p2')).toBe(true);
    expect(window.adminSelectedMembers).toBeInstanceOf(Set);
    expect(window.adminSelectedMembers.has('p2')).toBe(true);
  });

  it('mirrors a replacement Set from patchAppState', () => {
    patchAppState({ adminSelectedMembers: new Set(['x', 'y']) });
    expect(getAppState().adminSelectedMembers.size).toBe(2);
    expect(window.adminSelectedMembers.has('y')).toBe(true);
  });
});

describe('resetAppState', () => {
  it('restores defaults on both the store and the window mirror', () => {
    patchAppState({
      currentGuild: 'OMEGA',
      currentGuildRestriction: 'OMEGA',
      guildsList: ['OMEGA'],
      adminMembersViewMode: 'matrix',
      adminSelectedMembers: new Set(['z'])
    });

    resetAppState();

    const s = getAppState();
    expect(s.currentGuild).toBe('ALPHA');
    expect(s.currentGuildRestriction).toBeNull();
    expect(s.guildsList).toEqual([]);
    expect(s.adminMembersViewMode).toBe('cards');
    expect(s.adminSelectedMembers.size).toBe(0);
    expect(window.currentGuild).toBe('ALPHA');
    expect(window.guildsList).toEqual([]);
    expect(window.adminSelectedMembers.size).toBe(0);
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

  it('roles.getActiveGuild / isPaymentsDisabled read the mirrored globals', () => {
    patchAppState({
      currentGuildRestriction: 'CLAW',
      currentGuild: 'ALPHA',
      guildsData: { CLAW: { paymentsDisabled: true } }
    });
    expect(roles.getActiveGuild()).toBe('CLAW');
    expect(roles.isPaymentsDisabled('CLAW')).toBe(true);
    expect(roles.isPaymentsDisabled('ALPHA')).toBe(false);
  });

  it('combat.getRoleInfo reads window.currentGuildRestriction', async () => {
    localStorage.setItem('gm_role', 'member');
    window.GM = window.GM || {};
    window.GM.sessionInfo = async () => null;
    patchAppState({ currentGuildRestriction: 'ALPHA' });

    const info = await getRoleInfo();
    expect(info.role).toBe('guild_admin');
    expect(info.guild).toBe('ALPHA');
    expect(info.isGuildAdmin).toBe(true);
    expect(info.isAdmin).toBe(true);
  });
});
