import { test, expect } from './fixtures.js';
import AxeBuilder from '@axe-core/playwright';

// axe-core over the production bundle in dist/ (medium-term plan, M5): the
// sign-in screen, the player portal, every admin tab and the dialogs, with no
// critical or serious WCAG 2.2 A/AA violation. The backend is stubbed the way
// portal.spec.js and dashboard-nav.spec.js stub it -- axe reads the DOM the
// app renders, which is the same with fixture data as with DEMO's.
//
// axe only judges what is displayed; each screen is opened before it is read.

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const REPORT = !!process.env.A11Y_REPORT;

async function expectNoSeriousViolations(page, screen) {
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  const summary = blocking
    .map(
      (v) =>
        `${v.impact} ${v.id} (${v.nodes.length}): ${v.help}\n` +
        v.nodes
          .slice(0, REPORT ? 50 : 5)
          .map((n) => `    ${n.target.join(' ')}  ${n.failureSummary.split('\n')[1] || ''}`)
          .join('\n')
    )
    .join('\n');
  if (REPORT) {
    console.log(`\n=== ${screen}: ${blocking.length} rules\n${summary}`);
    return;
  }
  expect(blocking, `${screen}\n${summary}`).toEqual([]);
}

const PORTAL = {
  'get-active-sessions': {
    ok: true,
    pseudo: 'AlphaPrime',
    guild: 'ALPHA',
    overall_power: 80000000,
    timezone_offset: 1,
    glory: 5000,
    sessions: [
      {
        event_name: 'GvG',
        session_id: 'GVG-2026-W32',
        start_at: null,
        current_data: { participated: 1, score_prep: 1000 },
      },
    ],
  },
  'get-history': { ok: true, events: {} },
  'get-personal-kpis': { ok: true, attendance: { rate: 75 }, glory: { current_week: 5000 } },
  'get-weekly-challenges': {
    ok: true,
    week: '2026-08-03',
    completed: 1,
    total: 2,
    season: { level: 'Silver', events: 9 },
    challenges: [
      {
        id: 'events1',
        label: 'Attend 1 event this week',
        icon: 'ph-calendar-check',
        done: true,
        progress: 1,
        target: 1,
      },
      { id: 'glory', label: 'Submit your Glory score', icon: 'ph-trophy', done: false, progress: 0, target: 1 },
    ],
  },
  'get-badges': {
    ok: true,
    role: 'R3',
    created_at: '2026-06-01T00:00:00Z',
    overall_power: 80000000,
    attended: 12,
    glory_best: 4000,
  },
  'get-transfer-guilds': { ok: true, guilds: [] },
};

async function stubBackend(page) {
  await page.route('**/rest/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  );
  // Playwright tries the most recently registered route first.
  await page.route('**/functions/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  );
  await page.route('**/functions/v1/member-portal', async (route) => {
    let body = {};
    try {
      body = route.request().postDataJSON() || {};
    } catch (_) {
      /* not JSON */
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(PORTAL[body.action] || { ok: true }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await stubBackend(page);
  await page.goto('/');
});

test('the sign-in screen', async ({ page }) => {
  await expect(page.locator('#login-view')).toBeVisible();
  await expectNoSeriousViolations(page, 'sign-in');
});

test('the player portal', async ({ page }) => {
  await page.evaluate(() => {
    const view = document.getElementById('player-portal-view');
    view.classList.remove('hidden');
    view.classList.add('portal-connected');
    document.getElementById('portal-step-form').classList.remove('hidden');
    document.getElementById('login-view').classList.add('hidden');
    window.GM_E2E.loadPortalDashboard();
  });
  await expect(page.locator('#portal-dashboard-root')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('AlphaPrime', { exact: true })).toBeVisible();
  await expectNoSeriousViolations(page, 'portal');
});

const ADMIN_TABS = [
  'overview',
  'members',
  'events',
  'glory',
  'history',
  'stats',
  'accounts',
  'discord',
  'sanctions',
  'banned',
  'superadmin-accounts',
  'tickets',
];

for (const item of ADMIN_TABS) {
  test(`the admin dashboard: ${item}`, async ({ page }) => {
    // The shell lists tabs by the role it last saw; super_admin shows them all.
    // Display only: every request is still stubbed, and RLS would decide.
    await page.evaluate(() => {
      localStorage.setItem('gm_role', 'super_admin');
      window.GM_E2E.showAdminDashboard();
    });
    const nav = page.locator(`.gm-nav-item[data-gm-nav-item="${item}"]`);
    await expect(nav).toBeVisible();
    await nav.click();
    await page.waitForLoadState('networkidle');
    await expectNoSeriousViolations(page, `admin ${item}`);
  });
}

test('the OCR modal', async ({ page }) => {
  await page.evaluate(() => window.GM_E2E.showAdminDashboard());
  await page.evaluate(() => window.GM_E2E.openOcrModal('members'));
  await expect(page.locator('#ocr-modal-overlay')).toBeVisible();
  await expectNoSeriousViolations(page, 'OCR modal');
});

test('the confirmation dialog', async ({ page }) => {
  await page.evaluate(() =>
    window.GM_E2E.showConfirm(
      'Delete this session?',
      'This cannot be undone.',
      () => {},
      () => {}
    )
  );
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expectNoSeriousViolations(page, 'confirm dialog');
});
