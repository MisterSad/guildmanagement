/**
 * tests/app_cutover.test.js
 *
 * Final Strangler cutover guards: the legacy `app.js` monolith must be gone
 * from disk and from `index.html`, and the runtime must be driven by the typed
 * /src modules, which import each other directly. The GM_* window bridge
 * src/main.ts used to assemble is gone (M4c); only the frozen GM_E2E remains.
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
    // Phase 7: the router calls its loaders by reference. The signal is also
    // passed in the shape fetchGuildMembers actually accepts -- it used to be
    // handed the bare AbortSignal as the options object, so `opts.signal` was
    // always undefined and the abort was never wired to anything.
    expect(router).toContain('fetchGuildMembers({ signal })');
    expect(router).toContain('fetchAccounts()');
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

  // Comments are stripped: main.ts documents the bridges it no longer installs.
  const mainCode = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('wires the OCR modal by import, not through window globals', () => {
    expect(main).toContain("import { openOcrModal");
    expect(main).toContain('openOcrModal(metric)');
    expect(mainCode).not.toMatch(/window\.(openOcrModal|closeOcrModal)\s*=/);
    expect(mainCode).not.toMatch(/\bwAny\b/);
  });

  it('installs no GM_* domain bridge, only the frozen GM_E2E', () => {
    ['GM_AUTH', 'GM_ROUTER', 'GM_ADMIN', 'GM_MEMBERS', 'GM_OCR'].forEach((bridge) => {
      expect(mainCode).not.toContain(bridge);
    });
    expect(mainCode).toContain("Object.defineProperty(window, 'GM_E2E'");
    expect(mainCode).toContain('Object.freeze(');
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

  it('no longer carries the My Passkeys admin card, which was removed', () => {
    // The card was re-homed under /src during the cutover, and removed on
    // 2026-09-27. It let people REGISTER passkeys that could not be used to
    // sign in anywhere: both sign-in buttons called `wirePasskeyLoginButton()`
    // and `openBackupCodeDialog()`, which were exported onto the (since
    // removed) window bridge and were never invoked. The card, its mount, its router loader and
    // its bridge entries went together, so nothing is left to find nothing.
    //
    // Comments are stripped first. The code left behind NAMES the removed
    // functions while explaining why they went, and an absence check over the
    // raw text reads correct documentation as a regression. This has now caught
    // seven separate suites in this repository; strip, then assert.
    const strip = (t) =>
      t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

    const accountsCtrl = strip(read('src/modules/app/admin/accounts.controller.ts'));
    const router = strip(read('src/modules/app/router.ts'));
    expect(strip(main)).not.toContain('loadMyPasskeysCard');
    expect(accountsCtrl).not.toContain("byId('my-passkeys-list')");
    expect(accountsCtrl).not.toContain('mountMyPasskeysCard');
    expect(router).not.toContain('loadMyPasskeysCard');
    expect(strip(read('index.html'))).not.toContain('id="my-passkeys-card"');
    // The portal carried an identical panel; it went too.
    expect(strip(read('src/modules/portal/views/PortalView.ts')))
      .not.toContain("document.getElementById('portal-passkeys-list')");
  });
});
