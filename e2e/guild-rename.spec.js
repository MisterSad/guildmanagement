import { test, expect } from '@playwright/test';

// Guild TAG card and rename dialog, against the PRODUCTION bundle in dist/.
// The session is injected through window.GM_APP.showAdminDashboard(), as in
// dashboard-nav.spec.js. supabase-js comes from the (stubbed) CDN, so GM.db is
// replaced by a fake whose rpc() answers the two guild-rename functions.

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

async function openAccountsTab(page, history) {
  await page.evaluate((hist) => {
    localStorage.setItem('gm_current_guild', 'AB');
    window.__renameCalls = [];
    window.GM.db = {
      rpc: async (name, args) => {
        window.__renameCalls.push({ name, args });
        if (name === 'gm_guild_tag_history') return { data: hist, error: null };
        if (name === 'gm_rename_guild') return { data: { ok: false, error: 'tag_taken' }, error: null };
        return { data: null, error: null };
      },
      from: () => {
        const q = {
          select: () => q, eq: () => q, ilike: () => q, order: () => q, in: () => q, limit: () => q,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (res) => res({ data: [], error: null }),
        };
        return q;
      },
    };
    window.GM_APP.showAdminDashboard();
  }, history);
  await expect(page.locator('#dashboard-view')).toBeVisible();
  await page.locator('.nav-tab[data-tab="admin-home"]').evaluate((el) => el.click());
  await expect(page.locator('#admin-home')).toHaveClass(/active/);
}

test.beforeEach(async ({ page }) => {
  await stubNetwork(page);
  await page.goto('/');
});

test('the Guild TAG card is shown when the server allows a rename, and the dialog reports refusals', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) errors.push(msg.text()); });

  await openAccountsTab(page, {
    ok: true, can_rename: true, cooldown_applies: true, next_allowed_at: null,
    history: [{ old_tag: 'OLD', new_tag: 'AB', changed_at: '2026-09-01T10:00:00Z' }],
  });

  const card = page.locator('#guild-tag-card');
  await expect(card).toBeVisible();
  await expect(page.locator('#guild-tag-current')).toHaveText('AB');
  await expect(page.locator('#guild-tag-history')).toContainText('OLD → AB');

  await page.locator('#guild-tag-rename-btn').click();
  const dialog = page.locator('#guild-rename-overlay');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#guild-rename-ok')).toBeDisabled();

  await page.locator('#guild-rename-input').fill('a b');
  await expect(page.locator('#guild-rename-error')).toContainText('2 to 12 characters');
  await expect(page.locator('#guild-rename-ok')).toBeDisabled();

  await page.locator('#guild-rename-input').fill('cd');
  await expect(page.locator('#guild-rename-ok')).toBeEnabled();
  await page.locator('#guild-rename-ok').click();
  await expect(page.locator('#guild-rename-error')).toContainText('Another guild already uses this TAG');
  await expect(dialog).toBeVisible();

  const calls = await page.evaluate(() => window.__renameCalls.filter((c) => c.name === 'gm_rename_guild'));
  expect(calls).toEqual([{ name: 'gm_rename_guild', args: { p_guild: 'AB', p_new_tag: 'CD' } }]);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the card stays hidden when the server says the caller cannot rename', async ({ page }) => {
  await openAccountsTab(page, { ok: true, can_rename: false, cooldown_applies: true, next_allowed_at: null, history: [] });
  await expect.poll(() => page.evaluate(() => window.__renameCalls.some((c) => c.name === 'gm_guild_tag_history'))).toBe(true);
  await expect(page.locator('#guild-tag-card')).toBeHidden();
});
