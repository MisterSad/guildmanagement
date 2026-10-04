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
      '<button class="btn-ocr-trigger" data-metric="kills"><span>scan</span></button>' +
      '<button class="btn-ocr-trigger" id="bare">scan</button>';
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
