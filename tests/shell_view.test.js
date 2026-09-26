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
  </div>`;

let views = [];

function installGM(role) {
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
  window.GM_OVERVIEW = { load: vi.fn() };
  window.GM_SHADOWFRONT = { load: vi.fn() };
  window.GM_ARMSRACE = { load: vi.fn() };
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
  const calls = installGM(role);
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
  delete window.GM_OVERVIEW;
  delete window.GM_SHADOWFRONT;
  delete window.GM_ARMSRACE;
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
    expect(NAV_ITEMS.find((i) => i.id === 'subscription')).toBeUndefined();

    const { view } = boot('super_admin');
    view.init();
    expect(window.GM_SHELL).toBeUndefined();
  });
});

describe('ShellView — renderShell()', () => {
  it('wraps the dashboard and renders sidebar, topbar, bottom-nav and drawer', () => {
    const { view } = boot('guild_admin');
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
  });

  it('renders the app version above Terms & Conditions in the sidebar footer', () => {
    const { view } = boot('guild_admin');
    view.init();
    const footer = document.querySelector('[data-gm-sidebar] .gm-sidebar-legal-footer');
    expect(footer).toBeTruthy();
    expect(footer.querySelector('.gm-app-version').textContent).toBe('V-test');
    expect(footer.querySelector('.gm-sidebar-legal-link')).toBeTruthy();
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
  it('member: no super-admin items', () => {
    const { view } = boot('member');
    view.init();
    const ids = sidebarIds();
    expect(ids).toEqual(expect.arrayContaining(['overview', 'members', 'accounts']));
    expect(ids).not.toContain('superadmin-accounts');
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('tickets');
  });

  it('guild_admin & server_admin: super-admin items hidden', () => {
    const { view } = boot('guild_admin');
    view.init();
    let ids = sidebarIds();
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('superadmin-accounts');

    window.GM.roleFromStorage = () => 'server_admin';
    window.GM.isServerAdmin = () => true;
    view.renderSidebar();
    ids = sidebarIds();
    expect(ids).not.toContain('settings');
    expect(ids).not.toContain('superadmin-accounts');
  });

  it('super_admin: sees super-admin items', () => {
    const { view } = boot('super_admin');
    view.init();
    const ids = sidebarIds();
    expect(ids).toEqual(expect.arrayContaining([
      'superadmin-accounts', 'tickets'
    ]));
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
  it('leaves no periodic re-render running (Phase 1 removed the subscription countdown)', () => {
    vi.useFakeTimers();
    const { view } = boot('guild_admin');
    view.init();

    const spy = vi.spyOn(view, 'renderTopbar');
    vi.advanceTimersByTime(300000);
    expect(spy, 'the sidebar/topbar must not rebuild on a timer').not.toHaveBeenCalled();

    view.destroy();
    vi.advanceTimersByTime(300000);
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
