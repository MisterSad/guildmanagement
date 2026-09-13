import { test, expect } from '@playwright/test';

// Session & navigation coverage against the PRODUCTION bundle in dist/.
// The real login needs the Supabase backend, so the session is injected the
// same way existing specs bypass the boot (portal.spec.js / ocr-modal.spec.js):
// call the typed bridge window.GM_APP.showAdminDashboard() directly. That is
// enough to exercise the tab router, the modern shell navigation and the global
// confirm dialog, which are all pure DOM/state code.
//
// The shipped bundle renders the modern `.gm-shell` sidebar (the legacy
// `.app-header .nav-tabs` is hidden by shell.css), so the user-facing
// Overview/Members/Events/Stats switching goes through `.gm-nav-item`. A
// separate test still asserts the legacy `.nav-tab` router keeps working.

const SHELL_NAV = [
  { item: 'overview', panel: 'gm-overview' },
  { item: 'members', panel: 'admin-members' },
  { item: 'events', panel: 'event-svs' },
  { item: 'stats', panel: 'stats-admin' },
];

async function stubNetwork(page) {
  await page.route('https://cdn.jsdelivr.net/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
  );
  await page.route('https://unpkg.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
  );
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/functions/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  );
}

async function openDashboard(page) {
  await page.evaluate(() => window.GM_APP.showAdminDashboard());
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await expect(page.locator('.gm-nav-item[data-gm-nav-item="members"]')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await stubNetwork(page);
  await page.goto('/');
});

test('an injected session reveals the dashboard and hides the login view', async ({ page }) => {
  await openDashboard(page);
  await expect(page.locator('#login-view')).toBeHidden();
  await expect(page.locator('#dashboard-view')).toBeVisible();
});

test('shell nav switches between Overview, Members, Events and Stats', async ({ page }) => {
  await openDashboard(page);

  for (const { item, panel } of SHELL_NAV) {
    const button = page.locator(`.gm-nav-item[data-gm-nav-item="${item}"]`);
    await button.click();
    await expect(button).toHaveClass(/gm-active/);
    await expect(page.locator(`#${panel}`)).toHaveClass(/active/);
  }
});

test('legacy .nav-tab router still activates its panel', async ({ page }) => {
  await openDashboard(page);

  // The legacy tab bar is hidden by the modern shell, so dispatch the click
  // programmatically: this guards the delegated `.nav-tab` router itself.
  await page.locator('.nav-tab[data-tab="admin-members"]').evaluate((el) => el.click());
  await expect(page.locator('#admin-members')).toHaveClass(/active/);

  await page.locator('.nav-tab[data-tab="stats-admin"]').evaluate((el) => el.click());
  await expect(page.locator('#stats-admin')).toHaveClass(/active/);
});

test('members panel renders a table or empty state without a DOM crash', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await openDashboard(page);
  await page.locator('.gm-nav-item[data-gm-nav-item="members"]').click();
  await expect(page.locator('#admin-members')).toHaveClass(/active/);

  const list = page.locator('#guild-member-list');
  await expect(list).toBeVisible();
  await expect(list.locator('table, .gm-empty').first()).toBeVisible({ timeout: 10_000 });

  expect(pageErrors).toEqual([]);
});

test('global showConfirm modal closes via its Cancel button', async ({ page }) => {
  await openDashboard(page);
  await page.evaluate(() =>
    window.showConfirm('Delete member', 'This cannot be undone.', () => {}, () => {})
  );

  const overlay = page.locator('#confirm-overlay');
  await expect(overlay).toBeVisible();
  await page.locator('#confirm-cancel').click();
  await expect(overlay).toBeHidden({ timeout: 5_000 });
});

test('global showConfirm modal closes via the Escape key', async ({ page }) => {
  await openDashboard(page);
  await page.evaluate(() =>
    window.showConfirm('Delete member', 'This cannot be undone.', () => {}, () => {})
  );

  const overlay = page.locator('#confirm-overlay');
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden({ timeout: 5_000 });
});
