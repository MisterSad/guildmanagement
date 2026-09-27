// The super_admin's recovery codes, finally reachable.
//
// The owner held ten valid backup codes he could not spend. Both halves of the
// mechanism existed and were correct:
//
//   * `auth-discord` action `backup-login` — Zod-validated, throttled,
//     super_admin only, lockout-aware, consumes the code, mints a session.
//   * `loginWithBackupCodeDiscord()` in `session.ts`, exported and bridged.
//
// What was missing was any way to reach them. The login page's old "Use a
// backup code instead" button called `openBackupCodeDialog()`, which is
// exported onto the window.GM bridge and never invoked, so it did nothing when
// clicked. It was removed on 2026-09-27 as dead markup, which made the gap
// visible rather than creating it.
//
// This file pins the entry point, and the two properties that make it safe to
// have one at all.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const ctrl = read('src/modules/app/auth/auth.controller.ts');
const fn = read('supabase/functions/auth-discord/index.ts');

describe('the recovery code is reachable from the login page', () => {
  it('has a link, and the link is actually wired', () => {
    // Wiring is the whole point. The previous button was markup with no
    // listener, which looks identical to a working feature until you click it.
    expect(read('index.html')).toContain('id="login-recovery-btn"');
    expect(ctrl).toMatch(/wireOnce\(el\('login-recovery-btn'\)[^)]*\)[^;]*openRecoveryCodeDialog\(\)/s);
  });

  it('opens a dialog that is VISIBLE', () => {
    // `.gm-modal-overlay` is opacity 0 until the `visible` class lands. The
    // account chooser shipped without this and was invisible for a day.
    const dlg = ctrl.slice(ctrl.indexOf('export function openRecoveryCodeDialog'));
    const body = dlg.slice(0, dlg.indexOf('\ninterface DiscordAccountChoice'));
    expect(body.length, 'openRecoveryCodeDialog not found').toBeGreaterThan(500);
    expect(body).toMatch(/classList\.add\('visible'\)/);
    expect(body).toMatch(/requestAnimationFrame/);
  });

  it('calls the Discord recovery path, not the passkey one', () => {
    // `loginWithBackupCode` goes through auth-passkey, which phase D7 removes.
    // `loginWithBackupCodeDiscord` goes through auth-discord and survives.
    const dlg = ctrl.slice(ctrl.indexOf('export function openRecoveryCodeDialog'));
    const body = dlg.slice(0, dlg.indexOf('\ninterface DiscordAccountChoice'));
    expect(body).toMatch(/loginWithBackupCodeDiscord/);
    expect(read('src/core/gm-bridge.ts')).toContain('loginWithBackupCodeDiscord');
  });

  it('can be dismissed', () => {
    const dlg = ctrl.slice(ctrl.indexOf('export function openRecoveryCodeDialog'));
    expect(dlg.slice(0, 4000)).toMatch(/recovery-cancel/);
  });

  it('tells the owner how many codes are left', () => {
    // Ten one-time codes and no warning when they run low is how someone ends
    // up locked out holding an empty envelope.
    const dlg = ctrl.slice(ctrl.indexOf('export function openRecoveryCodeDialog'));
    expect(dlg.slice(0, 5000)).toMatch(/backupCodesRemaining/);
    expect(dlg.slice(0, 5000)).toMatch(/last recovery code/);
  });
});

describe('the recovery path does not leak who exists', () => {
  it('answers the same for a wrong code, an unknown account and a non-owner', () => {
    // Three different refusals all return `invalid_code`. Distinguishing them
    // would turn this endpoint into an account-enumeration oracle, and it is
    // reachable without any authentication at all.
    const handler = fn.slice(fn.indexOf('async function handleBackupLogin'));
    const body = handler.slice(0, handler.indexOf('\n}\n'));
    expect(body).toMatch(/acc\.role !== "super_admin"/);
    // The unknown / not-active / not-super_admin branch and the bad-code branch
    // must both answer invalid_code.
    expect((body.match(/error: "invalid_code"/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('is restricted to the super_admin, and says why', () => {
    // Every other account has an administrator above it who can unlink and
    // reissue a relink code, which is stronger because it needs a second human.
    expect(fn).toMatch(/acc\.role !== "super_admin"/);
    expect(read('src/core/auth/session.ts')).toMatch(/super_admin has nobody above them/i);
  });

  it('is rate limited and respects an account lockout', () => {
    const handler = fn.slice(fn.indexOf('async function handleBackupLogin'));
    const body = handler.slice(0, handler.indexOf('\n}\n'));
    expect(body).toMatch(/throttled\(req, admin, logger, "backup-login"\)/);
    expect(body).toMatch(/locked_until/);
  });

  it('consumes the code, so it cannot be replayed', () => {
    const handler = fn.slice(fn.indexOf('async function handleBackupLogin'));
    expect(handler.slice(0, 3000)).toMatch(/verifyAndConsumeBackupCode/);
  });
});
