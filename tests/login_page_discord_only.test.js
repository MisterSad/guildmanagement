// The login page has one door: Discord.
//
// "Register Player" created a password account, which the claim flow would then
// have had to migrate -- onboarding that manufactured its own debt. It is gone,
// along with the "Request a Guild" form and the segmented switcher that had one
// segment left. What remains must actually let a new player in, which is the
// second half of what is asserted here.
//
// Every assertion strips comments first. Seven suites in this repository have
// been fooled by prose that named the very thing it said was removed.

import { describe, it, expect } from 'vitest';
import { appHtml } from './helpers/app-html.js';
import { squash } from './helpers/source-text.js';
import fs from 'node:fs';
import path from 'node:path';
import { edgeSource } from './helpers/edge-source.js';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

const html = stripHtml(appHtml());
const controller = stripJs(read('src/modules/app/auth/auth.controller.ts'));
const main = stripJs(read('src/main.ts'));

describe('the password-account sign-up is gone from the markup', () => {
  it('has no Register Player tab, form or field', () => {
    for (const id of [
      'auth-tab-register',
      'register-form',
      'register-id',
      'register-password',
      'register-uid',
      'register-code',
      'register-back-btn',
      'register-error',
      'go-to-register-btn',
      'portal-go-register-btn',
    ]) {
      expect(html, `#${id} is still in index.html`).not.toContain(`id="${id}"`);
    }
  });

  it('has no Request a Guild form either', () => {
    for (const id of ['auth-tab-guild-request', 'guild-request-form', 'guild-request-tag']) {
      expect(html, `#${id} is still in index.html`).not.toContain(`id="${id}"`);
    }
  });

  it('drops the switcher rather than leaving it with one segment', () => {
    expect(html).not.toContain('gm-auth-segmented-switch');
    expect(html).not.toContain('id="auth-tab-signin"');
  });
});

describe('the handlers went with the markup', () => {
  it('no longer defines the panel switcher or the two submit handlers', () => {
    for (const symbol of [
      'export function showAuthTab',
      'export function showRegisterForm',
      'async function onRegisterSubmit',
      'async function onGuildRequestSubmit',
      'REGISTER_ERRORS',
      'GUILD_REQUEST_ERRORS',
    ]) {
      expect(controller, `${symbol} survives with nothing to drive it`).not.toContain(symbol);
    }
  });

  it('wires no element that index.html no longer contains', () => {
    for (const id of [
      'register-form',
      'auth-tab-register',
      'auth-tab-signin',
      'auth-tab-guild-request',
      'go-to-register-btn',
      'register-back-btn',
      'guild-request-form',
      'guild-request-back-btn',
    ]) {
      expect(controller, `still wiring #${id}`).not.toContain(`el('${id}')`);
    }
  });

  it('stops exporting them on the GM_AUTH bridge', () => {
    // A bridge member no caller can reach is the M8 class of dead export.
    const bridge = main.slice(main.indexOf('wAny.GM_AUTH = {'), main.indexOf('};', main.indexOf('wAny.GM_AUTH = {')));
    expect(bridge).not.toContain('showAuthTab');
    expect(bridge).not.toContain('showRegisterForm');
  });

  it('keeps the login form itself wired', () => {
    expect(controller).toContain("wireOnce(el('login-form')");
    expect(controller).toContain('async function onLoginSubmit');
  });
});

describe('a new player still has a way in', () => {
  it('leads with Discord sign-in', () => {
    expect(html).toContain('id="login-discord-btn"');
    expect(controller).toContain("wireOnce(el('login-discord-btn')");
  });

  it('offers the join-code path once signed in with Discord', () => {
    // Removing the tab would strand every new player if this path were not
    // live. It resolves the guild from the join code and requires the in-game
    // UID, exactly as the old form did, minus the password.
    const fn = stripJs(edgeSource('auth-discord'));
    expect(fn).toContain('gm_discord_join_guild');
    expect(fn).toContain('p_join_code: parsed.data.join_code');
    expect(fn).toContain('p_uid: parsed.data.uid');
  });

  it('points the invitation button at the current server', () => {
    const invites = [...appHtml().matchAll(/https:\/\/discord\.gg\/([A-Za-z0-9]+)/g)].map((m) => m[1]);
    expect(invites).toEqual(['HJ47V6chbw']);
  });
});

