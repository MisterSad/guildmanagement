/**
 * src/modules/shell/views/ShellView.ts
 *
 * Strangler Phase 1 port of the legacy root `shell.js` (1,056 lines) to a
 * strict-TypeScript view module. This file is NOT bridged onto `window.GM_SHELL`
 * during Phase 1 (the legacy script still owns that global until cutover): it is
 * exercised by `tests/shell_view.test.js`.
 *
 * Architecture:
 *   - All `window.GM.*`, `window.currentGuild`, `window.guildsList`,
 *     `window.guildsData`, `window.GM_APP.*` reads happen at call time through
 *     an internal typed adapter (no capture at module load).
 *   - The sibling modules driven lazily (GM_OVERVIEW, GM_SHADOWFRONT,
 *     GM_ARMSRACE)
 *     are resolved through a lazy registry, at call time, behind the same
 *     `if (module && module.load)` guards — none of them is imported or
 *     required to migrate.
 *   - Side effects (MutationObserver, matchMedia listener, 30s setInterval) are
 *     tracked so `destroy()` can clean them up (no jsdom leaks).
 *   - This module never assigns any `window.GM_*` variable.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ShellRole = 'member' | 'guild_admin' | 'server_admin' | 'super_admin' | string;

export type ShellSection = 'play' | 'admin' | 'superadmin' | 'footer';

export interface ShellNavItem {
  id: string;
  tabId: string;
  m3Icon: string;
  icon?: string;
  labelKey: string;
  section: ShellSection;
  adminOnly?: boolean;
  r5Only?: boolean;
  panels: string[];
}

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function gm(): any {
  return winAny().GM;
}

// ── Navigation items (verbatim from shell.js) ─────────────────────────────────
export const NAV_ITEMS: ShellNavItem[] = [
  { id: 'overview', tabId: 'gm-overview', m3Icon: 'dashboard', icon: 'ph-squares-four', labelKey: 'gm_nav_overview', section: 'play', panels: ['gm-overview'] },
  { id: 'members', tabId: 'admin-members', m3Icon: 'group', icon: 'ph-users', labelKey: 'gm_nav_members', section: 'play', panels: ['admin-members'] },
  { id: 'events', tabId: 'event-svs', m3Icon: 'swords', icon: 'ph-sword', labelKey: 'gm_nav_events', section: 'play',
    panels: ['event-svs', 'event-gvg', 'event-shadowfront', 'event-dtr', 'event-arms-race'] },
  { id: 'glory', tabId: 'event-glory', m3Icon: 'trophy', icon: 'ph-trophy', labelKey: 'gm_nav_glory', section: 'play', panels: ['event-glory'] },
  { id: 'history', tabId: 'event-history', m3Icon: 'history', icon: 'ph-clock-counter-clockwise', labelKey: 'gm_nav_history', section: 'play', panels: ['event-history'] },
  { id: 'stats', tabId: 'stats-admin', m3Icon: 'leaderboard', icon: 'ph-chart-bar', labelKey: 'gm_nav_stats', section: 'play', panels: ['stats-admin'] },

  { id: 'migration-hub', tabId: 'admin-migration-hub', m3Icon: 'hub', icon: 'ph-arrows-left-right', labelKey: 'gm_nav_migration_hub', section: 'admin', adminOnly: true, panels: ['admin-migration-hub'] },
  { id: 'accounts', tabId: 'admin-home', m3Icon: 'manage_accounts', icon: 'ph-key', labelKey: 'gm_nav_accounts', section: 'admin', panels: ['admin-home'] },
  { id: 'discord', tabId: 'admin-discord', m3Icon: 'notifications', icon: 'ph-bell-ringing', labelKey: 'gm_nav_discord', section: 'admin', panels: ['admin-discord'] },
  { id: 'sanctions', tabId: 'tab-sanctions', m3Icon: 'gavel', icon: 'ph-warning-octagon', labelKey: 'gm_nav_sanctions', section: 'admin', panels: ['tab-sanctions'] },
  { id: 'banned', tabId: 'admin-banned', m3Icon: 'block', icon: 'ph-prohibit', labelKey: 'gm_nav_banned', section: 'admin', panels: ['admin-banned'] },

  { id: 'superadmin-accounts', tabId: 'admin-superadmin', m3Icon: 'admin_panel_settings', icon: 'ph-shield-check', labelKey: 'gm_nav_superadmin_accounts', section: 'superadmin', r5Only: true, panels: ['admin-superadmin'] },
  { id: 'tickets', tabId: 'tab-tickets', m3Icon: 'confirmation_number', icon: 'ph-ticket', labelKey: 'gm_nav_tickets', section: 'superadmin', r5Only: true, panels: ['tab-tickets'] }
];

export const BREAKPOINT_MOBILE = 900;

const EVENT_TABS = [
  { id: 'event-svs', m3Icon: 'rocket_launch', icon: 'ph-sword', label: 'SvS', colorVar: 'var(--gm-event-svs)' },
  { id: 'event-gvg', m3Icon: 'swords', icon: 'ph-flag-banner', label: 'GvG', colorVar: 'var(--gm-event-gvg)' },
  { id: 'event-shadowfront', m3Icon: 'radar', icon: 'ph-ghost', label: 'Shadowfront', colorVar: 'var(--gm-event-shadowfront)' },
  { id: 'event-dtr', m3Icon: 'local_shipping', icon: 'ph-truck', label: 'DTR', colorVar: 'var(--gm-event-dtr)' },
  { id: 'event-arms-race', m3Icon: 'bolt', icon: 'ph-crosshair', label: 'Arms Race', colorVar: 'var(--gm-event-armsrace)' }
];

// ── Legacy adapter (call-time reads, no writes) ───────────────────────────────

import { escapeHTML } from '../../../core/utils/text';

const legacy = {
  t(key: string): string {
    const g = gm();
    return g && typeof g.t === 'function' ? g.t(key) : key;
  },
  esc(value: unknown): string {
    return escapeHTML(value);
  },
  roleFromStorage(): ShellRole {
    const g = gm();
    return g && typeof g.roleFromStorage === 'function' ? g.roleFromStorage() : 'member';
  },
  isSuperAdmin(): boolean {
    const g = gm();
    return !!(g && typeof g.isSuperAdmin === 'function' && g.isSuperAdmin());
  },
  isServerAdmin(): boolean {
    const g = gm();
    return !!(g && typeof g.isServerAdmin === 'function' && g.isServerAdmin());
  },
  isGuildAdmin(): boolean {
    const g = gm();
    return !!(g && typeof g.isGuildAdmin === 'function' && g.isGuildAdmin());
  },
  avatarInit(value: string): string {
    const g = gm();
    return g && typeof g.avatarInit === 'function' ? g.avatarInit(value) : String(value || '').slice(0, 1).toUpperCase();
  },
  appVersion(): string {
    const g = gm();
    return g && g.appVersion ? String(g.appVersion) : '';
  },
  detectClientEnvironment(): any {
    const g = gm();
    if (g && typeof g.detectClientEnvironment === 'function') return g.detectClientEnvironment();
    return { appVersion: legacy.appVersion() || 'V3.5.3', os: 'Unknown OS', browser: 'Unknown Browser' };
  },
  formatTicketDescription(payload: unknown): string {
    const g = gm();
    return g && typeof g.formatTicketDescription === 'function' ? g.formatTicketDescription(payload) : '';
  },
  showToast(msg: string, type: string): void {
    const g = gm();
    if (g && typeof g.showToast === 'function') g.showToast(msg, type);
  },
  db(): any {
    const g = gm();
    return g && g.db ? g.db : null;
  },
  getCurrentGuild(): string {
    const w = winAny();
    return w.currentGuild || 'ALPHA';
  },
  setCurrentGuild(guild: string): void {
    winAny().currentGuild = guild;
  },
  getGuildsList(): string[] {
    const w = winAny();
    return Array.isArray(w.guildsList) ? w.guildsList : [];
  },
  getGuildsData(): Record<string, any> {
    const w = winAny();
    return (w.guildsData && typeof w.guildsData === 'object') ? w.guildsData : {};
  },
  guildsDataRaw(): any {
    return winAny().guildsData;
  },
  getCurrentGuildRestriction(): string | null {
    const w = winAny();
    return w.currentGuildRestriction || null;
  },
  setCurrentGuildRestriction(value: string): void {
    winAny().currentGuildRestriction = value;
  },
  appOnTabActivated(tabId: string): void {
    const app = winAny().GM_APP;
    if (app && typeof app.onTabActivated === 'function') app.onTabActivated(tabId);
  },
  appReloadActiveView(): boolean {
    const app = winAny().GM_APP;
    if (app && typeof app.reloadActiveView === 'function') {
      app.reloadActiveView();
      return true;
    }
    return false;
  },
  matchMedia(query: string): any {
    const w = winAny();
    if (typeof w.matchMedia === 'function') return w.matchMedia(query);
    return { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined };
  },
  reload(): void {
    const w = winAny();
    if (w.location && typeof w.location.reload === 'function') w.location.reload();
  }
};

// ── Lazy sibling-module registry (resolved at call time) ──────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
type LazyLoader = { load?: () => any };

export const lazyModules = {
  overview(): any { return winAny().GM_OVERVIEW; },
  shadowfront(): any { return winAny().GM_SHADOWFRONT; },
  armsrace(): any { return winAny().GM_ARMSRACE; }
};

function callLoad(mod: LazyLoader | undefined | null): void {
  if (mod && typeof mod.load === 'function') mod.load();
}

// ── Shell state ───────────────────────────────────────────────────────────────

interface ShellState {
  active: string;
  mobile: boolean;
  drawerOpen: boolean;
}

function createState(): ShellState {
  return {
    active: 'accounts',
    mobile: !!legacy.matchMedia('(max-width: ' + BREAKPOINT_MOBILE + 'px)').matches,
    drawerOpen: false
  };
}

export class ShellView {
  private state: ShellState = createState();
  private initialized = false;
  private observer?: MutationObserver;
  private mediaQuery?: any;
  private mediaQueryHandler?: (e: any) => void;

  public getState(): ShellState {
    return this.state;
  }

  // ── Bootstrap (explicit init; the production bridge calls this on DOMContentLoaded) ──
  public init(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.wrapDashboardInShell();
    this.renderShell();
    this.renderEventsTabs();
    this.observeActiveTab();
    this.observeViewport();
    this.wireLoginPasswordToggle();
    this.wireSearchClearButtons();
  }

  /** Release every tracked side effect (observer, matchMedia listener). */
  public destroy(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = undefined;
    }
    if (this.mediaQuery && this.mediaQueryHandler) {
      if (typeof this.mediaQuery.removeEventListener === 'function') {
        this.mediaQuery.removeEventListener('change', this.mediaQueryHandler);
      } else if (typeof this.mediaQuery.removeListener === 'function') {
        this.mediaQuery.removeListener(this.mediaQueryHandler);
      }
    }
    this.mediaQuery = undefined;
    this.mediaQueryHandler = undefined;
    this.initialized = false;
  }

  // ── Visibility ────────────────────────────────────────────────────────────
  public visibleNavItems(): ShellNavItem[] {
    const role = this.getUserRole();
    const items: ShellNavItem[] = [];
    NAV_ITEMS.forEach((i) => {
      if (i.r5Only && role !== 'super_admin') return;
      // adminOnly means "any admin-side role, not a member" — exclude by role
      // instead of allowlisting roles (regression guard: server_admin was
      // silently excluded by the old allowlist).
      if (i.adminOnly && role === 'member') return;
      items.push(Object.assign({}, i));
    });
    return items;
  }

  // ── Events tabs-pill ──────────────────────────────────────────────────────
  private renderEventsTabs(): void {
    document.querySelectorAll('[data-gm-events-tabs]').forEach((slot) => {
      const ownerPanel = slot.closest('.tab-panel');
      const ownerId = ownerPanel ? ownerPanel.id : '';
      let html = '<div class="gm-tabs-pill" style="margin-bottom:1rem; flex-wrap:nowrap; overflow-x:auto;">';
      EVENT_TABS.forEach((e) => {
        const active = e.id === ownerId;
        const phIcon = e.icon || 'ph-sword';
        const iconStyle = active ? ('style="color:' + e.colorVar + '; font-size: var(--fs-xl); margin-right:0.35rem; vertical-align:middle;"') : 'style="font-size: var(--fs-xl); margin-right:0.35rem; vertical-align:middle;"';
        html += '<button class="gm-tab-pill' + (active ? ' gm-active' : '') + '" data-gm-event-tab="' + e.id + '">' +
          '<i class="ph ' + phIcon + ' gm-icon" ' + iconStyle + '></i> ' + e.label +
        '</button>';
      });
      html += '</div>';
      slot.innerHTML = html;
      slot.querySelectorAll('[data-gm-event-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const tabId = btn.getAttribute('data-gm-event-tab') || '';
          localStorage.setItem('gm_active_event_tab', tabId);

          const dashboard = document.getElementById('dashboard-view');
          if (dashboard) {
            dashboard.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
            const panel = document.getElementById(tabId);
            if (panel) panel.classList.add('active');
          }

          this.renderEventsTabs();

          if (tabId === 'event-arms-race') {
            callLoad(lazyModules.armsrace());
          } else if (tabId === 'event-shadowfront') {
            callLoad(lazyModules.shadowfront());
          }

          legacy.appOnTabActivated(tabId);
        });
      });
    });
  }

  // ── Login password toggle ─────────────────────────────────────────────────
  private wireLoginPasswordToggle(): void {
    document.querySelectorAll('[data-gm-pwd-toggle]').forEach((btn) => {
      const wrap = btn.closest('.gm-input-with-icon');
      const input = (wrap ? wrap.querySelector('input[type="password"], input[type="text"]') : null) as HTMLInputElement | null;
      if (!input) return;
      btn.addEventListener('click', () => {
        const isPwd = input.type === 'password';
        input.type = isPwd ? 'text' : 'password';
        const icon = btn.querySelector('i');
        if (icon) icon.className = isPwd ? 'ph ph-eye-slash' : 'ph ph-eye';
      });
    });
  }

  // ── Search clear buttons (delegated) ──────────────────────────────────────
  private wireSearchClearButtons(): void {
    document.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement | null;
      if (!input || input.tagName !== 'INPUT') return;
      const wrap = input.closest('.gm-input-with-icon, .input-wrapper, .search-wrapper, .ocr-filter-bar') || input.parentElement;
      if (!wrap) return;
      const clearBtn = wrap.querySelector('[data-gm-search-clear], .gm-search-clear-btn');
      if (!clearBtn) return;
      if (input.value && input.value.trim().length > 0) {
        clearBtn.classList.add('gm-visible');
      } else {
        clearBtn.classList.remove('gm-visible');
      }
    });

    document.addEventListener('click', (e) => {
      const target = e.target as Element | null;
      const btn = target ? target.closest('[data-gm-search-clear], .gm-search-clear-btn') : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const wrap = btn.closest('.gm-input-with-icon, .input-wrapper, .search-wrapper, .ocr-filter-bar') || btn.parentElement;
      const input = (wrap ? wrap.querySelector('input') : null) as HTMLInputElement | null;
      if (!input) return;
      input.value = '';
      btn.classList.remove('gm-visible');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
    });
  }

  // ── Wrap existing panels into the shell structure ─────────────────────────
  private wrapDashboardInShell(): void {
    const dashboard = document.getElementById('dashboard-view');
    if (!dashboard || dashboard.querySelector('.gm-shell')) return;

    const panels = Array.from(dashboard.querySelectorAll(':scope > .dashboard-content.tab-panel'));

    const shell = document.createElement('div');
    shell.className = 'gm-shell';
    shell.innerHTML =
      '<aside class="gm-sidebar" data-gm-sidebar></aside>' +
      '<div class="gm-main">' +
        '<header class="gm-topbar" data-gm-topbar></header>' +
        '<div class="gm-content" data-gm-content></div>' +
      '</div>' +
      '<nav class="gm-bottom-nav" data-gm-bottom-nav></nav>' +
      '<div class="gm-drawer-backdrop" data-gm-drawer-backdrop></div>' +
      '<div class="gm-drawer" data-gm-drawer></div>';

    dashboard.appendChild(shell);

    const content = shell.querySelector('[data-gm-content]') as HTMLElement;
    panels.forEach((p) => { content.appendChild(p); });

    if (!document.getElementById('gm-overview')) {
      const ov = document.createElement('main');
      ov.className = 'dashboard-content tab-panel';
      ov.id = 'gm-overview';
      ov.innerHTML =
        '<div class="gm-page">' +
          '<header class="gm-page-header">' +
            '<div>' +
              '<h1 class="gm-page-title">' + legacy.t('gm_overview_title') + '</h1>' +
              '<p class="gm-page-subtitle">' + legacy.t('gm_overview_sub') + '</p>' +
            '</div>' +
          '</header>' +
          '<div class="gm-empty">' +
            '<i class="ph ph-rocket-launch gm-icon"></i>' +
            '<div class="gm-empty-title">' + legacy.t('gm_overview_soon') + '</div>' +
            '<div class="gm-empty-hint">' + legacy.t('gm_overview_soon_hint') + '</div>' +
          '</div>' +
        '</div>';
      content.appendChild(ov);
    }

    const legacyNav = dashboard.querySelector('.app-header .nav-tabs');
    if (legacyNav && !legacyNav.querySelector('[data-tab="gm-overview"]')) {
      const btn = document.createElement('button');
      btn.className = 'nav-tab';
      btn.setAttribute('data-tab', 'gm-overview');
      btn.setAttribute('data-view', 'dashboard-view');
      btn.style.display = 'none';
      legacyNav.insertBefore(btn, legacyNav.firstChild);

      btn.addEventListener('click', () => {
        dashboard.querySelectorAll('.nav-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        dashboard.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        const panel = document.getElementById('gm-overview');
        if (panel) panel.classList.add('active');
        callLoad(lazyModules.overview());
      });
    }
  }

  // ── Full shell render ─────────────────────────────────────────────────────
  public renderShell(): void {
    this.renderSidebar();
    this.renderTopbar();
    this.renderBottomNav();
    this.renderDrawer();
  }

  // ── User helpers ──────────────────────────────────────────────────────────
  private getUserName(): string {
    return localStorage.getItem('gm_user') || 'Membre';
  }
  private getUserRole(): ShellRole {
    return legacy.roleFromStorage() || 'member';
  }
  private getUserRoleLong(): string {
    const r = this.getUserRole();
    if (r === 'super_admin') return 'Super Admin';
    if (winAny().currentGuildRestriction) {
      return 'Admin ' + winAny().currentGuildRestriction;
    }
    return 'Admin';
  }

  private renderGuildSelectorHtml(): string {
    const isSuperAdmin = legacy.isSuperAdmin();
    let guilds = legacy.getGuildsList();
    const restriction = legacy.getCurrentGuildRestriction();
    const guildsData = legacy.getGuildsData();
    if (restriction) {
      guilds = [restriction];
      legacy.setCurrentGuild(restriction);
      localStorage.setItem('gm_current_guild', restriction);
    }

    if (isSuperAdmin && !restriction) {
      const guildOptions = guilds.map((g) => {
        const sVal = (guildsData[g] && guildsData[g].server_number) ? String(guildsData[g].server_number).replace(/^#+/, '') : '';
        const sNum = sVal ? ' (#' + legacy.esc(sVal) + ')' : '';
        return '<option value="' + legacy.esc(g) + '"' + (legacy.getCurrentGuild() === g ? ' selected' : '') + '>' + legacy.esc(g) + sNum + '</option>';
      }).join('');
      return '<div class="gm-sidebar-guild-select-wrapper">' +
        '<select class="gm-sidebar-guild-select" data-gm-guild-select>' +
          guildOptions +
        '</select>' +
      '</div>';
    } else {
      const displayGuild = restriction || legacy.getCurrentGuild() || 'ALPHA';
      const sVal = (guildsData[displayGuild] && guildsData[displayGuild].server_number) ? String(guildsData[displayGuild].server_number).replace(/^#+/, '') : '';
      const sNum = sVal ? ' #' + legacy.esc(sVal) : '';
      return '<div class="gm-sidebar-guild-badge">' + legacy.esc(displayGuild) + sNum + '</div>';
    }
  }

  /**
   * Sidebar guild card. Phase 1 removed the subscription pill it used to carry
   * (plan label, expiry countdown, Premium/Lifetime tiers): the platform is
   * free and `guilds.subscription_type` no longer exists. The guild selector
   * inside it is load-bearing -- it is how a super_admin switches tenant.
   */
  private getGuildCardHtml(): string {
    return '<div class="gm-sidebar-sub-card">' + this.renderGuildSelectorHtml() + '</div>';
  }

  public renderSidebar(): void {
    const el = document.querySelector('[data-gm-sidebar]');
    if (!el) return;

    const canReportBug = legacy.isGuildAdmin();

    const visible = this.visibleNavItems();
    const playItems = visible.filter((i) => i.section === 'play');
    const adminItems = visible.filter((i) => i.section === 'admin');
    const superAdminItems = visible.filter((i) => i.section === 'superadmin');
    const footerItems = visible.filter((i) => i.section === 'footer');

    const userAvatarInitials = legacy.esc(legacy.avatarInit(this.getUserName()));

    let navHtml = '';
    if (playItems.length > 0) {
      navHtml += '<div class="gm-nav-section-label">' + legacy.t('gm_nav_play') + '</div>' +
        playItems.map((i) => this.navItemHtml(i)).join('');
    }
    if (adminItems.length > 0) {
      navHtml += '<div class="gm-nav-section-label">' + legacy.t('gm_nav_admin') + '</div>' +
        adminItems.map((i) => this.navItemHtml(i)).join('');
    }
    if (superAdminItems.length > 0) {
      navHtml += '<div class="gm-nav-section-label">' + legacy.t('gm_nav_superadmin') + '</div>' +
        superAdminItems.map((i) => this.navItemHtml(i)).join('');
    }

    const html =
      '<div class="gm-sidebar-header">' +
        '<div class="gm-sidebar-user-row">' +
          '<div class="gm-user-avatar-ring">' +
            '<div class="gm-user-avatar">' + userAvatarInitials + '</div>' +
          '</div>' +
          '<div class="gm-sidebar-user-info">' +
            '<div class="gm-sidebar-user-name">' + legacy.esc(this.getUserName()) + '</div>' +
            '<div class="gm-sidebar-user-role">' + this.getUserRoleLong() + '</div>' +
          '</div>' +
          '<button class="gm-sidebar-logout" data-gm-logout title="' + legacy.t('nav_logout_title') + '">' +
            '<i class="ph ph-sign-out"></i>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<nav class="gm-sidebar-nav">' +
        navHtml +
      '</nav>' +
      this.getGuildCardHtml() +
      footerItems.map((item) => {
        return '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm gm-sidebar-report-bug" data-gm-nav-item="' + item.id + '">' +
          '<i class="ph ' + (item.icon || 'ph-circle') + '" style="font-size: var(--fs-xl);"></i>' +
          '<span>' + legacy.t(item.labelKey) + '</span>' +
        '</button>';
      }).join('') +
      (canReportBug
        ? '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm gm-sidebar-report-bug" data-gm-report-bug>' +
            '<i class="ph ph-bug" style="font-size: var(--fs-xl);"></i>' +
            '<span>' + legacy.t('ticket_report_bug') + '</span>' +
          '</button>'
        : '') +
      '<div class="gm-sidebar-legal-footer">' +
        '<div class="gm-app-version">' + legacy.esc(legacy.appVersion()) + '</div>' +
        '<a href="terms.html" class="gm-sidebar-legal-link" data-i18n="footer_terms">Terms &amp; Conditions</a>' +
      '</div>';

    el.innerHTML = html;

    el.querySelectorAll('[data-gm-nav-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.gotoItem(btn.getAttribute('data-gm-nav-item') || '');
      });
    });

    const rb = el.querySelector('[data-gm-report-bug]');
    if (rb) rb.addEventListener('click', () => this.openBugReportModal());

    const gSel = el.querySelector('[data-gm-guild-select]') as HTMLSelectElement | null;
    if (gSel) {
      gSel.addEventListener('change', () => {
        const newGuild = gSel.value;
        localStorage.setItem('gm_current_guild', newGuild);
        legacy.setCurrentGuild(newGuild);
        this.renderSidebar();
        this.renderTopbar();
        if (!legacy.appReloadActiveView()) legacy.reload();
      });
    }

    const lo = el.querySelector('[data-gm-logout]');
    if (lo) {
      lo.addEventListener('click', () => {
        const legacyBtn = document.getElementById('logout-btn');
        if (legacyBtn) legacyBtn.click();
      });
    }
  }

  private navItemHtml(item: ShellNavItem): string {
    const isActive = this.state.active === item.id;
    const label = legacy.t(item.labelKey);
    const phIcon = item.icon || 'ph-circle';

    return '<button class="gm-nav-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + item.id + '">' +
        '<i class="ph ' + phIcon + ' gm-icon"></i>' +
        '<span>' + label + '</span>' +
      '</button>';
  }

  public renderTopbar(): void {
    const el = document.querySelector('[data-gm-topbar]');
    if (!el) return;

    const brandHtml = this.state.mobile
      ? '<div class="gm-topbar-mobile-brand">' +
          '<div class="gm-brand-mark">FGF</div>' +
        '</div>'
      : '<div class="gm-topbar-brand"></div>';

    const isSuperAdmin = legacy.isSuperAdmin();
    const isServerAdmin = legacy.isServerAdmin();
    const serverRestriction = localStorage.getItem('gm_server_restriction');

    let guilds = legacy.getGuildsList();
    const guildsDataRaw = legacy.guildsDataRaw();
    const restriction = legacy.getCurrentGuildRestriction();
    if (restriction) {
      guilds = [restriction];
      legacy.setCurrentGuild(restriction);
      localStorage.setItem('gm_current_guild', restriction);
    } else if (isServerAdmin && serverRestriction && guildsDataRaw) {
      const guildsData = guildsDataRaw as Record<string, any>;
      guilds = guilds.filter((g) => {
        return guildsData[g] && String(guildsData[g].server_number) === String(serverRestriction);
      });
      if (guilds.length > 0 && guilds.indexOf(legacy.getCurrentGuild()) === -1) {
        legacy.setCurrentGuild(guilds[0]);
        localStorage.setItem('gm_current_guild', guilds[0]);
      }
    }
    const guildOptions = guilds.map((g) => {
      return '<option value="' + legacy.esc(g) + '"' + (legacy.getCurrentGuild() === g ? ' selected' : '') + '>' + legacy.esc(g) + '</option>';
    }).join('');

    const selectStyle = (isSuperAdmin || (isServerAdmin && guilds.length > 1))
      ? 'padding: 0.35rem 0.8rem; font-size: var(--fs-base); font-weight: 600; border-radius: 6px; background: var(--bg-soft); border: 1px solid var(--border-soft); color: var(--text-main); cursor: pointer; outline: none; transition: border-color 0.2s;'
      : 'display: none; padding: 0.35rem 0.8rem; font-size: var(--fs-base); font-weight: 600; border-radius: 6px; background: var(--bg-soft); border: 1px solid var(--border-soft); color: var(--text-main); cursor: pointer; outline: none; transition: border-color 0.2s;';

    const canReportBug = legacy.isGuildAdmin();

    const html = brandHtml +
      '<div class="gm-topbar-actions">' +
        '<select id="guild-selector" class="gm-select" style="' + selectStyle + '">' +
          guildOptions +
        '</select>' +
        (canReportBug
          ? '<button class="gm-btn gm-btn-ghost gm-btn-sm" data-gm-report-bug title="' + legacy.t('ticket_report_bug') + '" style="gap:0.3rem;">' +
              '<i class="ph ph-bug" style="font-size: var(--fs-lg);"></i>' +
              '<span class="gm-report-bug-label" style="font-size: var(--fs-sm); font-weight:600;">' + legacy.t('ticket_report_bug') + '</span>' +
            '</button>'
          : '') +
        '<button class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm" data-gm-logout title="' + legacy.t('nav_logout_title') + '">' +
          '<i class="ph ph-sign-out"></i>' +
        '</button>' +
      '</div>';
    el.innerHTML = html;

    const gs = el.querySelector('#guild-selector') as HTMLSelectElement | null;
    if (gs) {
      gs.addEventListener('change', () => {
        const newGuild = gs.value;
        localStorage.setItem('gm_current_guild', newGuild);
        legacy.setCurrentGuild(newGuild);

        this.renderSidebar();
        this.renderTopbar();

        if (!legacy.appReloadActiveView()) legacy.reload();
      });
    }

    const lo = el.querySelector('[data-gm-logout]');
    if (lo) lo.addEventListener('click', () => {
      const legacyBtn = document.getElementById('logout-btn');
      if (legacyBtn) legacyBtn.click();
    });

    const rb = el.querySelector('[data-gm-report-bug]');
    if (rb) rb.addEventListener('click', () => this.openBugReportModal());
  }

  // ── Bug-report ticket modal ───────────────────────────────────────────────
  public openBugReportModal(): void {
    if (!legacy.isGuildAdmin()) return;
    if (document.getElementById('bug-report-modal')) return;

    const esc = (v: unknown) => legacy.esc(v);
    const t_ = (k: string) => legacy.t(k);
    const env = legacy.detectClientEnvironment();

    const overlay = document.createElement('div');
    overlay.className = 'gm-modal-overlay visible';
    overlay.id = 'bug-report-modal';
    overlay.innerHTML = this.bugReportModalHtml(esc, t_, env);

    document.body.appendChild(overlay);

    const attachedScreenshots: string[] = [];

    const renderScreenshots = () => {
      const countEl = overlay.querySelector('#ticket-screenshots-count');
      if (countEl) countEl.textContent = String(attachedScreenshots.length);
      const previewEl = overlay.querySelector('#ticket-screenshots-preview');
      if (!previewEl) return;
      previewEl.innerHTML = '';
      attachedScreenshots.forEach((dataUrl, idx) => {
        const item = document.createElement('div');
        item.style.cssText = 'position:relative; width:80px; height:60px; border-radius:6px; overflow:hidden; border:1px solid var(--border-soft); background:#000; display:inline-block;';
        item.innerHTML =
          '<img src="' + dataUrl + '" style="width:100%; height:100%; object-fit:cover;">' +
          '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon" data-remove="' + idx + '" style="position:absolute; top:2px; right:2px; width:20px; height:20px; min-width:20px; background:rgba(0,0,0,0.7); border-radius:999px; color:#fff; padding:0; line-height:1; font-size: var(--fs-sm);" title="Remove">×</button>';
        const removeBtn = item.querySelector('[data-remove]');
        if (removeBtn) {
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            attachedScreenshots.splice(idx, 1);
            renderScreenshots();
          });
        }
        previewEl.appendChild(item);
      });
    };

    const handleFiles = async (files: FileList | File[] | null | undefined): Promise<void> => {
      if (!files || files.length === 0) return;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f.type || !f.type.startsWith('image/')) continue;
        if (attachedScreenshots.length >= 3) {
          legacy.showToast(t_('ticket_screenshots_max_err'), 'error');
          break;
        }
        try {
          const gmAny = gm();
          const dataUrl = (gmAny && typeof gmAny.compressImageForUpload === 'function')
            ? await gmAny.compressImageForUpload(f, 1280, 0.82)
            : await new Promise((res) => { const r = new FileReader(); r.onload = () => { res(r.result); }; r.readAsDataURL(f); });
          attachedScreenshots.push(String(dataUrl));
          renderScreenshots();
        } catch (err) {
          console.warn('Screenshot upload error', err);
        }
      }
    };

    const dropzone = overlay.querySelector('#ticket-dropzone') as HTMLElement | null;
    const fileInput = overlay.querySelector('#ticket-file-input') as HTMLInputElement | null;
    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => { fileInput.click(); });
      fileInput.addEventListener('change', () => {
        void handleFiles(fileInput.files);
        fileInput.value = '';
      });
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--accent)';
        dropzone.style.background = 'rgba(255,255,255,0.06)';
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.style.borderColor = 'var(--border-soft)';
        dropzone.style.background = 'rgba(255,255,255,0.02)';
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--border-soft)';
        dropzone.style.background = 'rgba(255,255,255,0.02)';
        const de = e as DragEvent;
        if (de.dataTransfer && de.dataTransfer.files) {
          void handleFiles(de.dataTransfer.files);
        }
      });
    }

    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData || !e.clipboardData.items) return;
      const items = e.clipboardData.items;
      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.startsWith('image/')) {
          const blob = items[i].getAsFile();
          if (blob) imageFiles.push(blob);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        void handleFiles(imageFiles);
      }
    };
    window.addEventListener('paste', onPaste);

    const close = () => {
      window.removeEventListener('paste', onPaste);
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    overlay.querySelectorAll('.bug-report-close').forEach((b) => { b.addEventListener('click', close); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const submit = overlay.querySelector('#bug-report-submit') as HTMLButtonElement | null;
    if (submit) {
      submit.addEventListener('click', async () => {
        const titleEl = overlay.querySelector('#ticket-title') as HTMLInputElement;
        const categoryEl = overlay.querySelector('#ticket-category') as HTMLSelectElement;
        const severityEl = overlay.querySelector('#ticket-severity') as HTMLSelectElement;
        const currentEl = overlay.querySelector('#ticket-current-behavior') as HTMLTextAreaElement;
        const expectedEl = overlay.querySelector('#ticket-expected-behavior') as HTMLTextAreaElement;
        const stepsEl = overlay.querySelector('#ticket-steps') as HTMLTextAreaElement;
        const additionalEl = overlay.querySelector('#ticket-additional-context') as HTMLTextAreaElement;
        const msgEl = overlay.querySelector('#bug-report-msg') as HTMLElement | null;

        const title = (titleEl.value || '').trim();
        const category = categoryEl.value;
        const severity = severityEl.value;
        const currentBehavior = (currentEl.value || '').trim();
        const expectedBehavior = (expectedEl.value || '').trim();
        const steps = (stepsEl.value || '').trim();
        const additionalContext = (additionalEl.value || '').trim();

        if (!title || !currentBehavior || !expectedBehavior) {
          if (msgEl) {
            msgEl.textContent = t_('ticket_missing_fields');
            msgEl.style.color = '#ef4444';
          }
          return;
        }

        const description = ((): string => {
          const g = gm();
          if (g && typeof g.formatTicketDescription === 'function') {
            return g.formatTicketDescription({ currentBehavior, expectedBehavior, steps, additionalContext, env });
          }
          return currentBehavior + '\n\n' + expectedBehavior;
        })();

        submit.disabled = true;
        submit.innerHTML = '<i class="ph ph-arrows-clockwise" style="font-size: var(--fs-lg);"></i> ' + t_('ticket_submitting');
        if (msgEl) msgEl.textContent = '';
        try {
          const db = legacy.db();
          if (!db || !db.functions) throw new Error('db unavailable');
          const res = await db.functions.invoke('tickets', {
            body: {
              action: 'create',
              title,
              description,
              category,
              severity,
              current_behavior: currentBehavior,
              expected_behavior: expectedBehavior,
              steps,
              additional_context: additionalContext,
              env,
              attachments: attachedScreenshots
            }
          });
          const data = res && res.data;
          if (!data || !data.ok) {
            throw new Error((data && data.error) || 'request_failed');
          }
          const num = String(data.ticket_number).padStart(4, '0');
          if (msgEl) {
            msgEl.textContent = t_('ticket_success') + ' #TICKET-' + num;
            msgEl.style.color = '#34d399';
          }
          legacy.showToast(t_('ticket_success') + ' #TICKET-' + num, 'success');
          setTimeout(close, 1800);
        } catch (err: any) {
          console.error('ticket submit error', err);
          if (msgEl) {
            msgEl.textContent = (err && err.message) || 'Error';
            msgEl.style.color = '#ef4444';
          }
          submit.disabled = false;
          submit.innerHTML = t_('ticket_submit');
        }
      });
    }
  }

  private bugReportModalHtml(esc: (v: unknown) => string, t_: (k: string) => string, env: any): string {
    return '<div class="gm-modal-card" style="max-width:580px; width:94%; max-height:90vh; overflow-y:auto; text-align:left;">' +
        '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.9rem; position:sticky; top:0; background:var(--bg-card); z-index:2; padding-bottom:0.4rem; border-bottom:1px solid var(--border-soft);">' +
          '<div style="display:flex; align-items:center; gap:0.55rem;">' +
            '<i class="ph ph-bug" style="color:var(--accent); font-size: var(--fs-2xl);"></i>' +
            '<strong style="font-size: var(--fs-xl);">' + t_('ticket_report_bug') + '</strong>' +
          '</div>' +
          '<button type="button" class="gm-btn gm-btn-ghost gm-btn-icon gm-btn-sm bug-report-close" title="Close"><i class="ph ph-x"></i></button>' +
        '</div>' +
        '<div class="gm-modal-body" style="display:flex; flex-direction:column; gap:0.85rem;">' +
          '<div class="gm-form-group">' +
            '<label class="gm-label" for="ticket-title">' + t_('ticket_title') + ' *</label>' +
            '<input type="text" id="ticket-title" class="gm-input" maxlength="120" placeholder="' + t_('ticket_title_ph') + '">' +
          '</div>' +
          '<div style="display:flex; gap:0.8rem; flex-wrap:wrap;">' +
            '<div class="gm-form-group" style="flex:1; min-width:140px;">' +
              '<label class="gm-label" for="ticket-category">' + t_('ticket_category') + '</label>' +
              '<select id="ticket-category" class="gm-select">' +
                '<option value="bug">' + t_('ticket_cat_bug') + '</option>' +
                '<option value="feature">' + t_('ticket_cat_feature') + '</option>' +
                '<option value="other">' + t_('ticket_cat_other') + '</option>' +
              '</select>' +
            '</div>' +
            '<div class="gm-form-group" style="flex:1; min-width:140px;">' +
              '<label class="gm-label" for="ticket-severity">' + t_('ticket_severity') + '</label>' +
              '<select id="ticket-severity" class="gm-select">' +
                '<option value="low">' + t_('ticket_sev_low') + '</option>' +
                '<option value="medium" selected>' + t_('ticket_sev_medium') + '</option>' +
                '<option value="high">' + t_('ticket_sev_high') + '</option>' +
                '<option value="critical">' + t_('ticket_sev_critical') + '</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<div class="gm-form-group">' +
            '<label class="gm-label" for="ticket-current-behavior">' + t_('ticket_current_behavior') + ' *</label>' +
            '<textarea id="ticket-current-behavior" class="gm-input" rows="3" maxlength="2000" placeholder="' + t_('ticket_current_behavior_ph') + '" style="resize:vertical; min-height:75px;"></textarea>' +
          '</div>' +
          '<div class="gm-form-group">' +
            '<label class="gm-label" for="ticket-expected-behavior">' + t_('ticket_expected_behavior') + ' *</label>' +
            '<textarea id="ticket-expected-behavior" class="gm-input" rows="3" maxlength="2000" placeholder="' + t_('ticket_expected_behavior_ph') + '" style="resize:vertical; min-height:75px;"></textarea>' +
          '</div>' +
          '<div class="gm-form-group">' +
            '<label class="gm-label" for="ticket-steps">' + t_('ticket_steps') + '</label>' +
            '<textarea id="ticket-steps" class="gm-input" rows="3" maxlength="2000" placeholder="' + t_('ticket_steps_ph') + '" style="resize:vertical; min-height:70px;"></textarea>' +
          '</div>' +
          '<div class="gm-form-group">' +
            '<label class="gm-label" for="ticket-additional-context">' + t_('ticket_additional_context') + '</label>' +
            '<textarea id="ticket-additional-context" class="gm-input" rows="2" maxlength="2000" placeholder="' + t_('ticket_additional_context_ph') + '" style="resize:vertical; min-height:60px;"></textarea>' +
          '</div>' +
          '<div class="gm-form-group">' +
            '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.25rem;">' +
              '<label class="gm-label" style="margin:0;">' + esc(t_('ticket_screenshots_title')) + '</label>' +
              '<span style="font-size: var(--fs-xs); color:var(--text-muted);"><span id="ticket-screenshots-count">0</span>/3</span>' +
            '</div>' +
            '<div id="ticket-dropzone" style="border:1px dashed var(--border-soft); border-radius:var(--radius-sm); padding:0.75rem; text-align:center; cursor:pointer; background:rgba(255,255,255,0.02); transition:border-color 0.2s, background 0.2s;">' +
              '<input type="file" id="ticket-file-input" accept="image/png,image/jpeg,image/webp" multiple style="display:none;">' +
              '<div style="display:flex; align-items:center; justify-content:center; gap:0.4rem; color:var(--text-muted); font-size: var(--fs-sm);">' +
                '<i class="ph ph-image-square" style="font-size: var(--fs-xl); color:var(--accent);"></i>' +
                '<span>' + esc(t_('ticket_screenshots_hint')) + '</span>' +
              '</div>' +
            '</div>' +
            '<div id="ticket-screenshots-preview" style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-top:0.5rem;"></div>' +
          '</div>' +
          '<div style="background:rgba(255,255,255,0.03); border:1px solid var(--border-soft); border-radius:var(--radius-sm); padding:0.55rem 0.75rem; font-size: var(--fs-sm);">' +
            '<div style="font-weight:700; color:var(--text-muted); text-transform:uppercase; font-size: var(--fs-xs); letter-spacing:0.05em; margin-bottom:0.35rem; display:flex; align-items:center; gap:0.3rem;">' +
              '<i class="ph ph-devices" style="font-size: var(--fs-md);"></i> ' + esc(t_('ticket_env_title')) +
            '</div>' +
            '<div style="display:flex; flex-wrap:wrap; gap:0.4rem;">' +
              '<span class="gm-chip" style="font-size: var(--fs-xs); padding:2px 8px; border-radius:6px; background:var(--bg-soft); border:1px solid var(--border-soft);">FGF: <strong style="color:var(--fg);">' + esc(env.appVersion) + '</strong></span>' +
              '<span class="gm-chip" style="font-size: var(--fs-xs); padding:2px 8px; border-radius:6px; background:var(--bg-soft); border:1px solid var(--border-soft);">OS: <strong style="color:var(--fg);">' + esc(env.os) + '</strong></span>' +
              '<span class="gm-chip" style="font-size: var(--fs-xs); padding:2px 8px; border-radius:6px; background:var(--bg-soft); border:1px solid var(--border-soft);">Browser: <strong style="color:var(--fg);">' + esc(env.browser) + '</strong></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div id="bug-report-msg" class="gm-dim" style="min-height:1rem; margin-top:0.6rem; font-size: var(--fs-sm);"></div>' +
        '<div style="display:flex; justify-content:flex-end; gap:0.6rem; margin-top:1rem; position:sticky; bottom:0; background:var(--bg-card); z-index:2; padding-top:0.4rem; border-top:1px solid var(--border-soft);">' +
          '<button type="button" class="gm-btn gm-btn-ghost bug-report-close">' + t_('cancel') + '</button>' +
          '<button type="button" class="gm-btn gm-btn-primary" id="bug-report-submit">' + t_('ticket_submit') + '</button>' +
        '</div>' +
      '</div>';
  }

  // ── Bottom nav (mobile) ───────────────────────────────────────────────────
  private renderBottomNav(): void {
    const el = document.querySelector('[data-gm-bottom-nav]');
    if (!el) return;
    const primary = ['overview', 'members', 'events', 'history', 'stats'];
    let html = '<div class="gm-bottom-nav-inner">';
    primary.forEach((id) => {
      const item = NAV_ITEMS.find((i) => i.id === id);
      if (!item) return;
      const isActive = this.state.active === id;
      const phIcon = item.icon || 'ph-circle';
      html += '<button class="gm-bottom-nav-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + id + '">' +
                  '<i class="ph ' + phIcon + ' gm-icon"></i>' +
                  '<span>' + legacy.t(item.labelKey) + '</span>' +
                '</button>';
    });
    html += '<button class="gm-bottom-nav-item" data-gm-more>' +
                '<i class="ph ph-dots-three gm-icon"></i>' +
                '<span class="gm-bottom-nav-unread-badge hidden" id="bottom-nav-more-badge">0</span>' +
                '<span>' + legacy.t('gm_nav_more') + '</span>' +
            '</button>';
    html += '</div>';
    el.innerHTML = html;

    el.querySelectorAll('[data-gm-nav-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.gotoItem(btn.getAttribute('data-gm-nav-item') || '');
      });
    });
    const moreBtn = el.querySelector('[data-gm-more]');
    if (moreBtn) moreBtn.addEventListener('click', () => this.openDrawer());
  }

  private renderDrawer(): void {
    const drawer = document.querySelector('[data-gm-drawer]');
    const backdrop = document.querySelector('[data-gm-drawer-backdrop]');
    if (!drawer || !backdrop) return;

    let html = '<div class="gm-drawer-handle"></div><div class="gm-drawer-grid">';
    this.visibleNavItems().forEach((item) => {
      const isActive = this.state.active === item.id;
      const label = legacy.t(item.labelKey);
      const phIcon = item.icon || 'ph-circle';

      html += '<button class="gm-drawer-item' + (isActive ? ' gm-active' : '') + '" data-gm-nav-item="' + item.id + '">' +
                  '<i class="ph ' + phIcon + ' gm-icon"></i>' +
                  '<span>' + label + '</span>' +
              '</button>';
    });
    html += '<div class="gm-sidebar-legal-footer" style="grid-column: 1 / -1; margin-top: 0.5rem; border-top: 1px solid var(--border-soft); padding: 0.75rem 0.5rem 0.25rem 0.5rem;">' +
                '<div class="gm-app-version">' + legacy.esc(legacy.appVersion()) + '</div>' +
                '<a href="terms.html" class="gm-sidebar-legal-link" data-i18n="footer_terms">Terms &amp; Conditions</a>' +
            '</div>';
    html += '</div>';
    drawer.innerHTML = html;

    drawer.querySelectorAll('[data-gm-nav-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.gotoItem(btn.getAttribute('data-gm-nav-item') || '');
        this.closeDrawer();
      });
    });
    backdrop.addEventListener('click', () => this.closeDrawer());
  }

  public openDrawer(): void {
    this.state.drawerOpen = true;
    const drawer = document.querySelector('[data-gm-drawer]');
    const backdrop = document.querySelector('[data-gm-drawer-backdrop]');
    if (drawer) drawer.classList.add('gm-open');
    if (backdrop) backdrop.classList.add('gm-open');
  }
  public closeDrawer(): void {
    this.state.drawerOpen = false;
    const drawer = document.querySelector('[data-gm-drawer]');
    const backdrop = document.querySelector('[data-gm-drawer-backdrop]');
    if (drawer) drawer.classList.remove('gm-open');
    if (backdrop) backdrop.classList.remove('gm-open');
  }

  // ── Navigation (delegated to app.js via legacy .nav-tab) ─────────────────
  public gotoItem(itemId: string): void {
    const item = NAV_ITEMS.find((i) => i.id === itemId);
    if (!item) return;
    localStorage.setItem('gm_active_tab', itemId);

    let targetTabId = item.tabId;
    if (itemId === 'events') {
      const savedEventTab = localStorage.getItem('gm_active_event_tab');
      if (savedEventTab && item.panels.indexOf(savedEventTab) !== -1) {
        targetTabId = savedEventTab;
      }
    }

    const dashboard = document.getElementById('dashboard-view');
    if (dashboard) {
      dashboard.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      const panel = document.getElementById(targetTabId);
      if (panel) {
        panel.classList.add('active');
      }
    }

    legacy.appOnTabActivated(targetTabId);
  }

  // ── Observe active panel to sync the active nav item ─────────────────────
  private observeActiveTab(): void {
    const dashboard = document.getElementById('dashboard-view');
    if (!dashboard) return;

    const detect = () => {
      const activePanel = dashboard.querySelector('.tab-panel.active');
      if (!activePanel) return;
      const pid = activePanel.id;
      const item = NAV_ITEMS.find((i) => i.panels.indexOf(pid) !== -1);
      if (!item) return;
      localStorage.setItem('gm_active_tab', item.id);
      if (item.panels.length > 1) {
        localStorage.setItem('gm_active_event_tab', pid);
      }
      if (item.id === this.state.active) return;
      this.state.active = item.id;
      this.renderSidebar();
      this.renderTopbar();
      this.renderBottomNav();
      this.renderDrawer();
    };

    detect();
    this.observer = new MutationObserver(detect);
    this.observer.observe(dashboard, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  private observeViewport(): void {
    const mq = legacy.matchMedia('(max-width: ' + BREAKPOINT_MOBILE + 'px)');
    this.mediaQuery = mq;
    this.mediaQueryHandler = (e: any) => {
      this.state.mobile = !!e.matches;
      this.renderSidebar();
      this.renderTopbar();
      if (!e.matches) this.closeDrawer();
    };
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', this.mediaQueryHandler);
    } else if (mq && typeof mq.addListener === 'function') {
      mq.addListener(this.mediaQueryHandler);
    }
  }
}

/** Shared singleton instance (bridged to `window.GM_SHELL` at cutover). */
export const shellView = new ShellView();

export default shellView;
