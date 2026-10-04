// The login page after 2026-09-27: Discord is the way in.
//
// This file replaces `e2e/guild-request.spec.js`, which tested the public
// "Request a Guild" tab. That tab filed a request for a super_admin to approve
// by hand and then relay a generated password over Discord. Creating a guild now
// runs through Discord sign-in, which asks for the guild tag and the server
// number and provisions the guild on the spot.
//
// Two of the buttons that used to sit on this page were never wired to
// anything: "Sign in with a Passkey" and "Use a backup code instead". Both
// called `wirePasskeyLoginButton` / `openBackupCodeDialog`, which were exported
// onto the old global bridge and never invoked. They looked like features and
// did nothing when clicked, which is the exact failure mode finding M8
// describes. They are gone, and this file makes sure they do not come back
// without being wired.

import { test, expect } from '@playwright/test';

test('Discord is the one door; the password route is folded away', async ({ page }) => {
  await page.goto('/');

  const discord = page.locator('#login-discord-btn');
  await expect(discord).toBeVisible();
  await expect(discord).toContainText('Continue with Discord');

  // A first-time visitor sees one action, not two competing forms.
  await expect(page.locator('#username')).toBeHidden();
  await expect(page.locator('#login-legacy')).not.toHaveAttribute('open', '');

  // Unfolded, the identifier field sits BELOW the Discord button.
  await page.locator('#login-legacy > summary').click();
  await expect(page.locator('#username')).toBeVisible();
  const dBox = await discord.boundingBox();
  const uBox = await page.locator('#username').boundingBox();
  expect(dBox.y, 'the Discord button must sit above the identifier field').toBeLessThan(uBox.y);

  // And it must read as the primary action rather than a pale alternative.
  const bg = await discord.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg, 'the Discord button is unstyled: the blurple fill did not apply').not.toBe('rgba(0, 0, 0, 0)');
});

test('the page says the one button serves admins, players and newcomers', async ({ page }) => {
  await page.goto('/');
  const hint = page.locator('.gm-login-discord-hint');
  await expect(hint).toContainText('admins, players and newcomers');
  await expect(hint).toContainText('join your guild');
});

test('the password route opens by default for whoever used it last on this device', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('gm_last_signin_method', 'password');
  });
  await page.goto('/');
  await expect(page.locator('#username')).toBeVisible();
});

test('a Discord error lands beside the Discord button, not under the password field', async ({ page }) => {
  await page.goto('/?gm_auth_error=cancelled');
  const status = page.locator('#login-discord-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('cancelled');
  await expect(page.locator('#login-error')).toBeHidden();
  // The parameter is stripped so a reload does not replay it.
  await expect(page).toHaveURL(/\/$/);
});

test('the dead Passkey and backup-code buttons are gone, on both sign-in screens', async ({ page }) => {
  await page.goto('/');
  // The login page.
  await expect(page.locator('#login-passkey-btn')).toHaveCount(0);
  await expect(page.locator('#login-backup-code-btn')).toHaveCount(0);
  // And the player portal, which carried identical unwired copies.
  await expect(page.locator('#portal-passkey-btn')).toHaveCount(0);
  await expect(page.locator('#portal-backup-code-btn')).toHaveCount(0);
});

test('nothing in the app wires a passkey sign-in button any more', async ({ page }) => {
  // The helpers still exist on the bridge for whoever wires them properly one
  // day. What must not come back is a button that calls neither: that is what
  // made these look like working features for months.
  //
  // Scoped to `#login-view`, which holds both the admin sign-in card and the
  // player portal one. A whole-document scan also matched `add-passkey-btn`
  // and `regen-backup-codes-btn` in the "My Passkeys" card on Accounts &
  // Access: those ARE wired, and they are registration, not sign-in.
  await page.goto('/');
  const orphans = await page.evaluate(() => {
    const view = document.getElementById('login-view');
    if (!view) return ['#login-view is missing'];
    return Array.from(view.querySelectorAll('button'))
      .filter((b) => /passkey|backup code/i.test(b.textContent || ''))
      .map((b) => b.id || b.textContent.trim().slice(0, 40));
  });
  expect(orphans, `passkey/backup buttons still on a sign-in screen: ${orphans.join(', ')}`).toEqual([]);
});

test('nothing is left of the Request a Guild or Register Player tabs', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#auth-tab-guild-request')).toHaveCount(0);
  await expect(page.locator('#guild-request-form')).toHaveCount(0);
  await expect(page.locator('#auth-tab-register')).toHaveCount(0);
  await expect(page.locator('#register-form')).toHaveCount(0);
  // With one panel left there is no switcher either, so the login form is
  // the login screen.
  await expect(page.locator('.gm-auth-segmented-switch')).toHaveCount(0);
  await expect(page.locator('#login-form')).toBeVisible();
});

test('the Discord invite reads "Join our Discord"', async ({ page }) => {
  await page.goto('/');
  const cta = page.locator('a.gm-login-discord-btn[href*="discord.gg"]');
  await expect(cta).toBeVisible();
  await expect(cta).toContainText('Join our Discord');
  await expect(cta).toHaveAttribute('href', 'https://discord.gg/HJ47V6chbw');
  await expect(cta).not.toContainText('Want a guild space');
});

test('signing in with an identifier still works, as the secondary route', async ({ page }) => {
  await page.goto('/');
  await page.locator('#login-legacy > summary').click();
  await expect(page.locator('#username')).toBeVisible();
  await expect(page.locator('#password')).toBeVisible();
  await expect(page.locator('#login-btn')).toBeVisible();
  await expect(page.locator('#login-btn')).toContainText('Sign in');
  // Empty submit is refused by HTML validation, with no navigation.
  await page.locator('#login-btn').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#login-form')).toBeVisible();
});

test('an invite link shows the invitation banner and leaves no code in the URL', async ({ page }) => {
  await page.goto('/#join=FGF-ABCD-EFGH');
  const banner = page.locator('#login-invite-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('join code is already filled in');
  // Stripped from the address bar before anything else runs.
  expect(new URL(page.url()).hash).toBe('');
  // Parked for the onboarding wizard, in this tab only.
  const stored = await page.evaluate(() => sessionStorage.getItem('gm_pending_intent'));
  expect(JSON.parse(stored)).toMatchObject({ kind: 'join', code: 'FGF-ABCD-EFGH', fromLink: true });
});

test('a malformed invite link is dropped silently', async ({ page }) => {
  await page.goto('/#code=%3Cscript%3E');
  await expect(page.locator('#login-invite-banner')).toBeHidden();
  expect(new URL(page.url()).hash).toBe('');
});
