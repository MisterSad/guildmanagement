import { test, expect } from './fixtures.js';

// The Shadowfront and Arms Race views render their own event banner (status,
// Start / End / Edit / Delete) inside the panel. A stylesheet rule that hid
// "the static Shadowfront banner" (#event-shadowfront .gm-event-banner) used
// to lose to the banner's inline display:flex; once inline styles left for
// u-* classes, the ID selector won and the admin lost every session control.
// Only a real layout catches that, so this runs against the built bundle.

const EVENT_BANNERS = [
  { tab: 'event-shadowfront', start: '.sf-squad-start-btn' },
  { tab: 'event-arms-race', start: '.ar-stage-start-btn' },
];

test.beforeEach(async ({ page }) => {
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
  await page.goto('/');
  await page.evaluate(() => window.GM_E2E.showAdminDashboard());
  await expect(page.locator('#dashboard-view')).toBeVisible();
});

for (const { tab, start } of EVENT_BANNERS) {
  test(`${tab} shows its event banner and Start button`, async ({ page }) => {
    await page.locator('.gm-nav-item[data-gm-nav-item="events"]').click();
    await page.locator(`#event-svs [data-gm-event-tab="${tab}"]`).click();
    await expect(page.locator(`#${tab}`)).toHaveClass(/active/);

    await expect(page.locator(`#${tab} .gm-event-banner`)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`#${tab} ${start}`)).toBeVisible();
  });
}

// ADR-023: a session counts in the ISO week of its start date (UTC). The
// start dialog shows that week before the officer confirms, on the built
// bundle and under the strict CSP.
test('the start dialog shows the week the session will count in', async ({ page }) => {
  await page.locator('.gm-nav-item[data-gm-nav-item="events"]').click();
  await page.locator('#event-svs [data-gm-event-tab="event-shadowfront"]').click();
  await page.locator('#event-shadowfront .sf-squad-start-btn').first().click();

  const dialog = page.locator('#evt-start-overlay');
  await expect(dialog).toBeVisible();
  const hint = dialog.locator('#evt-start-week');
  await expect(hint).toHaveText(/^Counts in week W\d{2} \(\d{2}\/\d{2} → \d{2}\/\d{2}\/\d{4}\)$/);

  await dialog.locator('#evt-start-date').fill('2026-11-01');
  await expect(hint).toHaveText('Counts in week W44 (26/10 → 01/11/2026)');
  await dialog.locator('#evt-start-date').fill('2026-11-02');
  await expect(hint).toHaveText('Counts in week W45 (02/11 → 08/11/2026)');
});
