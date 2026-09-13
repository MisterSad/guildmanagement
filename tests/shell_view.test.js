/**
 * tests/shell_view.test.js
 *
 * Strangler Phase 1 behavioral suite for the strict-TS `ShellView`
 * (src/modules/shell/views/ShellView.ts). The legacy root `shell.js` stays in
 * place during this phase; this suite exercises the new module directly in
 * jsdom and guards the anti-shadowing invariant (no `window.GM_SHELL` written).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ShellView, NAV_ITEMS, BREAKPOINT_MOBILE } from '../src/modules/shell/views/ShellView';

const FIXTURE = `
  <div id="dashboard-view">
    <div class="app-header"><div class="nav-tabs">
      <button class="nav-tab active" data-tab="admin-home">Accounts</button>
    </div></div>
    <div class="dashboard-content tab-panel active" id="admin-home"></div>
    <div class="dashboard-content tab-panel" id="admin-members"></div>
    <div class="dashboard-content tab-panel" id="event-svs"></div>
    <div class="dashboard-content tab-panel" id="event-gvg"></div>
    <div class="dashboard-content tab-panel" id="stats-admin"></div>
    <div class="dashboard-content tab-panel" id="tab-settings">
      <div id="settings-subtabs">
        <button class="gm-settings-tab" data-settings-tab="draft">Draft</button>
        <button class="gm-settings-tab" data-settings-tab="svs">SvS</button>
        <button class="gm-settings-tab" data-settings-tab="gvg">GvG</button>
      </div>
      <div data-settings-panel="draft"></div>
      <div data-settings-panel="svs" class="hidden"></div>
      <div data-settings-panel="gvg" class="hidden"></div>
    </div>
  </div>`;

let views = [];

function installGM(role, paymentsDisabled) {
  const calls = { onTabActivated: [], reloadActiveView: [] };
  window.GM = {
    t: (k) => k,
    escapeHTML: (s) => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;'),
    roleFromStorage: () => role,
    isSuperAdmin: () => role === 'super_admin',
    isServerAdmin: () => role === 'server_admin',
    isGuildAdmin: () => role !== 'member',
    isPaymentsDisabled: () => !!paymentsDisabled,
    avatarInit: (s) => String(s || '').slice(0, 1).toUpperCase(),
    appVersion: 'V-test',
    detectClientEnvironment: () => ({ appVersion: 'V-test', os: 'TestOS', browser: 'TestBrowser' }),
    formatTicketDescription: () => 'desc',
    showToast: () => {},
    db: { functions: { invoke: async () => ({ data: { ok: true, ticket_number: 7 } }) } },
    compressImageForUpload: async () => 'data:image/png;base64,AAAA'
  };
  window.GM_APP = {
    onTabActivated: (id) => calls.onTabActivated.push(id),
    reloadActiveView: () => calls.reloadActiveView.push(1)
  };
  window.GM_LEADER_HALL = { updateAllUnreadBadges: vi.fn() };
  window.GM_OVERVIEW = { load: vi.fn() };
  window.GM_SHADOWFRONT = { load: vi.fn() };
  window.GM_ARMSRACE = { load: vi.fn() };
  window.GM_SETTINGS = { load: vi.fn() };
  window.GM_SVS_MATCHUP = { load: vi.fn() };
  window.GM_GVG_MATCHUP = { load: vi.fn() };
  window.guildsList = ['ALPHA', 'BETA'];
  window.guildsData = {
    ALPHA: { type: 'Unlimited', server_number: 1 },
    BETA: { type: 'Premium', end: '2999-01-01', server_number: 2 }
  };
  window.currentGuild = 'ALPHA';
  window.currentGuildRestriction = null;
  return calls;
}

function boot(role, opts = {}) {
  document.body.innerHTML = FIXTURE;
  localStorage.clear();
  const calls = installGM(role, opts.paymentsDisabled);
  const view = new ShellView();
  views.push(view);
  return { view, calls };
}

function sidebarIds() {
  return Array.from(document.querySelectorAll('[data-gm-sidebar] [data-gm-nav-item]'))
    .map((b) => b.getAttribute('data-gm-nav-item'));
}

const tick = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  views.forEach((v) => { try { v.destroy(); } catch (_) { /* ignore */ } });
  views = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.GM;
  delete window.GM_APP;
  delete window.GM_LEADER_HALL;
  delete window.GM_OVERVIEW;
  delete window.GM_SHADOWFRONT;
  delete window.GM_ARMSRACE;
  delete window.GM_SETTINGS;
  delete window.GM_SVS_MATCHUP;
  delete window.GM_GVG_MATCHUP;
  delete window.guildsList;
  delete window.guildsData;
  delete window.currentGuild;
  delete window.currentGuildRestriction;
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('ShellView — structure & constants', () => {
  it('keeps the key constants (BREAKPOINT_MOBILE = 900, NAV_ITEMS) and does not write window.GM_SHELL', () => {
    expect(BREAKPOINT_MOBILE).toBe(900);
    expect(NAV_ITEMS.find((i) => i.id === 'subscription').adminOnly).toBe(true);
    expect(NAV_ITEMS.find((i) => i.id === 'settings').r5Only).toBe(true);
    expect(NAV_ITEMS.find((i) => i.id === 'leader-hall').section).toBe('play');
    expect(NAV_ITEMS.find((i) => i.id === 'subscription').section).toBe('footer');

    const { view } = boot('super_admin');
    view.init();
    expect(window.GM_SHELL).toBeUndefined();
  });
});

