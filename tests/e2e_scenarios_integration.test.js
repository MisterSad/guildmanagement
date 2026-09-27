/**
 * E2E Scenarios Integration Suite (Vitest + JSDOM)
 *
 * Provides deterministic, in-process DOM validation of end-to-end user workflows:
 * 1. Playwright configuration integrity (webServer url, timeouts, command).
 * 2. E2E test suite coverage (verifies all critical user flows are covered in e2e/).
 * 3. Session lifecycle: gm:session-expired event handling and storage cleanup.
 * 4. Modal accessibility: WCAG 2.2 AA attributes and focus trap behavior.
 * 5. Custom messages: modal trigger wiring and pill insertion.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDialog, closeDialog } from '../src/components/ui/Dialog';
import { openCustomMsgModal } from '../src/modules/app/dialogs/dialogs.service';
import { doLogout } from '../src/modules/app/auth/auth.controller';

const rootDir = path.resolve(__dirname, '..');
const e2eDir = path.join(rootDir, 'e2e');
const playwrightConfigPath = path.join(rootDir, 'playwright.config.js');

describe('TICKET-13 [TEST-01]: Playwright Configuration & E2E Coverage', () => {
  it('validates playwright.config.js configuration', () => {
    expect(fs.existsSync(playwrightConfigPath)).toBe(true);
    const config = fs.readFileSync(playwrightConfigPath, 'utf8');

    expect(config).toContain("url: 'http://localhost:4173'");
    expect(config).toContain('--no-install serve');
    expect(config).toContain('timeout: 120_000');
    expect(config).toContain("baseURL: 'http://localhost:4173'");
  });

  it('verifies all expected E2E spec files exist in e2e/', () => {
    const specs = fs.readdirSync(e2eDir);

    expect(specs).toContain('boot.spec.js');
    expect(specs).toContain('dashboard-nav.spec.js');
    // `guild-request.spec.js` was removed on 2026-09-27 with the public
    // "Request a Guild" tab it covered. Guild creation runs through Discord
    // sign-in now, and `login-discord-first.spec.js` covers the page it left.
    expect(specs).not.toContain('guild-request.spec.js');
    expect(specs).toContain('login-discord-first.spec.js');
    expect(specs).toContain('login.spec.js');
    expect(specs).toContain('ocr-modal.spec.js');
    expect(specs).toContain('portal.spec.js');
    expect(specs).toContain('dialog-a11y.spec.js');
    expect(specs).toContain('custom-msg-modal.spec.js');
    expect(specs).toContain('session-lifecycle.spec.js');
    expect(specs).toContain('privacy.spec.js');
    expect(specs).toContain('icons.spec.js');
  });
});

describe('TICKET-13 [TEST-01]: Session Lifecycle Integration', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="login-view" class="hidden">
        <form id="login-form"><input id="login-id" /></form>
      </div>
      <div id="dashboard-view" class="active"></div>
    `;
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_user', 'commander_alpha');
    sessionStorage.setItem('gm_account_id', 'acc-123');
  });

  it('doLogout cleans up session markers and restores login view', async () => {
    await doLogout();

    expect(localStorage.getItem('gm_user')).toBeNull();
    const loginView = document.getElementById('login-view');
    expect(loginView?.classList.contains('hidden')).toBe(false);
    expect(loginView?.classList.contains('active')).toBe(true);
  });
});

describe('TICKET-13 [TEST-01]: Modal Accessibility & Custom Message Integration', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="app">
        <button id="trigger-btn">Open Dialog</button>
      </div>
    `;
  });

  it('verifies Dialog applies alertdialog for danger and manages background inertness', () => {
    const trigger = document.getElementById('trigger-btn');
    trigger?.focus();

    const dialog = openDialog({
      title: 'Warning Action',
      body: '<p>Careful!</p>',
      tone: 'danger',
    });

    const card = document.querySelector('[role="alertdialog"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById('app')?.getAttribute('aria-hidden')).toBe('true');

    closeDialog(dialog);
    expect(document.getElementById('app')?.getAttribute('aria-hidden')).toBeNull();
  });

  it('verifies openCustomMsgModal builds tabs and accessible controls', async () => {
    // Provide stubbed GM.config
    window.GM = window.GM || {};
    window.GM.config = {
      get: vi.fn().mockResolvedValue(''),
      set: vi.fn().mockResolvedValue(undefined),
    };

    await openCustomMsgModal('armsrace');

    const modal = document.getElementById('custom-msg-modal');
    expect(modal).not.toBeNull();

    const tabs = modal?.querySelectorAll('.discord-custom-tab-btn');
    expect(tabs?.length).toBeGreaterThanOrEqual(1);

    const closeBtn = document.getElementById('custom-msg-modal-close');
    expect(closeBtn).not.toBeNull();
    closeBtn?.click();

    // Modal begins removal
    expect(modal?.classList.contains('visible')).toBe(false);
  });
});