describe('the one-door login page (2026-10-02)', () => {
  it('folds the password route behind a summary', () => {
    const legacy = html.slice(html.indexOf('<details id="login-legacy"'), html.indexOf('</details>'));
    for (const id of ['username', 'password', 'login-btn', 'login-error', 'login-recovery-btn']) {
      expect(legacy, `#${id} must live inside #login-legacy`).toContain(`id="${id}"`);
    }
    expect(html.indexOf('id="login-discord-btn"')).toBeLessThan(html.indexOf('<details id="login-legacy"'));
  });

  it('routes every Discord outcome to the status area beside the button', () => {
    expect(html).toMatch(/id="login-discord-status"[^>]*aria-live="polite"/);
    const callback = controller.slice(
      controller.indexOf('export async function handleDiscordCallback'),
      controller.indexOf('\n}\n', controller.indexOf('export async function handleDiscordCallback'))
    );
    expect(callback).toContain('setDiscordStatus(');
    expect(callback).not.toContain('setLoginError(');
  });

  it('shows a busy state while a ticket is redeemed, and always clears it', () => {
    const callback = controller.slice(controller.indexOf('export async function handleDiscordCallback'));
    expect(callback.indexOf('setLoginBusy(true)')).toBeLessThan(callback.indexOf('redeemDiscordTicket('));
    expect(callback).toMatch(/finally \{\s*setLoginBusy\(false\);/);
  });

  it('gives the Discord button feedback and restores it after a Back navigation', () => {
    expect(squash(controller)).toContain(
      squash("wireOnce(el('login-discord-btn'), '__gmAuthWired', 'click', () => { startDiscordSignIn(); })")
    );
    expect(controller).toContain("'Opening Discord…'");
    expect(controller).toMatch(/addEventListener\('pageshow'[\s\S]{0,80}resetDiscordButton\(\)/);
  });

  it('remembers the last route in a try/catch-guarded localStorage key', () => {
    expect(controller).toMatch(/function rememberSignInMethod[\s\S]{0,120}try \{/);
    expect(controller).toMatch(/function lastSignInMethod[\s\S]{0,120}try \{/);
  });

  it('drops the portal password step and the unwired member logout button', () => {
    for (const id of ['portal-step-lookup', 'portal-id', 'portal-password', 'portal-lookup-btn', 'member-logout-btn']) {
      expect(html, `#${id} is dead markup`).not.toContain(`id="${id}"`);
    }
    expect(controller).not.toContain("el('member-logout-btn')");
    expect(fs.existsSync(path.join(rootDir, 'src/modules/app/auth/portal.controller.ts'))).toBe(false);
  });

  it('brings the login page back when signing out of the portal', () => {
    const show = controller.slice(
      controller.indexOf('export function showLogin'),
      controller.indexOf('export function startConditionalPasskeyListener')
    );
    expect(show).toContain("el('player-portal-view')");
    const portal = stripJs(read('src/modules/portal/views/PortalView.ts'));
    expect(squash(portal)).toContain(squash("signOutBtn.addEventListener('click', () => { exitPortalToLogin(); })"));
  });
});

describe('shared invite links (2026-10-02)', () => {
  it('captures the fragment before the Discord callback and the session restore', () => {
    const boot = main.slice(main.indexOf('captureIntentFromHash();'));
    expect(boot.indexOf('captureIntentFromHash();')).toBeLessThan(boot.indexOf('handleDiscordCallback()'));
    expect(boot).toContain('applyLinkIntentAtBoot(!!(res && res.restored))');
  });

  it('lets admins copy a fragment link for join, invite and relink codes', () => {
    const ctrl = stripJs(read('src/modules/app/admin/accounts.controller.ts'));
    const render = stripJs(read('src/modules/app/admin/accounts.render.ts'));
    expect(html).toContain('id="join-link-copy-btn"');
    expect(ctrl).toContain("copyInviteLink('join', currentCode)");
    expect(ctrl).toContain("copyInviteLink('code', res.invite_code)");
    expect(render).toContain("buildInviteLink(window.location.origin, 'code', res.relink_code)");
  });
});
