import { test, expect } from '@playwright/test';

// Player Portal e2e with route interception: we stub the member-portal edge
// function HTTP calls made by the real supabase-js client, so the portal
// renders without a real backend. Verifies boot, navigation and the weekly
// challenges panel.

const FIXTURES = {
    'get-active-sessions': {
        ok: true, pseudo: 'AlphaPrime', guild: 'ALPHA',
        overall_power: 80000000, timezone_offset: 1, glory: 5000,
        sessions: [{ event_name: 'GvG', session_id: 'GVG-2026-W32', start_at: null, current_data: { participated: 1, score_prep: 1000 } }]
    },
    'get-history': { ok: true, events: {} },
    'get-personal-kpis': { ok: true, attendance: { rate: 75 }, glory: { current_week: 5000 } },
    'get-weekly-challenges': {
        ok: true, week: '2026-08-03',
        challenges: [
            { id: 'events1', label: 'Attend 1 event this week', icon: 'ph-calendar-check', done: true, progress: 1, target: 1 },
            { id: 'events3', label: 'Attend 3 events this week', icon: 'ph-lightning', done: false, progress: 1, target: 3 },
            { id: 'glory', label: 'Submit your Glory score', icon: 'ph-trophy', done: true, progress: 1, target: 1 }
        ],
        completed: 2, total: 3,
        season: { level: 'Silver', events: 9 }
    },
    'get-badges': { ok: true, role: 'R3', created_at: '2026-06-01T00:00:00Z', overall_power: 80000000, attended: 12, glory_best: 4000 },
    'get-push-prefs': { ok: true, event_types: ['events', 'glory', 'challenges'] },
    'get-transfer-guilds': { ok: true, guilds: [] }
};

function stubMemberPortal(page) {
    return page.route('**/functions/v1/member-portal', async (route) => {
        let body = {};
        try { body = route.request().postDataJSON() || {}; } catch (e) {}
        const action = body.action;
        const reply = FIXTURES[action] || { ok: true };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) });
    });
}

function openPortal(page) {
    return page.evaluate(() => {
        const view = document.getElementById('player-portal-view');
        view.classList.remove('hidden');
        view.classList.add('portal-connected');
        const step = document.getElementById('portal-step-form');
        step.classList.remove('hidden');
        window.GM_PORTAL.loadDashboard();
    });
}

test('portal dashboard boots after lookup with stubbed backend', async ({ page }) => {
    await stubMemberPortal(page);
    await page.goto('/');
    await openPortal(page);
    await expect(page.locator('#portal-dashboard-root')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('AlphaPrime', { exact: true })).toBeVisible();
});

test('portal sidebar offers My Info, My Progress and Challenges', async ({ page }) => {
    await stubMemberPortal(page);
    await page.goto('/');
    await openPortal(page);
    const nav = page.locator('.gm-sidebar-nav [data-portal-nav]');
    await expect(nav.filter({ hasText: 'My Info' })).toBeVisible();
    await expect(nav.filter({ hasText: 'My Progress' })).toBeVisible();
    await expect(nav.filter({ hasText: 'Challenges' })).toBeVisible();
});

test('Challenges tab renders weekly goals and season rank', async ({ page }) => {
    await stubMemberPortal(page);
    await page.goto('/');
    await openPortal(page);
    const nav = page.locator('.gm-sidebar-nav [data-portal-nav]');
    await nav.filter({ hasText: 'Challenges' }).click();
    await expect(page.locator('#portal-panel-challenges')).toBeVisible();
    await expect(page.locator('.portal-challenge-list')).toBeVisible();
    await expect(page.locator('.portal-challenges-summary')).toContainText('Silver');
    await expect(page.locator('.portal-challenge')).toHaveCount(3);
});
