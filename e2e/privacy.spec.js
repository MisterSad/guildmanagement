// Phase 8. The privacy policy is a legal page served from `dist/`, and the one
// failure mode it has already suffered once (finding H3, on terms.html) is a
// stylesheet that 404s in production while looking fine locally: the root app
// CSS is deliberately excluded from `dist/`, so a legal page that links it ships
// unstyled with four console errors.
//
// `legal.css` is a NEW root stylesheet, so this runs against the real built
// bundle and asserts the stylesheet actually arrives and actually applies --
// not merely that the markup references it.

import { test, expect } from '@playwright/test';

test('privacy.html is served, styled from legal.css, and free of console errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const failed = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });

  await page.goto('/privacy.html');

  await expect(page.locator('.terms-doc-title')).toContainText('PRIVACY POLICY');

  // The stylesheet must have been fetched AND parsed. A 404 that returns the
  // SPA's index.html would still be a 200, so the MIME-type refusal that broke
  // terms.html would not show up as a failed response -- which is exactly why
  // this asserts a computed style instead.
  const bg = await page.locator('.terms-content-card').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg, 'the content card is unstyled: legal.css did not apply').not.toBe('rgba(0, 0, 0, 0)');

  const sheetApplied = await page.evaluate(() =>
    [...document.styleSheets].some((s) => (s.href || '').includes('legal.css') && s.cssRules.length > 0)
  );
  expect(sheetApplied, 'legal.css was not parsed as CSS').toBe(true);

  expect(failed, `failed requests: ${failed.join(', ')}`).toEqual([]);
  expect(errors, `console errors: ${errors.join(', ')}`).toEqual([]);
});

test('privacy.html states the things that make it a GDPR notice', async ({ page }) => {
  await page.goto('/privacy.html');
  const body = page.locator('body');
  // Rewritten 2026-09-27 in plain English. Same obligations, different words.
  await expect(body).toContainText('André Vieira');
  // Redrafted in legal register on 2026-09-27. Same obligations, cited by
  // article rather than paraphrased.
  await expect(body).toContainText('CATEGORIES OF DATA PROCESSED');
  await expect(body).toContainText('PURPOSES AND LEGAL BASES');
  await expect(body).toContainText('RETENTION PERIODS');
  await expect(body).toContainText('RECIPIENTS AND TRANSFERS');
  await expect(body).toContainText('RIGHTS OF DATA SUBJECTS');
  await expect(body).toContainText('CNIL');
  // The ban-record carve-out is disclosed with its basis, not applied silently.
  await expect(body).toContainText('retained in full, including the identifier');
  await expect(body).toContainText('Article 17(3) GDPR');
});

test('the two legal pages link to each other, and back to the platform', async ({ page }) => {
  // On the legal pages there is exactly one <footer>, unlike index.html.
  await page.goto('/privacy.html');
  await page.locator('footer a[href="terms.html"]').click();
  await expect(page).toHaveURL(/terms/);

  await page.locator('footer a[href="privacy.html"]').click();
  await expect(page).toHaveURL(/privacy/);

  await page.locator('.terms-back-btn').click();
  await expect(page.locator('#login-form')).toBeVisible();
});

test('the login footer offers the privacy policy beside the terms', async ({ page }) => {
  // index.html carries TWO footers -- the login one and the player-portal one
  // -- and only one is ever visible. A bare `footer a[href=...]` matched the
  // hidden portal footer and failed on visibility, which is the locator's
  // fault and not the page's. Scope to the login footer by its own class.
  await page.goto('/');
  const link = page.locator('.gm-login-footer a[href="privacy.html"]');
  await expect(link).toBeVisible();
  await expect(link).toContainText('Privacy Policy');
  // And it sits beside the terms link rather than replacing it.
  await expect(page.locator('.gm-login-footer a[href="terms.html"]')).toBeVisible();
});
