import { test, expect } from '@playwright/test';

// Public "Request a Guild" tab on the login page. No login/backend calls
// happen until submit, so we only stub the guild-request Edge Function
// itself, same page.route() convention as portal.spec.js/ocr-modal.spec.js.

function stubGuildRequest(page, reply) {
    return page.route('**/functions/v1/guild-request', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) });
    });
}

test('Request a Guild tab is reachable from the login segmented switcher', async ({ page }) => {
    await page.goto('/');
    await page.locator('#auth-tab-guild-request').click();
    await expect(page.locator('#guild-request-form')).toBeVisible();
    await expect(page.locator('#login-form')).toBeHidden();
    await expect(page.locator('#register-form')).toBeHidden();
});

test('can navigate back to sign in from the guild request tab', async ({ page }) => {
    await page.goto('/');
    await page.locator('#auth-tab-guild-request').click();
    await page.locator('#guild-request-back-btn').click();
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#guild-request-form')).toBeHidden();
});

test('submitting a valid request shows the success message', async ({ page }) => {
    await stubGuildRequest(page, { ok: true });
    await page.goto('/');
    await page.locator('#auth-tab-guild-request').click();

    await page.locator('#guild-request-tag').fill('SIGMA');
    await page.locator('#guild-request-server').fill('1089');
    await page.locator('#guild-request-admin-id').fill('sigma_admin');
    await page.locator('#guild-request-discord').fill('sigmaleader#1234');

    await page.locator('#guild-request-form button[type="submit"]').click();

    await expect(page.locator('#guild-request-success')).toBeVisible();
    await expect(page.locator('#guild-request-error')).toBeHidden();
});

test('a rejected request (e.g. duplicate tag) shows the specific error', async ({ page }) => {
    await stubGuildRequest(page, { ok: false, error: 'tag_taken' });
    await page.goto('/');
    await page.locator('#auth-tab-guild-request').click();

    await page.locator('#guild-request-tag').fill('OMEGA');
    await page.locator('#guild-request-server').fill('1058');
    await page.locator('#guild-request-admin-id').fill('omega_admin');
    await page.locator('#guild-request-discord').fill('someone#0001');

    await page.locator('#guild-request-form button[type="submit"]').click();

    await expect(page.locator('#guild-request-error')).toBeVisible();
    await expect(page.locator('#guild-request-error')).toContainText('already taken');
    await expect(page.locator('#guild-request-success')).toBeHidden();
});
