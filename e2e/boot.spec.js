import { test, expect } from './fixtures.js';

// Boot integrity of the PRODUCTION bundle in dist/ (see playwright.config.js):
//  - index.html loads and shows the auth screen with no uncaught JS exception;
//  - /sw.js is still served (200, not 404) and is the self-unregistering
//    tombstone left behind by the PWA removal, and the app itself no longer
//    registers any service worker.
//
// External CDN scripts (supabase UMD + phosphor icons) are stubbed so the spec
// never depends on network access; the app's own Supabase client is bundled by
// Vite, so an empty stub is safe.

const CDN_ROUTES = ['https://cdn.jsdelivr.net/**', 'https://unpkg.com/**'];

async function stubNetwork(page) {
  for (const pattern of CDN_ROUTES) {
    await page.route(pattern, (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
    );
  }
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  await page.route('**/functions/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  );
}

test('production index.html boots with no uncaught JS exception', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await stubNetwork(page);
  await page.goto('/');

  await expect(page).toHaveTitle(/FGF|Guild/i);
  await expect(page.locator('#login-view')).toBeVisible();
  await expect(page.locator('#login-form')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('/sw.js is still served, and is the self-unregistering tombstone', async ({ request }) => {
  // The PWA is retired, but the file must KEEP being served: a worker already
  // installed on a member's device only goes away if the browser can fetch a
  // new /sw.js that unregisters itself. A 404 here would leave every existing
  // installation running the old push worker indefinitely.
  const response = await request.get('/sw.js');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type'] || '').toContain('javascript');

  const body = await response.text();
  // esbuild minifies the worker, so assert on what survives minification:
  // the unregister call, and the absence of the push pipeline.
  expect(body).toMatch(/unregister\(\)/);
  expect(body).not.toMatch(/showNotification/);
  expect(body).not.toMatch(/notificationclick/);
});

test('the app no longer registers a service worker', async ({ page }) => {
  await stubNetwork(page);
  await page.goto('/');

  // Give the page the same window the old registration had (it registered on
  // the `load` event), then assert nothing claimed a registration.
  await page.waitForLoadState('load');
  await page.waitForTimeout(1000);

  const registrations = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 0;
    const regs = await navigator.serviceWorker.getRegistrations();
    return regs.length;
  });

  expect(registrations).toBe(0);
});
