/**
 * The Discord onboarding wizard, driven in jsdom with the network mocked.
 *
 * What it must do for a person who just signed in with an unlinked Discord
 * account: let them pick who they are, keep what they typed when the server
 * says a field is wrong (and swap in the fresh ticket it returned), offer a
 * Discord restart when the ticket is gone, and resume from a pending intent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// M4c: the controller imports the Discord session calls; they are mocked at
// their module rather than stubbed on session.
const session = vi.hoisted(() => ({
  onboardWithDiscord: vi.fn(),
  claimWithDiscord: vi.fn(),
  redeemLinkCode: vi.fn(),
  loginWithDiscord: vi.fn(),
}));
vi.mock('../src/core/auth/session', async (importOriginal) => ({ ...(await importOriginal()), ...session }));

vi.mock('../src/modules/portal/views/PortalView', () => ({
  portalView: { loadDashboard: vi.fn(), renderDashboard: vi.fn() }
}));

import { openLinkAccountDialog, showPendingScreen, initAuthForms } from '../src/modules/app/auth/auth.controller';
import { peekPendingIntent, savePendingIntent } from '../src/core/auth/pending-intent';
import { resetAppState } from '../src/core/state/app-state';

const LOGIN_DOM = `
  <div id="login-view">
    <div class="gm-login-form">
      <div id="login-invite-banner" class="hidden"></div>
      <button id="login-discord-btn"><i></i><span>Continue with Discord</span></button>
      <p class="gm-login-discord-hint"></p>
      <div id="login-discord-status" class="hidden"><i></i><span></span></div>
      <div id="login-busy" class="hidden"></div>
      <div id="login-pending" class="hidden">
        <p id="login-pending-text"></p>
        <button id="login-pending-back"><span>Back</span></button>
      </div>
      <details id="login-legacy"><summary>legacy</summary></details>
    </div>
  </div>
  <div id="toast-container"></div>
`;

const $ = (id) => document.getElementById(id);
const click = (node) => node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const type = (id, value) => { $(id).value = value; };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = LOGIN_DOM;
  resetAppState();
  Object.values(session).forEach((fn) => fn.mockReset());
});

describe('step 1: who are you?', () => {
  it('greets by Discord display name and offers three described choices', () => {
    openLinkAccountDialog('T1'.padEnd(20, 'x'), 'hawk', 'HawkEye');
    expect($('discord-link-title').textContent).toBe('Welcome, HawkEye');
    const cards = document.querySelectorAll('.gm-onboard-card');
    expect(cards).toHaveLength(3);
    expect($('discord-link-submit').classList.contains('hidden')).toBe(true);
  });

  it('escapes the names it renders', () => {
    openLinkAccountDialog('T1'.padEnd(20, 'x'), '<img src=x>', '<b>x</b>');
    expect(document.querySelector('#discord-link-overlay img')).toBeNull();
    expect(document.querySelector('#discord-link-title b')).toBeNull();
  });

  it('opens the matching form with a Back button', () => {
    openLinkAccountDialog('T1'.padEnd(20, 'x'), 'hawk');
    click(document.querySelector('[data-choice="join"]'));
    expect($('path-join').classList.contains('hidden')).toBe(false);
    expect($('discord-link-back').classList.contains('hidden')).toBe(false);
    expect($('discord-link-submit').textContent).toBe('Request access');
    click($('discord-link-back'));
    expect($('discord-link-step-choose').classList.contains('hidden')).toBe(false);
  });

  it('keeps claim and code under one "I already have an account" choice', () => {
    openLinkAccountDialog('T1'.padEnd(20, 'x'), 'hawk');
    click(document.querySelector('[data-choice="existing"]'));
    expect($('path-claim').classList.contains('hidden')).toBe(false);
    click(document.querySelector('[data-tab="code"]'));
    expect($('path-code').classList.contains('hidden')).toBe(false);
    expect($('path-claim').classList.contains('hidden')).toBe(true);
    expect($('discord-link-submit').textContent).toBe('Redeem code');
  });
});

describe('step 2: correcting a mistake', () => {
  it('refuses an empty or malformed field locally, without spending an attempt', async () => {
    openLinkAccountDialog('T1'.padEnd(20, 'x'), 'hawk');
    click(document.querySelector('[data-choice="join"]'));
    type('discord-join-code', 'FGF-AAAA-BBBB');
    type('discord-join-uid', '12ab');
    click($('discord-link-submit'));
    await flush();
    expect(session.onboardWithDiscord).not.toHaveBeenCalled();
    expect($('discord-join-uid-error').classList.contains('hidden')).toBe(false);
  });

  it('shows a recoverable error under its field and retries with the FRESH ticket', async () => {
    const first = 'FIRST'.padEnd(20, 'x');
    const second = 'SECOND'.padEnd(20, 'x');
    session.onboardWithDiscord
      .mockResolvedValueOnce({ ok: false, error: 'uid_not_in_guild', ticket: second, attemptsLeft: 2 })
      .mockResolvedValueOnce({ ok: true, state: 'pending_approval', guild: 'SIGMA', id: 'hawk' });

    openLinkAccountDialog(first, 'hawk');
    click(document.querySelector('[data-choice="join"]'));
    type('discord-join-code', 'FGF-AAAA-BBBB');
    type('discord-join-uid', '123');
    click($('discord-link-submit'));
    await flush(); await flush();

    expect($('discord-join-uid-error').textContent).toContain('not on the guild roster');
    expect($('discord-join-uid-error').textContent).toContain('2 attempts left');
    expect($('discord-join-uid').getAttribute('aria-invalid')).toBe('true');
    // The form is still filled in.
    expect($('discord-join-code').value).toBe('FGF-AAAA-BBBB');

    type('discord-join-uid', '456');
    click($('discord-link-submit'));
    await flush(); await flush();

    expect(session.onboardWithDiscord.mock.calls[0][0]).toBe(first);
    expect(session.onboardWithDiscord.mock.calls[1][0]).toBe(second);
    // Pending join: a screen of its own, not an error line.
    expect($('login-pending').classList.contains('hidden')).toBe(false);
    expect($('login-pending-text').textContent).toContain('SIGMA');
  });

  it('offers "Restart with Discord" when the ticket is spent, and carries the non-secret fields', async () => {
    session.claimWithDiscord.mockResolvedValueOnce({ ok: false, error: 'invalid_credentials' });

    openLinkAccountDialog('T1'.padEnd(20, 'x'), 'hawk');
    click(document.querySelector('[data-choice="existing"]'));
    type('discord-link-id', 'Hawk');
    type('discord-link-password', 'hunter2');
    click($('discord-link-submit'));
    await flush(); await flush();

    expect($('discord-link-restart').classList.contains('hidden')).toBe(false);
    expect($('discord-link-submit').classList.contains('hidden')).toBe(true);

    click($('discord-link-restart'));
    const intent = peekPendingIntent();
    expect(intent).toMatchObject({ kind: 'claim', accountId: 'Hawk' });
    // Never the password.
    expect(JSON.stringify(sessionStorage)).not.toContain('hunter2');
    expect(session.loginWithDiscord).toHaveBeenCalled();
  });
});

describe('resuming', () => {
  it('reopens on the saved path with its fields pre-filled', () => {
    savePendingIntent({ kind: 'join', code: 'FGF-AAAA-BBBB', uid: '123' });
    openLinkAccountDialog('T1'.padEnd(20, 'x'), 'hawk');
    expect($('path-join').classList.contains('hidden')).toBe(false);
    expect($('discord-join-code').value).toBe('FGF-AAAA-BBBB');
    expect($('discord-join-uid').value).toBe('123');
  });
});

describe('closing', () => {
  it('ignores backdrop clicks, and asks before discarding typed input', () => {
    openLinkAccountDialog('T1'.padEnd(20, 'x'), 'hawk');
    const overlay = $('discord-link-overlay');
    click(overlay);
    expect(overlay.classList.contains('visible') || document.body.contains(overlay)).toBe(true);

    click(document.querySelector('[data-choice="create"]'));
    type('discord-create-tag', 'SIGMA');
    click($('discord-link-cancel'));
    expect($('discord-link-cancel').textContent).toBe('Discard and close?');
    click($('discord-link-cancel'));
    expect($('login-discord-status').textContent).toContain('Sign-in cancelled');
  });
});

describe('the waiting screen', () => {
  it('replaces the sign-in controls and comes back on demand', () => {
    initAuthForms();
    showPendingScreen('SIGMA', 'hawk');
    expect($('login-discord-btn').classList.contains('hidden')).toBe(true);
    click($('login-pending-back'));
    expect($('login-pending').classList.contains('hidden')).toBe(true);
    expect($('login-discord-btn').classList.contains('hidden')).toBe(false);
  });
});
