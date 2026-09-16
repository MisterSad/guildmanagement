/**
 * tests/app_dialogs.test.js
 *
 * Sous-lot 6.1 — unit/parity suite for the typed global dialogs ported from
 * app.js into src/modules/app/dialogs/dialogs.service.ts. The legacy app.js is
 * still loaded in production; these tests cover the /src implementation that
 * src/main.ts bridges onto window.showConfirm / window.GM_APP.*.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  showConfirm,
  showPlayerHistoryDialog,
  openCustomMsgModal,
  showToast
} from '../src/modules/app/dialogs/dialogs.service';
import { initGuildRequestsUi } from '../src/modules/app/admin/guild-requests.controller';

beforeEach(() => {
  document.body.innerHTML = '';
  if (!window.GM) window.GM = {};
  delete window.GM.db;
  delete window.GM.config;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete window.GM_APP;
  delete window.showConfirm;
});

describe('showConfirm', () => {
  it('injects the overlay, escapes the title and keeps trusted message HTML', () => {
    const onConfirm = vi.fn();
    showConfirm('<b>Danger</b>', '<strong>Body</strong>', onConfirm);

    const overlay = document.getElementById('confirm-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay.className).toContain('gm-modal-overlay');

    const title = overlay.querySelector('h3');
    // Title is escaped: no live <b> element, literal text preserved.
    expect(title.querySelector('b')).toBeNull();
    expect(title.textContent).toContain('<b>Danger</b>');

    // Message stays trusted HTML by contract (legacy callers pass markup).
    expect(overlay.querySelector('p').innerHTML).toContain('<strong>Body</strong>');

    // Settle so the document-level Escape listener is removed.
    document.getElementById('confirm-ok').click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('invokes onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    showConfirm('Title', 'Message', onConfirm, onCancel);

    document.getElementById('confirm-ok').click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('invokes onCancel when the cancel button is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    showConfirm('Title', 'Message', onConfirm, onCancel);

    document.getElementById('confirm-cancel').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('closes on Escape and invokes onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    showConfirm('Title', 'Message', onConfirm, onCancel);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('replaces any previous overlay (single-modal invariant)', () => {
    showConfirm('First', 'M', vi.fn());
    showConfirm('Second', 'M', vi.fn());
    expect(document.querySelectorAll('#confirm-overlay').length).toBe(1);
    expect(document.getElementById('confirm-overlay').querySelector('h3').textContent).toBe('Second');
    document.getElementById('confirm-ok').click();
  });
});

describe('showPlayerHistoryDialog', () => {
  it('renders the loading state then the history sections', async () => {
    const rpc = vi.fn((name) => {
      if (name === 'gm_get_player_metrics_history') {
        return Promise.resolve({ data: { ok: true, history: [{ total_power: 1500, week_start: '2026-01-01' }] } });
      }
      return Promise.resolve({ data: { ok: true, events: { GvG: { attended: 3, count: 4, rate: 75 } } } });
    });
    const drawScoreTrendChart = vi.fn();
    window.GM.db = { rpc };
    window.GM.drawScoreTrendChart = drawScoreTrendChart;

    const pending = showPlayerHistoryDialog('123456', 'Alpha');

    const overlay = document.getElementById('player-history-overlay');
    expect(overlay).toBeTruthy();
    expect(document.getElementById('player-history-body').textContent).toContain('Loading history');

    await pending;

    const body = document.getElementById('player-history-body');
    expect(body.textContent).toContain('Power trend');
    expect(body.textContent).toContain('GvG');
    expect(rpc).toHaveBeenCalledWith('gm_get_player_metrics_history', { p_uid: '123456', p_limit: 12 });
    expect(rpc).toHaveBeenCalledWith('gm_get_player_event_history', { p_uid: '123456', p_limit: 60 });
    expect(drawScoreTrendChart).toHaveBeenCalledTimes(1);

    document.getElementById('player-history-overlay').remove();
  });

  it('shows an empty-state when the player has no UID', async () => {
    window.GM.db = { rpc: vi.fn() };
    await showPlayerHistoryDialog('', 'Alpha');
    expect(document.getElementById('player-history-body').textContent).toContain('No UID on file');
    expect(window.GM.db.rpc).not.toHaveBeenCalled();
    document.getElementById('player-history-overlay').remove();
  });

  it('shows a failure state when the RPC rejects', async () => {
    window.GM.db = { rpc: vi.fn(() => Promise.reject(new Error('network'))) };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await showPlayerHistoryDialog('123456', 'Alpha');

    expect(document.getElementById('player-history-body').textContent).toContain('Failed to load player history');
    expect(spy).toHaveBeenCalled();
    document.getElementById('player-history-overlay').remove();
  });
});

describe('openCustomMsgModal', () => {
  it('renders the personalization modal for a given event prefix', async () => {
    window.GM.config = { get: vi.fn(async () => ''), set: vi.fn(async () => undefined) };

    await openCustomMsgModal('armsrace');

    const overlay = document.getElementById('custom-msg-modal');
    expect(overlay).toBeTruthy();
    expect(overlay.textContent).toContain('Personalization - Arms Race');
    expect(document.getElementById('tpl-reminder_30-content')).toBeTruthy();
    expect(document.getElementById('tpl-start-content')).toBeTruthy();
    expect(document.getElementById('tpl-reminder_30-content').getAttribute('placeholder')).toContain('30 minutes');
  });

  it('renders the SvS reminder set and persists the edited templates', async () => {
    const set = vi.fn(async () => undefined);
    window.GM.config = { get: vi.fn(async () => ''), set };

    await openCustomMsgModal('svs');

    const garrison = document.getElementById('tpl-garrison-content');
    expect(garrison).toBeTruthy();
    expect(document.getElementById('tpl-start_defense-content')).toBeTruthy();

    const content = document.getElementById('tpl-garrison-content');
    content.value = 'Custom garrison text';
    document.getElementById('custom-msg-modal-save').click();

    await vi.waitFor(() => expect(set).toHaveBeenCalled());
    expect(set).toHaveBeenCalledWith('tpl_svs_garrison_content', 'Custom garrison text');
    expect(set).toHaveBeenCalledWith('tpl_svs_start_defense_title', '');
  });

  it('closes without saving when cancelled', async () => {
    const set = vi.fn(async () => undefined);
    window.GM.config = { get: vi.fn(async () => ''), set };

    await openCustomMsgModal('gvg');
    document.getElementById('custom-msg-modal-cancel').click();

    expect(document.getElementById('custom-msg-modal').classList.contains('visible')).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('wires [data-custom-msg] buttons via initGuildRequestsUi and opens modal on click', async () => {
    window.GM.config = { get: vi.fn(async () => ''), set: vi.fn(async () => undefined) };
    document.body.innerHTML = '<button type="button" data-custom-msg="gvg">Edit GVG</button>';

    initGuildRequestsUi();

    document.querySelector('[data-custom-msg="gvg"]').click();
    await vi.waitFor(() => expect(document.getElementById('custom-msg-modal')).toBeTruthy());
    expect(document.getElementById('custom-msg-modal').textContent).toContain('Personalization - GvG Saturday');
  });
});

describe('showToast (concrete host)', () => {
  it('renders a toast without recursing through GM_APP.showToast', () => {
    document.body.innerHTML = '<div id="toast-container"></div>';
    window.GM_APP = { showToast };
    showToast('Saved', 'success');
    const toast = document.querySelector('#toast-container .toast');
    expect(toast).toBeTruthy();
    expect(toast.textContent).toContain('Saved');
    expect(toast.classList.contains('success')).toBe(true);
  });
});
