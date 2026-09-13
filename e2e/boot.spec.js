import { test, expect } from '@playwright/test';

// Boot integrity of the PRODUCTION bundle in dist/ (see playwright.config.js):
//  - index.html loads and shows the auth screen with no uncaught JS exception;
//  - the service worker is actually served at /sw.js (200, not 404), which is
//    the whole point of keeping the compiled worker at the root of dist/.
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

test('the compiled service worker is served at /sw.js (200, not 404)', async ({ page, request }) => {
  // 1. The file itself must be reachable at the root-scoped path in dist/.
  const response = await request.get('/sw.js');
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type'] || '').toContain('javascript');

  // 2. The app must actually register it at root scope. Chromium does not
  //    surface the service-worker script request through page.waitForResponse,
  //    so poll navigator.serviceWorker instead.
  await stubNetwork(page);
  await page.goto('/');

  const scope = await page
    .waitForFunction(
      async () => {
        const reg = await navigator.serviceWorker.getRegistration('/');
        return reg ? reg.scope : null;
      },
      null,
      { timeout: 15_000 }
    )
    .then((handle) => handle.jsonValue());

  expect(scope).toContain('/');
});
