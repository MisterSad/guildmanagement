/**
 * tests/app_ocr.test.js
 *
 * Sous-lot 6.7 — jsdom suite for the typed OCR pipeline ported from app.js into
 * src/modules/app/ocr/ (modal lifecycle, diff rendering, commit flow).
 * Legacy app.js is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Phase M4c: the OCR controller imports showConfirm and getGuildTag instead of
// reading `window.showConfirm` / `window.GM.getGuildTag`.
const mocks = vi.hoisted(() => ({
  showConfirm: vi.fn(),
  getGuildTag: vi.fn()
}));
vi.mock('../src/modules/app/dialogs/dialogs.service', async (importOriginal) => ({
  ...(await importOriginal()),
  showConfirm: mocks.showConfirm
}));
vi.mock('../src/core/config/guild-config', async (importOriginal) => ({
  ...(await importOriginal()),
  getGuildTag: mocks.getGuildTag
}));

import {
  openOcrModal,
  closeOcrModal,
  setOcrMetric,
  handleOcrFiles,
  commitOcrUpdates
} from '../src/modules/app/ocr/ocr.controller';
import { renderOcrResults, updateCommitButtonCount, toggleAllCheckboxes } from '../src/modules/app/ocr/ocr.render';
import {
  setOcrExtractedPlayers,
  getOcrExtractedPlayers,
  getCurrentOcrMetric
} from '../src/modules/app/ocr/ocr.meta';
import { setGuildMembers, clearMembersStore } from '../src/modules/app/members/members.store';
import { setVerifiedRole } from '../src/core/auth/roles';
import { patchAppState, resetAppState } from '../src/core/state/app-state';

const OCR_DOM = `
  <div id="ocr-modal-overlay" style="display:none">
    <h3 id="ocr-modal-title"></h3>
    <p id="ocr-modal-subtitle"></p>
    <span id="ocr-scope-badge"></span><span id="ocr-scope-desc"></span>
    <div id="ocr-tag-input-group"><input id="ocr-guild-tag-input" /></div>
    <div id="ocr-metric-tabs">
      <button class="gm-seg-btn" data-metric="members"></button>
      <button class="gm-seg-btn" data-metric="power"></button>
    </div>
    <div id="ocr-dropzone"><h4 id="ocr-dropzone-title"></h4><p id="ocr-dropzone-desc"></p></div>
    <div id="ocr-loading" style="display:none"><h4></h4><p></p></div>
    <input id="ocr-file-input" type="file" />
    <div id="ocr-results-container" style="display:none">
      <table class="ocr-table">
        <thead><tr><th id="ocr-metric-header"></th><th id="ocr-rank-header"></th></tr></thead>
        <tbody id="ocr-results-tbody"></tbody>
      </table>
      <table><tbody id="ocr-results-tbody-new"></tbody></table>
      <table><tbody id="ocr-results-tbody-removed"></tbody></table>
    </div>
    <span id="ocr-detected-count">0</span>
    <div id="ocr-summary-badges"></div>
    <input id="ocr-filter-search" />
    <button id="ocr-toggle-all-cb-btn"></button><input id="ocr-toggle-all-cb" type="checkbox" />
    <button id="ocr-select-all-btn"></button>
    <button id="ocr-commit-btn"><span></span></button>
    <button id="ocr-modal-close"></button><button id="ocr-modal-cancel"></button>
    <button id="ocr-reset-btn"></button>
  </div>
  <div id="guild-member-list"></div><span id="guild-member-count">0</span>
  <div id="toast-container"></div>
`;

function makeDb() {
  const calls = { rpc: [], update: [], insert: [], delete: [] };
  function chain(table) {
    const obj = {
      select() { return obj; }, eq() { return obj; }, order() { return obj; },
      not() { return obj; }, ilike() { return obj; },
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      in: async () => ({ data: null, error: null }),
      then: (resolve) => resolve({ data: [], error: null })
    };
    void table;
    return obj;
  }
  return {
    __calls: calls,
    rpc: async (name, args) => { calls.rpc.push({ name, args }); return { data: { ok: true }, error: null }; },
    from(table) {
      return {
        select: () => chain(table),
        update: (payload) => { calls.update.push({ table, payload }); return chain(table); },
        insert: (payload) => { calls.insert.push({ table, payload }); return chain(table); },
        delete: () => { calls.delete.push({ table }); return chain(table); }
      };
    }
  };
}

const MEMBERS = [
  { pseudo: 'Bob', uid: '111111', role: 'R1', guild: 'ALPHA', overall_power: 100 },
  { pseudo: 'Ghost', uid: '222222', role: 'R2', guild: 'ALPHA', overall_power: 80 }
];

beforeEach(async () => {
  document.body.innerHTML = OCR_DOM;
  clearMembersStore();
  setGuildMembers(MEMBERS.map((m) => ({ ...m })));
  setOcrExtractedPlayers([]);
  localStorage.clear();

  window.GM = window.GM || {};
  window.GM.db = makeDb();
  // A writer: the transactional RPCs refuse a read-only caller before any request.
  setVerifiedRole('super_admin', 't_super');
  patchAppState({ currentGuild: 'ALPHA' });
  mocks.getGuildTag.mockReset().mockImplementation(async () => '[FGF]');
  mocks.showConfirm.mockReset().mockImplementation((_t, _m, onConfirm) => { void onConfirm(); });
  window.GM_OVERVIEW = { load: vi.fn() };
  await setOcrMetric('members');
});

afterEach(() => {
  vi.restoreAllMocks();
  clearMembersStore();
  setOcrExtractedPlayers([]);
  document.body.innerHTML = '';
  resetAppState();
  delete window.GM_OVERVIEW;
  localStorage.clear();
});

describe('modal lifecycle', () => {
  it('opens the modal, resets state, then closes it', async () => {
    await openOcrModal('power');
    const overlay = document.getElementById('ocr-modal-overlay');
    expect(overlay.style.display).toBe('flex');
    expect(overlay.classList.contains('visible')).toBe(true);
    expect(getCurrentOcrMetric()).toBe('power');
    expect(document.getElementById('ocr-dropzone').style.display).toBe('block');

    closeOcrModal();
    expect(overlay.style.display).toBe('none');
    expect(overlay.classList.contains('visible')).toBe(false);
  });

  it('closeOcrModal dismisses any active confirm-overlay', async () => {
    await openOcrModal('members');
    const confirmOverlay = document.createElement('div');
    confirmOverlay.id = 'confirm-overlay';
    document.body.appendChild(confirmOverlay);
    expect(document.getElementById('confirm-overlay')).toBeTruthy();

    closeOcrModal();
    expect(document.getElementById('confirm-overlay')).toBeNull();
  });

  it('setOcrMetric updates titles/headers and keeps members rank header visible', async () => {
    await setOcrMetric('members');
    expect(document.getElementById('ocr-modal-title').textContent).toContain('Members OCR');
    expect(document.getElementById('ocr-metric-header').textContent).toBe('Members');
    expect(document.getElementById('ocr-rank-header').style.display).toBe('');

    await setOcrMetric('power');
    expect(document.getElementById('ocr-metric-header').textContent).toBe('Extracted Power');
    expect(document.getElementById('ocr-rank-header').style.display).toBe('none');
  });

  it('rejects unknown files without side effects', async () => {
    await handleOcrFiles([{ type: 'text/plain' }]);
    expect(document.getElementById('ocr-results-container').style.display).toBe('none');
    expect(document.getElementById('ocr-dropzone').style.display).toBe('');
  });
});

describe('renderOcrResults — roster diff', () => {
  it('renders existing (update), new and removed sections for members mode', async () => {
    setOcrExtractedPlayers([{ pseudo: 'Bob', score: 150 }, { pseudo: 'Newbie', score: 50 }]);
    renderOcrResults(getOcrExtractedPlayers());

    const existing = document.getElementById('ocr-results-tbody');
    const added = document.getElementById('ocr-results-tbody-new');
    const removed = document.getElementById('ocr-results-tbody-removed');

    expect(existing.textContent).toContain('Existing Members');
    expect(existing.querySelector('[data-pseudo="bob"]')).toBeTruthy();
    expect(existing.textContent).toContain('Update');
    expect(added.textContent).toContain('New Members');
    expect(added.querySelector('[data-pseudo="newbie"]')).toBeTruthy();
    expect(removed.textContent).toContain('Removed Members');
    expect(removed.querySelector('[data-pseudo="ghost"]')).toBeTruthy();
    expect(document.getElementById('ocr-detected-count').textContent).toBe('2');
  });

  it('updates the commit button count and toggles all checkboxes', () => {
    setOcrExtractedPlayers([{ pseudo: 'Bob', score: 150 }, { pseudo: 'Newbie', score: 50 }]);
    renderOcrResults(getOcrExtractedPlayers());

    const btn = document.getElementById('ocr-commit-btn');
    expect(btn.disabled).toBe(false);
    expect(btn.querySelector('span').textContent).toContain('Validate & Apply Updates');

    toggleAllCheckboxes(false);
    updateCommitButtonCount();
    // The removed-member checkbox is outside toggleAllCheckboxes, so it stays checked.
    expect(btn.querySelector('span').textContent).toContain('(1)');
  });

  it('shows the empty state when nothing was detected', () => {
    renderOcrResults([]);
    expect(document.getElementById('ocr-results-tbody').textContent).toContain('No player usernames');
    expect(document.getElementById('ocr-commit-btn').textContent).toBeTruthy();
  });

  it('displays scan coverage badge and unchecks removals by default when partial scan (<75%) on a 5+ member roster', () => {
    // Setup a 6-member roster
    setGuildMembers([
      { pseudo: 'P1', uid: '1001', role: 'R1', guild: 'ALPHA', overall_power: 100 },
      { pseudo: 'P2', uid: '1002', role: 'R1', guild: 'ALPHA', overall_power: 100 },
      { pseudo: 'P3', uid: '1003', role: 'R1', guild: 'ALPHA', overall_power: 100 },
      { pseudo: 'P4', uid: '1004', role: 'R1', guild: 'ALPHA', overall_power: 100 },
      { pseudo: 'P5', uid: '1005', role: 'R1', guild: 'ALPHA', overall_power: 100 },
      { pseudo: 'P6', uid: '1006', role: 'R1', guild: 'ALPHA', overall_power: 100 }
    ]);

    // Partial OCR scan: only 2 of 6 members found (33% coverage)
    setOcrExtractedPlayers([
      { pseudo: 'P1', score: 120 },
      { pseudo: 'P2', score: 110 }
    ]);

    renderOcrResults(getOcrExtractedPlayers());

    // Check summary badge has coverage
    const badges = document.getElementById('ocr-summary-badges');
    expect(badges.textContent).toContain('Coverage');
    expect(badges.textContent).toContain('33%');

    // Partial scan warning is shown
    const removedTbody = document.getElementById('ocr-results-tbody-removed');
    expect(removedTbody.textContent).toContain('Partial scan detected');

    // Missing members are unchecked by default for safety
    const removalCheckboxes = removedTbody.querySelectorAll('.ocr-removal-cb');
    expect(removalCheckboxes.length).toBe(4);
    removalCheckboxes.forEach((cb) => {
      expect(cb.checked).toBe(false);
    });
  });
});

describe('commitOcrUpdates — roster flow', () => {
  it('updates existing, inserts new and deletes removals, then refreshes', async () => {
    setOcrExtractedPlayers([
      { pseudo: 'Bob', score: 150 },
      { pseudo: 'Newbie', score: 50 }
    ]);
    renderOcrResults(getOcrExtractedPlayers());

    await commitOcrUpdates();

    const calls = window.GM.db.__calls;
    // M4a: the whole import is ONE call to gm_commit_ocr_roster, after the
    // removals were confirmed -- no table write from the browser.
    await vi.waitFor(() => expect(calls.rpc.some((c) => c.name === 'gm_commit_ocr_roster')).toBe(true));
    const commit = calls.rpc.find((c) => c.name === 'gm_commit_ocr_roster').args;
    expect(commit.p_field).toBe('overall_power');
    expect(commit.p_existing).toEqual([{ pseudo: 'Bob', score: 150 }]);
    expect(commit.p_new).toEqual([{ pseudo: 'Newbie', uid: null, score: 50, role: 'R1' }]);
    expect(commit.p_removals).toEqual(['Ghost']);
    expect(calls.update.concat(calls.insert, calls.delete).filter((c) => c.table === 'guild_members')).toEqual([]);
    expect(mocks.showConfirm).toHaveBeenCalled();
  });

  it('blocks the commit when nothing is selected', async () => {
    setGuildMembers([{ pseudo: 'Bob', uid: '111111', role: 'R1', guild: 'ALPHA', overall_power: 100 }]);
    setOcrExtractedPlayers([{ pseudo: 'Bob', score: 150 }]);
    renderOcrResults(getOcrExtractedPlayers());
    toggleAllCheckboxes(false);

    window.GM.db.__calls.update.length = 0;
    await commitOcrUpdates();

    expect(window.GM.db.__calls.update.length).toBe(0);
  });
});
