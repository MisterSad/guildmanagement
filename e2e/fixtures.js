import { test as base, expect } from '@playwright/test';

// Every spec imports `test` from here. The suite serves dist/ under
// production's Content-Security-Policy (scripts/e2e-serve-config.mjs builds the
// serve config from vercel.json), and this fixture fails the test on any
// violation the browser reports -- an inline style it refused, a script or a
// connection outside the allow-list. Without it a blocked style is silent: the
// element just renders unstyled.
export const test = base.extend({
  page: async ({ page }, use) => {
    const violations = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (/Content Security Policy/i.test(text)) violations.push(text);
    });
    await use(page);
    expect(violations, 'Content-Security-Policy violations').toEqual([]);
  },
});

export { expect };
