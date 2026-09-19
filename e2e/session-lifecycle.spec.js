import { test, expect } from '@playwright/test';

// Regression & E2E coverage for session lifecycle and expiration:
// - Verifies that dispatching 'gm:session-expired' triggers doLogout()
// - Verifies that the UI resets to the login view and clears session markers

test.beforeEach(async ({ page }) => {
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  );
});

test('session-expired event triggers clean logout and reveals login container', async ({ page }) => {
  await page.goto('/');

  // Simulate active session state
  await page.evaluate(() => {
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_user', 'commander_alpha');
    sessionStorage.setItem('gm_account_id', 'acc-123');

    // Reveal admin container to simulate being logged in
    const loginWrap = document.getElementById('login-wrap') || document.querySelector('.login-container');
    if (loginWrap) loginWrap.classList.add('hidden');

    const adminDash = document.getElementById('admin-dashboard');
    if (adminDash) adminDash.classList.add('active');
  });

  // Dispatch session-expired event
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('gm:session-expired'));
  });

  // Verify that login view is restored
  const loginForm = page.locator('#login-form');
  await expect(loginForm).toBeVisible({ timeout: 5000 });

  // Verify storage was cleaned up
  const storageCleared = await page.evaluate(() => {
    return !localStorage.getItem('gm_user') && !sessionStorage.getItem('gm_account_id');
  });
  expect(storageCleared).toBe(true);
});
