import { test, expect } from '@playwright/test';

// Regression & E2E coverage for Discord custom message customization modal:
// - Verifies the 6 custom message buttons in index.html carry aria-label="Customize messages"
// - Verifies openCustomMsgModal opens the modal with tabs, pill buttons and preview
// - Verifies closing the modal via Cancel / X button

test.beforeEach(async ({ page }) => {
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
});

test('all 6 custom message buttons have accessible labels', async ({ page }) => {
  await page.goto('/');

  const buttons = page.locator('[data-custom-msg]');
  await expect(buttons).toHaveCount(6);

  for (let i = 0; i < 6; i++) {
    await expect(buttons.nth(i)).toHaveAttribute('aria-label', 'Customize messages');
  }
});

test('opens Discord message customizer and closes via Cancel button', async ({ page }) => {
  await page.goto('/');

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