describe('ShellView — renderShell()', () => {
  it('wraps the dashboard and renders sidebar, topbar, bottom-nav and drawer', () => {
    const { view } = boot('guild_admin');
    document.body.classList.add('guild-read-only');
    view.init();

    expect(document.querySelector('#dashboard-view .gm-shell')).toBeTruthy();
    expect(document.querySelector('[data-gm-sidebar] .gm-sidebar-nav')).toBeTruthy();
    expect(document.querySelector('[data-gm-topbar] .gm-topbar-actions')).toBeTruthy();
    expect(document.querySelector('[data-gm-bottom-nav] .gm-bottom-nav-inner')).toBeTruthy();
    expect(document.querySelector('[data-gm-drawer] .gm-drawer-grid')).toBeTruthy();

    // Existing panels were moved into .gm-content, placeholder overview created.
    expect(document.querySelector('[data-gm-content] #admin-members')).toBeTruthy();
    expect(document.getElementById('gm-overview')).toBeTruthy();
    // Legacy hidden nav-tab for gm-overview was injected for app.js.
    expect(document.querySelector('.app-header .nav-tabs [data-tab="gm-overview"]')).toBeTruthy();
    // Subscription status check clears read-only mode.
    expect(document.body.classList.contains('guild-read-only')).toBe(false);
  });

  it('renders the app version above Terms & Conditions in the sidebar footer', () => {
    const { view } = boot('guild_admin');
    view.init();
    const footer = document.querySelector('[data-gm-sidebar] .gm-sidebar-legal-footer');
    expect(footer).toBeTruthy();
    expect(footer.querySelector('.gm-app-version').textContent).toBe('V-test');
    expect(footer.querySelector('.gm-sidebar-legal-link')).toBeTruthy();
  });

  it('wires settings sub-tabs to the lazy loaders (GM_SETTINGS / GM_SVS_MATCHUP / GM_GVG_MATCHUP)', () => {
    const { view } = boot('super_admin');
    view.init();

    document.querySelector('[data-settings-tab="draft"]').click();
    expect(window.GM_SETTINGS.load).toHaveBeenCalledTimes(1);
    expect(window.GM_SVS_MATCHUP.load).not.toHaveBeenCalled();
    expect(document.querySelector('[data-settings-panel="draft"]').classList.contains('hidden')).toBe(false);

    document.querySelector('[data-settings-tab="svs"]').click();
    expect(window.GM_SVS_MATCHUP.load).toHaveBeenCalledTimes(1);

    document.querySelector('[data-settings-tab="gvg"]').click();
    expect(window.GM_GVG_MATCHUP.load).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-settings-panel="svs"]').classList.contains('hidden')).toBe(true);
  });
});

