import { test, expect } from '@playwright/test';

// The login screen is fully static (no Supabase call on load), so these tests
// run without any backend. They verify the page boots and the auth form is
// wired correctly.

test('login page loads with title, footer and both Discord affordances', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/FGF|Guild/i);
    await expect(page.locator('#login-view .gm-login-title').first()).toContainText(/FGF GUILD MANAGEMENT/i);

    // Two distinct things now share .gm-login-discord-btn, so each is asserted
    // on its own: the Phase D2 sign-in button, and the long-standing link to
    // the community server. A bare class selector would match both and fail
    // Playwright's strict mode -- which is how this was caught.
    await expect(page.locator('#login-discord-btn')).toBeVisible();
    await expect(page.locator('#login-discord-btn')).toContainText(/Continue with Discord/i);
    await expect(page.locator('a.gm-login-discord-btn[href*="discord.gg"]')).toBeVisible();

    await expect(page.locator('.gm-login-footer')).toContainText('Developed by HawkEye #1058');
});

test('login form has identifier, password and sign-in button', async ({ page }) => {
    await page.goto('/');
    // Folded behind a summary since 2026-10-02: Discord is the one door.
    await page.locator('#login-legacy > summary').click();
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#login-btn')).toBeVisible();
});

test('empty login submit triggers HTML validation, no navigation', async ({ page }) => {
    await page.goto('/');
    await page.locator('#login-legacy > summary').click();
    await page.locator('#login-btn').click();
    // HTML5 required validation keeps us on the page; identifier still visible.
    await expect(page.locator('#username')).toBeVisible();
});

test('there is no player registration form to switch to', async ({ page }) => {
    await page.goto('/');
    // The old test clicked a link "if (await registerLink.count())", so it
    // passed vacuously the moment the link went away. This one fails if the
    // password sign-up ever comes back.
    await expect(page.locator('#register-form')).toHaveCount(0);
    await expect(page.locator('#auth-tab-register')).toHaveCount(0);
    await expect(page.locator('#portal-go-register-btn')).toHaveCount(0);
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
    // The Terms were rewritten on 2026-09-27 in plain English for a free
    // community app. Asserted on what the page must SAY, not on the old
    // block-capital headings.
    await expect(title).toContainText('TERMS OF USE');

    await expect(page.locator('body')).toContainText('André Vieira');
    // Redrafted in legal register on 2026-09-27.
    await expect(page.locator('body')).toContainText('LEGAL NOTICE AND IDENTIFICATION OF THE PUBLISHER');
    await expect(page.locator('body')).toContainText('NO CONSIDERATION, AND THE CONSEQUENCES');
    await expect(page.locator('body')).toContainText('INTELLECTUAL PROPERTY AND OPEN-SOURCE UNDERTAKING');
    await expect(page.locator('body')).toContainText('GOVERNING LAW, CLAIMS AND JURISDICTION');

    // Return to platform
    const returnBtn = page.locator('.terms-back-btn');
    await expect(returnBtn).toBeVisible();
    await returnBtn.click();
    await expect(page.locator('#login-form')).toBeVisible();
});

