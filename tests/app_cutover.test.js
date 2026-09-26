/**
 * tests/app_cutover.test.js
 *
 * Final Strangler cutover guards: the legacy `app.js` monolith must be gone
 * from disk and from `index.html`, and the runtime must be driven by the typed
 * /src modules through the window.GM_* bridge assembled in src/main.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');
const exists = (p) => fs.existsSync(path.resolve(root, p));

describe('Final cutover: app.js removed', () => {
  it('app.js no longer exists at the repository root', () => {
    expect(exists('app.js')).toBe(false);
  });

  it('index.html no longer loads app.js', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/<script[^>]*src=["'][^"']*app\.js/);
    expect(html).not.toContain('app.js?v=');
  });

  it('the router no longer has a legacyTabLoader fallback', () => {
    const router = read('src/modules/app/router.ts');
    expect(router).not.toContain('legacyTabLoader');
    expect(router).not.toContain('setLegacyTabLoader');
    expect(router).toContain("invokeMethod('GM_MEMBERS', 'fetchGuildMembers', signal)");
    expect(router).toContain("invokeMethod('GM_ADMIN', 'fetchAccounts')");
  });

  it('the router cancels/dedupes in-flight tab loads via AbortController (P3-03)', () => {
    const router = read('src/modules/app/router.ts');
    expect(router).toContain('new AbortController()');
    expect(router).toContain('activeLoadController.abort()');
    expect(router).toContain('signal');
  });
});

describe('Final cutover: src/main.ts bootstrap', () => {
  const main = read('src/main.ts');

  it('runs the full DOMContentLoaded init order', () => {
    const start = main.indexOf("document.addEventListener('DOMContentLoaded'");
    expect(start).toBeGreaterThan(-1);
    const boot = main.slice(start);
    const order = [
      'runGmBootstrap()',
      'initAuthForms()',
      'initTabNavigation()',
      'initAccountsUi()',
      'initGuildRequestsUi()',
      'initOcrDropdown()',
      'initTimezoneCollapsible()',
      'initVersionCheck()',
      'initNetworkStatusMonitoring()',
      'shellView.init()',
      'helpView.init()',
      'sanctionsView.init()',
      'applyTranslations()',
      'restoreSession()'
    ];
    let cursor = -1;
    for (const call of order) {
      const idx = boot.indexOf(call);
      expect(idx, `${call} must be present`).toBeGreaterThan(-1);
      expect(idx, `${call} must run after the previous init`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it('assigns the OCR modal bridges directly', () => {
    expect(main).toContain('wAny.openOcrModal =');
    expect(main).toContain('wAny.closeOcrModal =');
    expect(main).toContain('openOcrModal(metric)');
  });

  it('exposes the typed GM_* domain bridges', () => {
    ['GM_AUTH', 'GM_ROUTER', 'GM_ADMIN', 'GM_MEMBERS', 'GM_OCR'].forEach((bridge) => {
      expect(main).toContain('wAny.' + bridge + ' =');
    });
  });

  it('delegates OCR trigger clicks (former app.js document handler)', () => {
    expect(main).toContain("closest('.btn-ocr-trigger')");
    expect(main).toContain('openOcrModal(metric)');
  });

  it('restores the saved tab only after a successful session restore', () => {
    expect(main).toMatch(/restoreSession\(\)\.then\([\s\S]*?restoreSavedTab\(\)/);
  });
});

describe('Final cutover: residual app.js wiring re-homed under /src', () => {
  const main = read('src/main.ts');

  it('wires the Members/Banned tab controls that app.js owned', () => {
    expect(main).toContain('initMembersUi()');
    expect(main).toContain('initBannedUi()');
    const membersCtrl = read('src/modules/app/members/members.controller.ts');
    expect(membersCtrl).toContain("byId<HTMLFormElement>('add-member-form')");
    expect(membersCtrl).toContain("byId<HTMLInputElement>('member-search-admin')");
    expect(membersCtrl).toContain("byId<HTMLSelectElement>('member-sort-admin')");
    const bannedCtrl = read('src/modules/app/members/banned.controller.ts');
    expect(bannedCtrl).toContain("byId<HTMLFormElement>('add-banned-form')");
    expect(bannedCtrl).toContain("byId<HTMLInputElement>('banned-search')");
  });

  it('renders the temporary/invalid UID badge with click-to-filter', () => {
    const render = read('src/modules/app/members/members.render.ts');
    expect(render).toContain("byId('guild-member-temp-uid-badge')");
    expect(render).toContain("tierSelect.value = tierSelect.value === 'TEMP_UID' ? 'ALL' : 'TEMP_UID'");
  });

  it('re-homes the My Passkeys admin card', () => {
    expect(main).toContain('loadMyPasskeysCard');
    const accountsCtrl = read('src/modules/app/admin/accounts.controller.ts');
    expect(accountsCtrl).toContain('mountPasskeysPanel');
    expect(accountsCtrl).toContain("byId('my-passkeys-list')");
    const router = read('src/modules/app/router.ts');
    expect(router).toContain("invokeMethod('GM_ADMIN', 'loadMyPasskeysCard')");
  });
});