describe('ShellView — gotoItem()', () => {
  it('persists the tab, toggles .active on the matching panel and calls GM_APP.onTabActivated', () => {
    const { view, calls } = boot('guild_admin');
    view.init();

    view.gotoItem('members');

    expect(localStorage.getItem('gm_active_tab')).toBe('members');
    expect(document.getElementById('admin-members').classList.contains('active')).toBe(true);
    expect(document.getElementById('admin-home').classList.contains('active')).toBe(false);
    expect(calls.onTabActivated).toContain('admin-members');
  });

  it('honours the saved event sub-tab when navigating to events', () => {
    const { view, calls } = boot('guild_admin');
    view.init();

    localStorage.setItem('gm_active_event_tab', 'event-gvg');
    view.gotoItem('events');

    expect(document.getElementById('event-gvg').classList.contains('active')).toBe(true);
    expect(document.getElementById('event-svs').classList.contains('active')).toBe(false);
    expect(calls.onTabActivated).toContain('event-gvg');
  });

  it('ignores unknown item ids', () => {
    const { view, calls } = boot('guild_admin');
    view.init();
    const before = calls.onTabActivated.length;
    view.gotoItem('does-not-exist');
    expect(localStorage.getItem('gm_active_tab')).not.toBe('does-not-exist');
    expect(calls.onTabActivated.length).toBe(before);
  });
});

describe('ShellView — nav visibility matrix', () => {
  it('member: no super-admin items and no donation item', () => {
    const { view } = boot('member');
    view.init();
    const ids = sidebarIds();
    expect(ids).toEqual(expect.arrayContaining(['overview', 'members', 'accounts']));
    expect(ids).not.toContain('superadmin-accounts');
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('tickets');
    expect(ids).not.toContain('subscription');
  });

  it('guild_admin & server_admin: donation visible, super-admin items hidden', () => {
    const { view } = boot('guild_admin');
    view.init();
    let ids = sidebarIds();
    expect(ids).toContain('subscription');
    expect(ids).not.toContain('settings');

    window.GM.roleFromStorage = () => 'server_admin';
    window.GM.isServerAdmin = () => true;
    view.renderSidebar();
    ids = sidebarIds();
    expect(ids).toContain('subscription');
    expect(ids).not.toContain('settings');
  });

  it('super_admin: sees every section including super-admin items and donation', () => {
    const { view } = boot('super_admin');
    view.init();
    const ids = sidebarIds();
    expect(ids).toEqual(expect.arrayContaining([
      'superadmin-accounts', 'settings', 'tickets', 'subscription', 'leader-hall'
    ]));
  });

  it('isPaymentsDisabled() hides the donation item for an admin', () => {
    const { view } = boot('super_admin', { paymentsDisabled: true });
    view.init();
    const ids = sidebarIds();
    expect(ids).not.toContain('subscription');
    // The rest still renders.
    expect(ids).toContain('settings');
  });
});

describe('ShellView — lazy module registry', () => {
  it('clicking the report-bug button opens the modal only for admins', () => {
    const memberBoot = boot('member');
    memberBoot.view.init();
    expect(document.querySelector('[data-gm-sidebar] [data-gm-report-bug]')).toBeNull();

    const adminBoot = boot('guild_admin');
    adminBoot.view.init();
    const btn = document.querySelector('[data-gm-sidebar] [data-gm-report-bug]');
    expect(btn).toBeTruthy();
    btn.click();
    expect(document.getElementById('bug-report-modal')).toBeTruthy();
  });
});

describe('ShellView — destroy() cleanup', () => {
  it('stops the 30s interval after destroy()', () => {
    vi.useFakeTimers();
    const { view } = boot('guild_admin');
    view.init();

    const spy = vi.spyOn(view, 'renderTopbar');
    vi.advanceTimersByTime(30000);
    expect(spy).toHaveBeenCalled();

    spy.mockClear();
    view.destroy();
    vi.advanceTimersByTime(90000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('disconnects the tab MutationObserver after destroy()', async () => {
    const { view } = boot('guild_admin');
    view.init();

    const spy = vi.spyOn(view, 'renderSidebar');
    view.destroy();

    document.getElementById('admin-home').classList.remove('active');
    document.getElementById('admin-members').classList.add('active');
    await tick();

    expect(spy).not.toHaveBeenCalled();
  });
});
