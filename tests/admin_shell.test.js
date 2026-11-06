/**
 * tests/admin_shell.test.js
 *
 * The admin chunk (M5). startAdmin() does the wiring main.ts did for everyone
 * at boot -- tab router, admin forms, OCR triggers, shell -- once, and
 * loadAdmin() downloads it once and retries after a failed download.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  initTabNavigation: vi.fn(),
  initAccountsUi: vi.fn(),
  initGuildRequestsUi: vi.fn(),
  initMembersUi: vi.fn(),
  initBannedUi: vi.fn(),
  initOcrDropdown: vi.fn(),
  initTimezoneCollapsible: vi.fn(),
  openOcrModal: vi.fn(),
  shellInit: vi.fn(),
}));

vi.mock('../src/modules/app/router', () => ({
  initTabNavigation: h.initTabNavigation,
  showAdminDashboard: vi.fn(),
  reloadActiveView: vi.fn(),
  restoreSavedTab: vi.fn(),
}));
vi.mock('../src/modules/app/admin/accounts.controller', () => ({
  initAccountsUi: h.initAccountsUi,
  fetchGuilds: vi.fn(),
}));
vi.mock('../src/modules/app/admin/guild-requests.controller', () => ({ initGuildRequestsUi: h.initGuildRequestsUi }));
vi.mock('../src/modules/app/members/members.controller', () => ({ initMembersUi: h.initMembersUi }));
vi.mock('../src/modules/app/members/banned.controller', () => ({ initBannedUi: h.initBannedUi }));
vi.mock('../src/modules/app/ocr/ocr.controller', () => ({
  openOcrModal: h.openOcrModal,
  initOcrDropdown: h.initOcrDropdown,
  initTimezoneCollapsible: h.initTimezoneCollapsible,
}));
vi.mock('../src/modules/shell/views/ShellView', () => ({ shellView: { init: h.shellInit } }));

import { loadAdmin } from '../src/modules/app/admin-loader';

describe('the admin chunk', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="app"><div id="dashboard-view"><header></header><div id="admin-panels-slot" hidden></div></div></div>' +
      '<div id="admin-ocr-slot" hidden></div>' +
      '<button class="btn-ocr-trigger" data-metric="kills"><span>scan</span></button>' +
      '<button class="btn-ocr-trigger" id="bare">scan</button>';
  });

  it('mounts the admin markup in place of its slots before wiring anything, once', async () => {
    h.initTabNavigation.mockImplementationOnce(() => {
      // The controllers look up their elements as soon as they are wired.
      expect(document.getElementById('admin-members')).not.toBeNull();
    });
    const [a, b] = await Promise.all([loadAdmin(), loadAdmin()]);
    await loadAdmin();
    expect(a).toBe(b);

    // The 15 tab panels (16 until the Migration Hub left, 2026-11-06) are direct children of #dashboard-view, after its header,
    // which is where the shell adopts them; the OCR modal sits after #app.
    const dashboard = document.getElementById('dashboard-view');
    const panels = [...dashboard.children].filter((c) => c.matches('main.tab-panel'));
    expect(panels).toHaveLength(15);
    expect(dashboard.firstElementChild.tagName).toBe('HEADER');
    expect(document.getElementById('app').nextElementSibling.id).toBe('ocr-modal-overlay');
    expect(document.getElementById('admin-panels-slot')).toBeNull();
    expect(document.getElementById('admin-ocr-slot')).toBeNull();
    expect(document.querySelectorAll('#admin-home')).toHaveLength(1);
  });

  it('wires every admin controller and the shell exactly once, however often it is loaded', async () => {
    const [a, b] = await Promise.all([loadAdmin(), loadAdmin()]);
    await loadAdmin();
    expect(a).toBe(b);
    for (const fn of [
      h.initTabNavigation,
      h.initAccountsUi,
      h.initGuildRequestsUi,
      h.initMembersUi,
      h.initBannedUi,
      h.initOcrDropdown,
      h.initTimezoneCollapsible,
      h.shellInit,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it('opens the OCR modal from any .btn-ocr-trigger, defaulting to members', async () => {
    await loadAdmin();
    h.openOcrModal.mockClear();
    document.querySelector('.btn-ocr-trigger span').click();
    document.getElementById('bare').click();
    expect(h.openOcrModal.mock.calls).toEqual([['kills'], ['members']]);
  });
});

describe('the admin markup that moved out of index.html', () => {
  it('rebuilds, slot by slot, the page the browser used to parse', async () => {
    const { appHtml, ADMIN_FRAGMENTS } = await import('./helpers/app-html.js');
    const fs = await import('fs');
    const index = fs.readFileSync('index.html', 'utf8');
    for (const [slot] of ADMIN_FRAGMENTS) expect(index.split(slot)).toHaveLength(2);
    const page = appHtml();
    expect(page).toContain('<main class="dashboard-content tab-panel" id="admin-home"');
    expect(page).toContain('id="ocr-modal-overlay"');
    // index.html itself no longer ships a single admin panel.
    expect(index).not.toMatch(/class="dashboard-content tab-panel"/);
    expect(index).not.toContain('id="ocr-modal-overlay"');
  });
});
