import { test, expect } from '@playwright/test';

// The login screen is fully static (no Supabase call on load), so these tests
// run without any backend. They verify the page boots and the auth form is
// wired correctly.

test('login page loads with title, footer and Discord button', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/FGF|Guild/i);
    await expect(page.locator('#login-view .gm-login-title').first()).toContainText(/FGF GUILD MANAGEMENT/i);
    await expect(page.locator('.gm-login-discord-btn')).toBeVisible();
    await expect(page.locator('.gm-login-footer')).toContainText('Developed by HawkEye #1058');
});

test('login form has identifier, password and sign-in button', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#login-btn')).toBeVisible();
});

test('empty login submit triggers HTML validation, no navigation', async ({ page }) => {
    await page.goto('/');
    await page.locator('#login-btn').click();
    // HTML5 required validation keeps us on the page; identifier still visible.
    await expect(page.locator('#username')).toBeVisible();
});

test('can switch to the player registration form and back', async ({ page }) => {
    await page.goto('/');
    // Register is reachable from the login card link.
    const registerLink = page.locator('a,button').filter({ hasText: /register|player account/i }).first();
    if (await registerLink.count()) {
        await registerLink.click();
        await expect(page.locator('#register-form')).toBeVisible();
        await expect(page.locator('#register-uid')).toBeVisible();
        await expect(page.locator('#register-code')).toBeVisible();
        // Back to login
        await page.locator('#register-back-btn').click();
        await expect(page.locator('#login-form')).toBeVisible();
    }
});

test('clicking Terms & Conditions in footer opens dedicated full page and can return to platform', async ({ page }) => {
    await page.goto('/');
    const termsLink = page.locator('#terms-link');
    await expect(termsLink).toBeVisible();
    await expect(termsLink).toContainText('Terms & Conditions');

    await termsLink.click();
    await expect(page).toHaveURL(/terms/);

    const title = page.locator('.terms-doc-title');
    await expect(title).toBeVisible();
    await expect(title).toContainText('TERMS OF SERVICE AND GENERAL CONDITIONS OF SALE');

    await expect(page.locator('body')).toContainText('André Vieira');
    await expect(page.locator('body')).toContainText('SECTION 1. LEGAL NOTICE & STATUTORY DISCLOSURES');
    await expect(page.locator('body')).toContainText('SECTION 4. COMMERCIAL TERMS, ACCESS PASSES & NO AUTOMATIC RENEWAL');
    await expect(page.locator('body')).toContainText('SECTION 9. GOVERNING LAW & JURISDICTION');

    // Return to platform
    const returnBtn = page.locator('.terms-back-btn');
    await expect(returnBtn).toBeVisible();
    await returnBtn.click();
    await expect(page.locator('#login-form')).toBeVisible();
});

