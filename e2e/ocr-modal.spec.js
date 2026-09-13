import { test, expect } from '@playwright/test';

// Regression coverage for commit 506078a: the OCR modal's Cancel button had
// zero JS wiring (only the X icon closed the modal). The typed bridge exposes
// openOcrModal() on window.GM_OCR with no login/backend dependency, so we
// bypass the dashboard boot entirely and open the modal directly, same bypass
// style as portal.spec.js's openPortal() helper.

function openMembersOcrModal(page) {
    return page.evaluate(() => window.GM_OCR.openOcrModal('members'));
}

test.beforeEach(async ({ page }) => {
    // Defensive net: setOcrMetric() awaits window.GM.getGuildTag(), which can
    // hit Supabase for a guild_config row. It already falls back safely on
    // any failure, but stub the REST surface anyway so this spec never
    // depends on a real backend, per the project's e2e convention.
    await page.route('**/rest/v1/**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    );
});

test('OCR modal Cancel button closes the modal', async ({ page }) => {
    await page.goto('/');
    await openMembersOcrModal(page);

    const overlay = page.locator('#ocr-modal-overlay');
    await expect(overlay).toBeVisible();

    await page.locator('#ocr-modal-cancel').click();
    await expect(overlay).toBeHidden();
});

test('OCR modal X button also closes the modal', async ({ page }) => {
    await page.goto('/');
    await openMembersOcrModal(page);

    const overlay = page.locator('#ocr-modal-overlay');
    await expect(overlay).toBeVisible();

    await page.locator('#ocr-modal-close').click();
    await expect(overlay).toBeHidden();
});
