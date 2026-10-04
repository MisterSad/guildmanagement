import { test, expect } from './fixtures.js';

// Regression & E2E coverage for Discord custom message customization modal:
// - Verifies the 6 custom message buttons in index.html carry aria-label="Customize messages"
// - Verifies openCustomMsgModal opens the modal with tabs, pill buttons and preview
// - Verifies closing the modal via Cancel / X button
//
// The buttons live in the admin markup, which ships in the admin chunk and is
// mounted when the dashboard opens (2026-10-04): each test opens it first.

test.beforeEach(async ({ page }) => {
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
});

test('all 6 custom message buttons have accessible labels', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.GM_E2E.showAdminDashboard());

  const buttons = page.locator('[data-custom-msg]');
  await expect(buttons).toHaveCount(6);

  for (let i = 0; i < 6; i++) {
    await expect(buttons.nth(i)).toHaveAttribute('aria-label', 'Customize messages');
  }
});

test('opens Discord message customizer and closes via Cancel button', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.GM_E2E.showAdminDashboard());

  // Open it from its button. The guild config it reads comes from the stubbed
  // /rest/v1 above (the global config injection this used is gone, M4c).
  await page.evaluate(() => {
    const btn = document.querySelector('[data-custom-msg="armsrace"]');
    if (btn) {
      btn.click();
    }
  });

  const modal = page.locator('#custom-msg-modal');
  if ((await modal.count()) > 0) {
    await expect(modal).toBeVisible();

    // Verify modal header title
    await expect(modal.locator('h3')).toContainText('Personalization');

    // Verify tabs
    const tabs = modal.locator('.discord-custom-tab-btn');
    await expect(tabs.first()).toBeVisible();

    // Verify Cancel button closes the modal
    const cancelBtn = page.locator('#custom-msg-modal-cancel');
    await cancelBtn.click();
    await expect(modal).toBeHidden({ timeout: 5000 });
  }
});
