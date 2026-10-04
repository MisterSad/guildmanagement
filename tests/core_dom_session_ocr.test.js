/**
 * tests/core_dom_session_ocr.test.js
 *
 * Phase 1 (Sous-lot 5.2C) suite for the DOM/Discord/session/OCR helpers ported
 * from gm-utils.js into /src/core and /src/modules. Legacy file untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { showToast } from '../src/core/dom/toast';
import { formatDiscordRoleMention } from '../src/core/integrations/discord';
import { generateJoinCode } from '../src/core/auth/session';
import {
  getUidStatus,
  isInvalidOrTempUid,
  categorizeOcrDiff,
  computeOcrRosterDelta,
  ocrDownsampleEvenly,
} from '../src/modules/ocr/ocr.service';
import {
  filterBulkEligibleMembers,
  getAllowedBulkRoles,
  isRoleAllowedForBulk,
  formatTicketDescription,
} from '../src/modules/members/members.service';

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('showToast', () => {
  it('appends a toast into the container', () => {
    document.body.innerHTML = '<div id="toast-container"></div>';
    showToast('Hello', 'success', 10);
    const toast = document.querySelector('#toast-container .toast');
    expect(toast).toBeTruthy();
    expect(toast.textContent).toContain('Hello');
    expect(toast.classList.contains('success')).toBe(true);
  });

  // It used to delegate to a `GM_APP.showToast` host on window, which main.ts
  // pointed at renderToast(msg, type, 3500). Since M4c it renders directly,
  // so the 3500 ms default the host applied must now come from showToast.
  it('renders directly with the 3500 ms default the app host used to apply', () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<div id="toast-container"></div>';
      showToast('Hi', 'info');
      const toast = document.querySelector('#toast-container .toast');
      expect(toast.textContent).toContain('Hi');
      vi.advanceTimersByTime(3499);
      expect(toast.classList.contains('fade-out')).toBe(false);
      vi.advanceTimersByTime(1);
      expect(toast.classList.contains('fade-out')).toBe(true);
      vi.advanceTimersByTime(300);
      expect(document.querySelector('#toast-container .toast')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a no-op without a container', () => {
    expect(() => showToast('x', 'info')).not.toThrow();
  });
});

describe('Discord formatting', () => {
  it('formats role ids and mentions', () => {
    expect(formatDiscordRoleMention('123456789012345678')).toBe('<@&123456789012345678>');
    expect(formatDiscordRoleMention('<@&123456789012345678>')).toBe('<@&123456789012345678>');
    expect(formatDiscordRoleMention('@everyone')).toBe('@everyone');
    expect(formatDiscordRoleMention('@here')).toBe('@here');
    expect(formatDiscordRoleMention('')).toBe('@everyone');
    expect(formatDiscordRoleMention(null)).toBe('@everyone');
  });
});

describe('session — join codes (passkeys were removed on 2026-10-03)', () => {
  it('generateJoinCode uses the FGF-XXXX-XXXX shape', () => {
    expect(generateJoinCode()).toMatch(/^FGF-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(generateJoinCode('ABC')).toMatch(/^ABC-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

describe('OCR helpers', () => {
  it('getUidStatus / isInvalidOrTempUid classify UIDs', () => {
    expect(getUidStatus('123456').valid).toBe(true);
    expect(getUidStatus('TEMP-1').status).toBe('temp');
    expect(getUidStatus('abc').status).toBe('nan');
    expect(getUidStatus('12345').status).toBe('length');
    expect(getUidStatus('').status).toBe('missing');
    expect(isInvalidOrTempUid('TEMP-1')).toBe(true);
    expect(isInvalidOrTempUid('123456')).toBe(false);
  });

  it('categorizeOcrDiff matches roster and detects excluded tags', () => {
    const roster = [{ pseudo: 'Alpha', overall_power: 100, uid: '123456' }];
    const players = [{ pseudo: '[TAG]Alpha', score: 100 }];
    const res = categorizeOcrDiff(players, roster, 'TAG', 'overall_power', false, 'members');
    expect(res.existing.length).toBe(1);
    expect(res.existing[0].status).toBe('reconciled');
    expect(res.removed.length).toBe(0);
  });

  it('categorizeOcrDiff lists new players and unmatched roster members', () => {
    const roster = [{ pseudo: 'Alpha', overall_power: 100, uid: '123456' }];
    const players = [{ pseudo: 'NewGuy', score: 50 }];
    const res = categorizeOcrDiff(players, roster, null, 'overall_power', false, 'members');
    expect(res.new.length).toBe(1);
    expect(res.removed.length).toBe(1);
    expect(res.removed[0].pseudo).toBe('Alpha');
  });

  it('computeOcrRosterDelta projects roster counts', () => {
    expect(computeOcrRosterDelta(100, 5, 3)).toEqual({ before: 100, after: 102, added: 5, removed: 3 });
    expect(computeOcrRosterDelta('x', '2', '9')).toEqual({ before: 0, after: 0, added: 2, removed: 9 });
  });

  it('ocrDownsampleEvenly keeps first/last and covers the range', () => {
    const out = ocrDownsampleEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(out.length).toBe(5);
    expect(out[0]).toBe(1);
    expect(out[out.length - 1]).toBe(10);
    expect(ocrDownsampleEvenly([1, 2], 5)).toEqual([1, 2]);
  });
});

describe('members helpers', () => {
  it('bulk roles: R1-R4 allowed, R5 excluded', () => {
    expect(getAllowedBulkRoles()).toEqual(['R1', 'R2', 'R3', 'R4']);
    expect(isRoleAllowedForBulk('R3')).toBe(true);
    expect(isRoleAllowedForBulk('R5')).toBe(false);
  });

  it('filterBulkEligibleMembers protects R5 and keeps real members', () => {
    const members = [
      { pseudo: 'Alpha', role: 'R1' },
      { pseudo: 'Leader', role: 'R5' },
      { pseudo: 'Ghost', role: 'R2' },
    ];
    const res = filterBulkEligibleMembers(members, ['Alpha', 'Leader', 'Nope']);
    expect(res.eligiblePseudos).toEqual(['Alpha']);
    expect(res.excludedR5Count).toBe(1);
  });

  it('filterBulkEligibleMembers accepts a Set', () => {
    const members = [{ pseudo: 'Alpha', role: 'R2' }];
    const res = filterBulkEligibleMembers(members, new Set(['Alpha']));
    expect(res.eligiblePseudos).toEqual(['Alpha']);
  });

  it('formatTicketDescription includes the environment footer', () => {
    const out = formatTicketDescription({
      currentBehavior: 'it broke',
      expectedBehavior: 'it should work',
      env: { appVersion: 'V9', os: 'macOS', browser: 'Safari 26' },
    });
    expect(out).toContain('**Current Behavior / Issue**\nit broke');
    expect(out).toContain('FGF Mgmt Tool Version: V9');
    expect(out).toContain('OS + Version: macOS');
    expect(out).toContain('Browser + Version: Safari 26');
  });
});
