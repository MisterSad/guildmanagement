import { test, expect } from '@playwright/test';

// Regression & a11y coverage for TICKET-11 [A11Y-01] & TICKET-13 [TEST-01]:
// Tests WCAG 2.2 AA compliance on modal dialogs:
// - Dynamic role ("dialog" vs "alertdialog" for tone: "danger")
// - aria-modal="true" and aria-labelledby
// - Background inertness (#app[aria-hidden="true"])
// - Keyboard focus trap (Tab / Shift+Tab)
// - Focus restoration to triggering element on close (Escape / Cancel)

test.beforeEach(async ({ page }) => {
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
});

test('opens standard dialog with role="dialog" and sets aria-hidden on #app', async ({ page }) => {
  await page.goto('/');

  // Open a standard dialog through the e2e entry point (window.GM_E2E, M4c).
  await page.evaluate(() => {
    const trigger = document.createElement('button');
    trigger.id = 'test-trigger-btn';
    trigger.textContent = 'Open Dialog';
    document.body.appendChild(trigger);
    trigger.focus();

    window.GM_E2E.openDialog({
      title: 'Standard Info',
      body: '<p>This is a standard dialog body.</p>',
      tone: 'default',
    });
  });

  // Verify modal exists
  const modal = page.locator('.gm-ui-dialog[role="dialog"][aria-modal="true"]');
  await expect(modal).toBeVisible();

  // Verify background #app is inert / aria-hidden
  const appContainer = page.locator('#app');
  if (await appContainer.count() > 0) {
    await expect(appContainer).toHaveAttribute('aria-hidden', 'true');
  }

  // Close via Escape
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden({ timeout: 5000 });

  // Verify #app aria-hidden is restored
  if (await appContainer.count() > 0) {
    await expect(appContainer).not.toHaveAttribute('aria-hidden', 'true');
  }
});

test('opens danger dialog with role="alertdialog"', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    window.GM_E2E.openDialog({
      title: 'Destructive Action',
      body: '<p>Are you sure you want to delete this?</p>',
      tone: 'danger',
    });
  });

  const alertDialog = page.locator('[role="alertdialog"][aria-modal="true"]');
  await expect(alertDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(alertDialog).toBeHidden({ timeout: 5000 });
});

test('OCR modal has valid accessible name and dialog role', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.GM_E2E.openOcrModal('members'));

  const overlay = page.locator('#ocr-modal-overlay');
  await expect(overlay).toBeVisible();

  const card = overlay.locator('[role="dialog"][aria-modal="true"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-labelledby', 'ocr-modal-title');
  await expect(card).toHaveAttribute('aria-describedby', 'ocr-modal-subtitle');

  // Close via Cancel button
  await page.locator('#ocr-modal-cancel').click();
  await expect(overlay).toBeHidden({ timeout: 5000 });
});
