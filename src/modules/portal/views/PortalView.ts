/**
 * src/modules/portal/views/PortalView.ts
 *
 * Strangler Phase 1 port of the legacy root `portal.js` (1,772 lines) to a
 * strict-TypeScript view module. This file is NOT bridged onto
 * `window.GM_PORTAL` during Phase 1 (the legacy script still owns that global
 * until cutover): it is exercised by `tests/portal_view.test.js`.
 *
 * - Network calls go through `PortalService.invokeAction` (extended to recover
 *   the real {ok,error} body via window.GM.parseFunctionsInvokeResult).
 * - All `window.GM*` / `window.GM_I18N` / `window.GM_PUSH`
 *   reads happen at call time through a typed adapter.
 * - Chart drawing stays delegated to `window.GM.drawScoreTrendChart`.
 * - The global resize listener is tracked so `destroy()` cleans it up.
 * - This module never assigns any `window.GM_*` variable.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { PortalService } from '../portal.service';
import { escapeHTML } from '../../../core/utils/text';
import { COMMON_TIMEZONES, detectUserTimezone, getTimezoneOffset } from '../../../utils/timezone';
import { computeBadges as computeBadgesService } from '../../badges/badges.service';
import { weightedRate, round1 } from '../../../core/scoring/reliability';

function winAny(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function gm(): any {
  return winAny().GM;
}

const legacy = {
  t(key: string): string {
    const i18n = winAny().GM_I18N;
    if (i18n && typeof i18n.t === 'function') return i18n.t(key);
    return key;
  },
  esc(value: unknown): string {
    return escapeHTML(value);
  },
  avatarInit(value: unknown): string {
    const g = gm();
    return g && typeof g.avatarInit === 'function' ? g.avatarInit(value) : String(value || '').slice(0, 1).toUpperCase();
  },
  logout(): Promise<any> {
    const g = gm();
    if (g && typeof g.logout === 'function') return g.logout();
    localStorage.clear();
    return Promise.resolve();
  },
  formatPower(value: unknown): string {
    const g = gm();
    return g && typeof g.formatPower === 'function' ? g.formatPower(value) : String(value ?? '0');
  },
  formatNumber(value: unknown): string {
    const g = gm();
    return g && typeof g.formatNumber === 'function' ? g.formatNumber(value) : String(value ?? '0');
  },
  getEventIcon(key: string): string {
    const g = gm();
    return g && typeof g.getEventIcon === 'function' ? g.getEventIcon(key) : 'ph-calendar';
  },
  drawScoreTrendChart(canvas: unknown, history: unknown): void {
    const g = gm();
    if (g && typeof g.drawScoreTrendChart === 'function') g.drawScoreTrendChart(canvas, history);
  },
  formatDateTimeUTC(value: unknown): string {
    const g = gm();
    return g && typeof g.formatDateTimeUTC === 'function' ? g.formatDateTimeUTC(value) : '';
  },
  attachNumberFormatter(input: unknown): void {
    const g = gm();
    if (g && typeof g.attachNumberFormatter === 'function') g.attachNumberFormatter(input);
  },
  parseNumber(value: unknown): number {
    const g = gm();
    return g && typeof g.parseNumber === 'function' ? g.parseNumber(value) : (parseInt(String(value).replace(/[^0-9]/g, ''), 10) || 0);
  },
  showToast(msg: string, type: string): void {
    const g = gm();
    if (g && typeof g.showToast === 'function') g.showToast(msg, type);
  },
  density(p: unknown): number {
    const g = gm();
    return g && typeof g.calculateCombatDensity === 'function' ? g.calculateCombatDensity(p) : 0;
  },
  residual(p: unknown): number {
    const g = gm();
    return g && typeof g.calculateResidualPower === 'function' ? g.calculateResidualPower(p) : 0;
  },
  combativity(p: unknown): number {
    const g = gm();
    return g && typeof g.calculateCombativity === 'function' ? g.calculateCombativity(p) : 0;
  },
  rallyScore(p: unknown): number {
    const g = gm();
    return g && typeof g.calculateRallyScore === 'function' ? g.calculateRallyScore(p) : 0;
  },
  rallyGrade(p: unknown, max: number): number {
    const g = gm();
    return g && typeof g.calculateRallyGrade === 'function' ? g.calculateRallyGrade(p, max) : 100;
  },
  mountPasskeysPanel(opts: unknown): any {
    const g = gm();
    return g && g.webauthn && typeof g.webauthn.mountPasskeysPanel === 'function' ? g.webauthn.mountPasskeysPanel(opts) : null;
  },
  computeBadges(payload: unknown): any {
    // Phase 7: imported. The `window` probe returned null whenever the
    // namespace name drifted, and the portal simply rendered no badges.
    return computeBadgesService(payload as never);
  }
};

const PERIODS = [
  { key: 'all', label: 'All Time' },
  { key: '8w', label: '8 Weeks' },
  { key: '4w', label: '4 Weeks' },
  { key: '1w', label: '1 Week' }
];

interface PortalState {
  player: any;
  sessions: any[];
  history: any;
  kpis: any;
  guildAverages: Record<string, any>;
  /** Per-bucket attendance for this player and their guild, from gm_player_stats. */
  reliability: any;
  /** Best Glory week ever recorded, and how many weeks exist. */
  gloryHistory: any;
  activeTab: string;
  period: string;
  chartsDrawn: boolean;
  badgesLoaded: boolean;
  chartRegistry: Array<{ key: string; ev: any; idx: number }>;
}

function createState(): PortalState {
  return {
    player: null,
    sessions: [],
    history: null,
    kpis: null,
    guildAverages: {},
    reliability: null,
    gloryHistory: null,
    activeTab: 'dashboard',
    period: 'all',
    chartsDrawn: false,
    badgesLoaded: false,
    chartRegistry: []
  };
}

/** Player-facing wording for a refused `submit-scores`. */
export function submitErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'score_already_validated': return 'An officer has already recorded this event for you.';
    case 'not_in_session': return 'You are not part of this event (for Shadowfront: not in this squad). Ask an officer.';
    case 'session_inactive': return 'This event has ended. Ask an officer if something is missing.';
    default: return 'Submission failed. Please try again.';
  }
}

export class PortalView {
  private state: PortalState = createState();
  private resizeHandler?: () => void;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  public getState(): PortalState {
    return this.state;
  }

  public destroy(): void {
    if (this.resizeHandler) {
      winAny().removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
  }

  // ── Network ─────────────────────────────────────────────────────────────
  private invoke(action: string, payload?: Record<string, any>): Promise<any> {
    return PortalService.invokeAction(action, payload || {});
  }

  private filterHistoryByPeriod(history: any): any {
    const weeks = ({ all: null, '8w': 8, '4w': 4, '1w': 1 } as Record<string, number | null>)[this.state.period];
    if (weeks === null || weeks === undefined) return history;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7 * weeks);

    const filtered: Record<string, any> = {};
    Object.keys(history || {}).forEach((key) => {
      const list = ((history[key].history || []) as any[]).filter((h) => {
        if (!h.week_start) return true;
        const d = new Date(h.week_start + 'T00:00:00');
        return !isNaN(d.getTime()) && d >= cutoff;
      });
      const attended = list.filter((h) => h.participated || h.sub_present).length;
      filtered[key] = {
        count: list.length,
        attended: attended,
        rate: list.length > 0 ? Math.round((attended / list.length) * 100) : 0,
        has_score: !!history[key].has_score,
        history: list
      };
    });
    return filtered;
  }

  // ── Load ────────────────────────────────────────────────────────────────
  public async loadDashboard(): Promise<void> {
    const root = document.getElementById('portal-dashboard-root');
    if (!root) return;
    root.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading your portal...</div></div>';

    const [profile, history, kpis] = await Promise.all([
      this.invoke('get-active-sessions', {}),
      this.invoke('get-history', {}),
      this.invoke('get-personal-kpis', {})
    ]);

    if (!profile.ok) {
      const rawErr = profile.error || 'unknown_error';
      let displayMsg = profile.message || rawErr;
      if (rawErr === 'Edge Function returned a non-2xx status code' || rawErr === 'unauthorized' || rawErr === 'player_not_found') {
        displayMsg = 'Session expired or player account not active. Please reconnect.';
      }
      root.innerHTML =
        '<div class="gm-empty" style="padding: 3rem 1.5rem; text-align: center; max-width: 480px; margin: 2rem auto; background: var(--bg-1); border-radius: var(--radius-xl); border: 1px solid var(--border-soft);">' +
          '<i class="ph ph-warning-circle gm-icon" style="font-size: var(--fs-5xl); color: #ef4444; margin-bottom: 1rem; display: block;"></i>' +
          '<div class="gm-empty-title" style="font-size: var(--fs-xl); font-weight: 700; color: var(--fg); margin-bottom: 0.5rem;">Unable to load your portal</div>' +
          '<div class="gm-empty-sub" style="color: var(--fg-dim); font-size: var(--fs-md); margin: 0 auto 1.5rem auto;">' + legacy.esc(displayMsg) + '</div>' +
          '<div style="display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap;">' +
            '<button class="gm-btn gm-btn-primary" data-portal-error-signout><i class="ph ph-sign-out"></i> Reconnect / Sign Out</button>' +
            '<button class="gm-btn gm-btn-outline" data-portal-error-retry><i class="ph ph-arrows-clockwise"></i> Retry</button>' +
          '</div>' +
        '</div>';
      const signOutBtn = root.querySelector('[data-portal-error-signout]');
      if (signOutBtn) signOutBtn.addEventListener('click', () => {
        if (gm() && gm().logout) { gm().logout(); } else { localStorage.clear(); location.reload(); }
      });
      const retryBtn = root.querySelector('[data-portal-error-retry]');
      if (retryBtn) retryBtn.addEventListener('click', () => { location.reload(); });
      return;
    }

    this.state.player = {
      pseudo: profile.pseudo,
      guild: profile.guild,
      overall_power: profile.overall_power || 0,
      tech_power: profile.tech_power || 0,
      champion_power: profile.champion_power || 0,
      crew_power: profile.crew_power || 0,
      flagship_power: profile.flagship_power || 0,
      fleet_rating: profile.fleet_rating || 0,
      glory_score: profile.glory_score || (profile.glory != null ? profile.glory : 0),
      metrics_updated_at: profile.metrics_updated_at || null,
      timezone_offset: profile.timezone_offset != null ? profile.timezone_offset : null,
      timezone: profile.timezone || null,
      glory: profile.glory != null ? profile.glory : null
    };
    this.state.sessions = profile.sessions || [];
    this.state.history = history.ok ? (history.events || {}) : null;
    this.state.guildAverages = Object.assign({}, (kpis && kpis.guild_averages) || {}, (profile && profile.guild_averages) || {}, (history && history.guild_averages) || {});
    // `state.kpis` was declared, initialised to null and never assigned: the
    // response was destructured into a local and only `guild_averages` was
    // read from it. Every card guarded on `if (kpis && kpis.power)`, so the
    // entire KPI grid had been unreachable, and the rally grade fell back to
    // grading the player against a multiple of their OWN power.
    this.state.kpis = kpis && kpis.ok !== false ? kpis : null;
    this.state.reliability = (kpis && kpis.reliability) || null;
    this.state.gloryHistory = (kpis && kpis.glory_history) || null;
    this.state.chartsDrawn = false;

    this.renderDashboard();
  }

  // ── Full dashboard ──────────────────────────────────────────────────────
  public renderDashboard(): void {
    const root = document.getElementById('portal-dashboard-root');
    if (!root) return;
    const p = this.state.player;
    const initials = legacy.avatarInit(p.pseudo);

    const navItems = [
      { id: 'settings', icon: 'ph-cardholder', label: 'My Info' },
      { id: 'dashboard', icon: 'ph-chart-line-up', label: 'My Progress' },
      { id: 'challenges', icon: 'ph-target', label: 'Challenges' },
      { id: 'absence', icon: 'ph-user-minus', label: 'Absence' },
      { id: 'events', icon: 'ph-calendar-dots', label: 'Active Events' },
      { id: 'badges', icon: 'ph-trophy', label: 'Badges' }
    ];
    const primaryNavIds = ['settings', 'dashboard', 'challenges', 'events'];
    const drawerNavIds = ['absence', 'badges'];

    const navHtml = navItems.map((item) => {
      const isActive = this.state.activeTab === item.id;
      return '<button class="gm-nav-item' + (isActive ? ' gm-active' : '') + '" data-portal-nav="' + item.id + '">' +
                  '<i class="ph ' + item.icon + '"></i>' +
                  '<span>' + legacy.esc(item.label) + '</span>' +
                '</button>';
    }).join('');

    const html =
      '<div class="gm-shell portal-shell">' +
        '<aside class="gm-sidebar">' +
          '<div class="gm-sidebar-header">' +
            '<div class="gm-sidebar-user-row">' +
              '<div class="gm-user-avatar-ring">' +
                '<div class="gm-user-avatar">' + legacy.esc(initials) + '</div>' +
              '</div>' +
              '<div class="gm-sidebar-user-info">' +
                '<div class="gm-sidebar-user-name">' + legacy.esc(p.pseudo) + '</div>' +
                '<div class="gm-sidebar-user-role">' + legacy.esc(p.guild) + ' &middot; Player</div>' +
              '</div>' +
              '<button class="gm-sidebar-logout" data-portal-exit title="Sign out">' +
                '<i class="ph ph-sign-out"></i>' +
              '</button>' +
            '</div>' +
          '</div>' +
          '<nav class="gm-sidebar-nav">' +
            '<div class="gm-nav-section-label">Player Portal</div>' +
            navHtml +
          '</nav>' +
          '<div class="gm-sidebar-sub-card">' +
            '<div class="gm-sub-card-badge-avatar"><i class="ph ph-crosshair"></i></div>' +
            '<div style="font-size: var(--fs-sm); font-weight:700; color:var(--fg);">' + legacy.esc(p.guild) + '</div>' +
            '<div style="font-size: var(--fs-xs); color:var(--fg-dim); margin-top:.25rem;">Foundation Galactic Frontier</div>' +
          '</div>' +
        '</aside>' +

        '<div class="gm-main">' +
          '<header class="gm-topbar">' +
            '<div class="gm-topbar-mobile-brand">' +
              '<div class="gm-brand-mark">' + legacy.esc(initials) + '</div>' +
              '<div class="gm-topbar-title">Player Portal</div>' +
            '</div>' +
            '<div class="gm-topbar-actions">' +
              '<button class="gm-sidebar-logout" data-portal-exit title="Sign out"><i class="ph ph-sign-out"></i></button>' +
            '</div>' +
          '</header>' +

          '<div class="gm-content">' +
            '<div class="gm-page">' +
              '<div id="portal-panel-dashboard" class="gm-page portal-panel"></div>' +
              '<div id="portal-panel-challenges" class="gm-page portal-panel hidden"></div>' +
              '<div id="portal-panel-badges" class="gm-page portal-panel hidden"></div>' +
              '<div id="portal-panel-events" class="gm-page portal-panel hidden"></div>' +
              '<div id="portal-panel-absence" class="gm-page portal-panel hidden"></div>' +
              '<div id="portal-panel-settings" class="gm-page portal-panel hidden"></div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<nav class="gm-bottom-nav">' +
          '<div class="gm-bottom-nav-inner">' +
            primaryNavIds.map((id) => {
              const item = navItems.find((n) => n.id === id);
              if (!item) return '';
              const isActive = this.state.activeTab === item.id;
              return '<button class="gm-bottom-nav-item' + (isActive ? ' gm-active' : '') + '" data-portal-nav="' + item.id + '">' +
                        '<i class="ph ' + item.icon + ' gm-icon"></i>' +
                        '<span>' + legacy.esc(item.label) + '</span>' +
                      '</button>';
            }).join('') +
            '<button class="gm-bottom-nav-item' + (drawerNavIds.indexOf(this.state.activeTab) !== -1 ? ' gm-active' : '') + '" data-portal-more>' +
              '<i class="ph ph-dots-three gm-icon"></i>' +
              '<span>More</span>' +
            '</button>' +
          '</div>' +
        '</nav>' +

        '<div class="gm-drawer-backdrop" data-portal-drawer-backdrop></div>' +
        '<div class="gm-drawer" data-portal-drawer>' +
          '<div class="gm-drawer-handle"></div>' +
          '<div class="gm-drawer-grid">' +
            drawerNavIds.map((id) => {
              const item = navItems.find((n) => n.id === id);
              if (!item) return '';
              const isActive = this.state.activeTab === item.id;
              return '<button class="gm-drawer-item' + (isActive ? ' gm-active' : '') + '" data-portal-nav="' + item.id + '">' +
                        '<i class="ph ' + item.icon + ' gm-icon"></i>' +
                        '<span>' + legacy.esc(item.label) + '</span>' +
                      '</button>';
            }).join('') +
          '</div>' +
        '</div>' +
      '</div>';

    root.innerHTML = html;

    root.querySelectorAll('[data-portal-nav]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.gotoTab(btn.getAttribute('data-portal-nav') || 'dashboard');
        this.closePortalDrawer();
      });
    });

    const moreBtn = root.querySelector('[data-portal-more]');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        const drawer = root.querySelector('[data-portal-drawer]');
        const backdrop = root.querySelector('[data-portal-drawer-backdrop]');
        if (drawer) drawer.classList.toggle('gm-open');
        if (backdrop) backdrop.classList.toggle('gm-open', !!(drawer && drawer.classList.contains('gm-open')));
      });
    }
    const drawerBackdrop = root.querySelector('[data-portal-drawer-backdrop]');
    if (drawerBackdrop) drawerBackdrop.addEventListener('click', () => this.closePortalDrawer());

    root.querySelectorAll('[data-portal-exit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        localStorage.removeItem('gm_portal_session');
        const finish = (): void => {
          const portalView = document.getElementById('player-portal-view');
          const loginView = document.getElementById('login-view');
          if (portalView) portalView.classList.add('hidden');
          if (portalView) portalView.classList.remove('portal-connected');
          if (loginView) loginView.classList.remove('hidden');
        };
        legacy.logout().then(finish).catch(finish);
      });
    });

    this.renderDashboardPanel();
    this.renderBadgesPanel();
    this.renderEventsPanel();
    this.renderSettingsPanel();
    if (!this.resizeHandler) this.installResizeRedraw();
  }

  private gotoTab(tabId: string): void {
    this.state.activeTab = tabId;
    const root = document.getElementById('portal-dashboard-root');
    if (!root) return;
    root.querySelectorAll('[data-portal-nav]').forEach((b) => {
      b.classList.toggle('gm-active', b.getAttribute('data-portal-nav') === tabId);
    });
    const moreBtn = root.querySelector('[data-portal-more]');
    if (moreBtn) moreBtn.classList.toggle('gm-active', ['absence', 'badges'].indexOf(tabId) !== -1);
    ['dashboard', 'challenges', 'badges', 'events', 'absence', 'settings'].forEach((name) => {
      const panel = document.getElementById('portal-panel-' + name);
      if (panel) panel.classList.toggle('hidden', name !== this.state.activeTab);
    });
    if (this.state.activeTab === 'dashboard' && !this.state.chartsDrawn) {
      this.renderDashboardPanel();
    }
    if (this.state.activeTab === 'challenges') {
      this.renderChallengesPanel();
    }
    if (this.state.activeTab === 'badges' && !this.state.badgesLoaded) {
      this.renderBadgesPanel();
    }
    if (this.state.activeTab === 'absence') {
      this.renderAbsencePanel();
    }
  }

  private closePortalDrawer(): void {
    const root = document.getElementById('portal-dashboard-root');
    if (!root) return;
    const drawer = root.querySelector('[data-portal-drawer]');
    const backdrop = root.querySelector('[data-portal-drawer-backdrop]');
    if (drawer) drawer.classList.remove('gm-open');
    if (backdrop) backdrop.classList.remove('gm-open');
  }

  private installResizeRedraw(): void {
    const handler = (): void => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        (this.state.chartRegistry || []).forEach((entry) => {
          this.drawChart(entry.key, entry.ev, entry.idx);
        });
      }, 200);
    };
    this.resizeHandler = handler;
    winAny().addEventListener('resize', handler);
  }

  // ── Panel: My Progress ──────────────────────────────────────────────────
  private renderDashboardPanel(): void {
    const panel = document.getElementById('portal-panel-dashboard');
    if (!panel) return;

    const hist = this.filterHistoryByPeriod(this.state.history);
    const keys = Object.keys(hist || {});
    let totalCount = 0;
    let totalAttended = 0;
    keys.forEach((k) => {
      totalCount += hist[k].count;
      totalAttended += hist[k].attended;
    });
    const overallRate = totalCount > 0 ? Math.round((totalAttended / totalCount) * 100) : 0;

    const kpis = this.state.kpis;
    const player = this.state.player || {};
    const guildAvg = this.state.guildAverages || {};
    const density = legacy.density(player);
    const residual = legacy.residual(player);
    const combativity = legacy.combativity(player);

    // The rally grade used to be measured against `player.overall_power * 1.25`
    // because `kpis` was always null -- the player was graded against
    // themselves, which no amount of progress could change. It is the guild's
    // real maximum now.
    const guildTotals = (this.state.reliability && this.state.reliability.guild_totals) || {};
    const maxGuildPower = Number(guildTotals.max_power) || (player.overall_power * 1.25) || 100000000;
    const playerRallyScore = legacy.rallyScore(player);
    const estimatedMaxRally = Math.max(playerRallyScore, Math.round(maxGuildPower * 5.2));
    const rallyGrade = legacy.rallyGrade(player, estimatedMaxRally);

    let kpiHtml = '';
    if (this.state.reliability) {
      const rel = this.state.reliability;
      // The tenant's coefficient overrides live in `guild_config`, which a
      // member cannot read. The portal therefore weights with the published
      // defaults. Stated on the card so the number is not passed off as
      // identical to the admin's when a guild has customised its weights.
      const coeffs = undefined;

      // The same weighting the admin Stats page applies, from the same module.
      // These two screens published different attendance rates for the same
      // guild on the same day -- 48.1% here against 31.6% there -- because
      // this one counted rows, and counted Glory and unapproved rows among
      // them. One definition now, in core/scoring/reliability.ts.
      const playerBuckets = (rel.player && rel.player.buckets) || {};
      const mine = weightedRate(playerBuckets, coeffs);

      const guildBuckets: Record<string, { att: number; opp: number }> = {};
      Object.keys((guildTotals && guildTotals.buckets) || {}).forEach((b) => {
        const g = guildTotals.buckets[b] || {};
        guildBuckets[b] = { att: Number(g.attendances) || 0, opp: Number(g.member_opportunities) || 0 };
      });
      const theirs = weightedRate(guildBuckets, coeffs);

      const myPct = mine.rate === null ? null : round1(mine.rate);
      const guildPct = theirs.rate === null ? null : round1(theirs.rate);
      const delta = (myPct !== null && guildPct !== null) ? round1(myPct - guildPct) : null;

      const breakdown = Object.keys(playerBuckets)
        .map((b) => ({ bucket: b, ...(playerBuckets[b] || {}) }))
        .filter((b: any) => Number(b.opp) > 0)
        .sort((a: any, b: any) => String(a.bucket).localeCompare(String(b.bucket)))
        .map((b: any) => legacy.esc(b.bucket) + ' ' + b.att + '/' + b.opp)
        .join(' · ');

      const glory = this.state.gloryHistory || {};
      const powerPct = maxGuildPower > 0
        ? Math.min(100, Math.round(((player.overall_power || 0) / maxGuildPower) * 100)) : 0;

      kpiHtml =
        '<div class="portal-kpi-grid">' +
          '<div class="portal-kpi-card portal-kpi-part">' +
            '<div class="portal-kpi-icon"><i class="ph ph-calendar-check"></i></div>' +
            '<div class="portal-kpi-value">' + legacy.esc(myPct === null ? '—' : myPct + '%') + '</div>' +
            '<div class="portal-kpi-label">Your reliability</div>' +
            '<div class="portal-kpi-rank">' + legacy.esc(breakdown || 'Nothing ran for you yet') + '</div>' +
            '<div class="portal-kpi-bar"><div class="portal-kpi-bar-fill" style="width:' + (myPct || 0) + '%;"></div></div>' +
            '<div class="portal-kpi-sub">' +
              (delta === null
                ? 'Over the last ' + legacy.esc(rel.weeks || 0) + ' weeks'
                : legacy.esc((delta >= 0 ? '+' : '') + delta + '% vs your guild (' + guildPct + '%)')) +
              '<br><span style="opacity:.7;">Weighted by event type, standard weights</span>' +
            '</div>' +
          '</div>' +
          '<div class="portal-kpi-card portal-kpi-power">' +
            '<div class="portal-kpi-icon"><i class="ph ph-sword"></i></div>' +
            '<div class="portal-kpi-value">' + legacy.esc(legacy.formatPower(player.overall_power || 0)) + '</div>' +
            '<div class="portal-kpi-label">Combat Power</div>' +
            '<div class="portal-kpi-rank">' + legacy.esc(powerPct) + '% of the strongest in your guild</div>' +
            '<div class="portal-kpi-bar"><div class="portal-kpi-bar-fill" style="width:' + powerPct + '%;"></div></div>' +
            '<div class="portal-kpi-sub">Guild average: ' + legacy.esc(legacy.formatPower(guildAvg.overall_power || 0)) + '</div>' +
          '</div>' +
          '<div class="portal-kpi-card portal-kpi-glory">' +
            '<div class="portal-kpi-icon"><i class="ph ph-trophy"></i></div>' +
            '<div class="portal-kpi-value">' + legacy.esc(glory.best ? legacy.formatNumber(glory.best) : '—') + '</div>' +
            '<div class="portal-kpi-label">Best Glory week</div>' +
            '<div class="portal-kpi-rank">' + legacy.esc((glory.weeks_recorded || 0) + ' week' + ((glory.weeks_recorded || 0) === 1 ? '' : 's') + ' recorded') + '</div>' +
            '<div class="portal-kpi-bar"><div class="portal-kpi-bar-fill" style="width:100%;"></div></div>' +
            '<div class="portal-kpi-sub">Guild average: ' + legacy.esc(legacy.formatNumber(guildAvg.glory_score || 0)) + '</div>' +
          '</div>' +
          '<div class="portal-kpi-card portal-kpi-tenure">' +
            '<div class="portal-kpi-icon"><i class="ph ph-lightning"></i></div>' +
            '<div class="portal-kpi-value" style="color:#fbbf24;">⚡ ' + legacy.esc(rallyGrade) + '/100</div>' +
            '<div class="portal-kpi-label">Rally Grade</div>' +
            '<div class="portal-kpi-rank">Combat Density: ' + density + '%</div>' +
            '<div class="portal-kpi-bar"><div class="portal-kpi-bar-fill" style="width:' + legacy.esc(rallyGrade) + '%; background:#fbbf24;"></div></div>' +
            '<div class="portal-kpi-sub">Combativity: ' + combativity + 'x &middot; ' + legacy.esc(player.role || 'R1') + '</div>' +
          '</div>' +
        '</div>';
    }

    const tilesHtml =
      '<div class="portal-stats">' +
        '<div class="portal-stat"><div class="portal-stat-value">' + legacy.esc(totalCount) + '</div><div class="portal-stat-label">Events tracked</div></div>' +
        '<div class="portal-stat"><div class="portal-stat-value">' + legacy.esc(totalAttended) + '</div><div class="portal-stat-label">Participated</div></div>' +
        // This strip used to show a third figure, "Attendance rate", computed
        // as totalAttended / totalCount: a rate pooled across event types, so
        // a member's Arms Race days outweighed their wars. It sat a few
        // centimetres from the reliability card, which answers the same
        // question differently. Two rates on one screen is how a member loses
        // confidence in both, so the counts stay and the rate is stated once.
        '' +
        '<div class="portal-stat"><div class="portal-stat-value">' + legacy.esc(legacy.formatPower(player.overall_power)) + '</div><div class="portal-stat-label">Current power</div></div>' +
      '</div>';

    const periodHtml =
      '<div class="portal-period">' +
        '<span class="portal-period-label"><i class="ph ph-calendar"></i> Period</span>' +
        '<div class="portal-period-btns">' +
          PERIODS.map((per) => {
            return '<button type="button" class="portal-period-btn' + (this.state.period === per.key ? ' active' : '') + '" data-period="' + per.key + '">' + legacy.esc(per.label) + '</button>';
          }).join('') +
        '</div>' +
      '</div>';

    let chartsHtml = '';
    const chartKeys = keys.filter((k) => hist[k].has_score);

    if (chartKeys.length === 0) {
      chartsHtml = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-chart-bar gm-icon"></i><div class="gm-empty-title">No scored events for this period.</div><div class="gm-empty-sub">Progression charts appear for events with scores (SvS, GvG, Glory).</div></div>';
    } else {
      chartKeys.forEach((key, idx) => {
        chartsHtml += this.renderChartCard(key, hist[key], idx);
      });
    }

    let tilesHtml2 = '';
    const tileKeys = keys.filter((k) => !hist[k].has_score);
    const tileOrder = ['ARMS RACE STAGE A', 'ARMS RACE STAGE B', 'DEFEND TRADE ROUTE'];
    let orderedTiles: string[] = [];
    tileOrder.forEach((pref) => {
      const i = tileKeys.indexOf(pref);
      if (i !== -1) {
        orderedTiles.push(tileKeys[i]);
        tileKeys.splice(i, 1);
      }
    });
    orderedTiles = orderedTiles.concat(tileKeys);

    if (orderedTiles.length > 0) {
      tilesHtml2 =
        '<div class="portal-participation-grid">' +
          orderedTiles.map((key) => this.renderParticipationTile(key, hist[key])).join('') +
        '</div>';
    }

    const tacticalBreakdownHtml =
      '<div class="portal-card" style="margin-bottom: 1.25rem; background: var(--md-sys-color-surface-container, #1e1f20); border: 1px solid var(--md-sys-color-outline-variant, rgba(255, 255, 255, 0.08)); border-radius: var(--md-sys-shape-corner-large, 16px); padding: 1.35rem; box-shadow: var(--md-sys-elevation-level1, 0 1px 3px rgba(0,0,0,0.2));">' +
        '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.15rem; flex-wrap:wrap; gap:0.6rem;">' +
          '<div style="display:flex; align-items:center; gap:0.55rem;">' +
            '<i class="ph ph-sword" style="color:var(--md-sys-color-primary, #a8c7fa); font-size: var(--fs-3xl);"></i>' +
            '<span style="font-weight:800; font-size: var(--fs-xl); color:var(--md-sys-color-on-surface, #e3e3e3);">Military Force Breakdown &amp; Guild Benchmarks</span>' +
          '</div>' +
          '<div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">' +
            '<span class="gm-chip" style="font-size: var(--fs-sm); font-weight:700; color:#a8c7fa; background:rgba(168,199,250,0.12); border:1px solid rgba(168,199,250,0.25); border-radius:var(--md-sys-shape-corner-full);"><i class="ph ph-shield-check"></i> Density: ' + Math.min(100, Math.round(density)) + '%</span>' +
            '<span class="gm-chip" style="font-size: var(--fs-sm); font-weight:700; color:#6dd58c; background:rgba(109,213,140,0.12); border:1px solid rgba(109,213,140,0.25); border-radius:var(--md-sys-shape-corner-full);"><i class="ph ph-crosshair"></i> Combativity: ' + combativity + 'x</span>' +
            '<span class="gm-chip" style="font-size: var(--fs-sm); font-weight:700; color:#ffe088; background:rgba(255,224,136,0.12); border:1px solid rgba(255,224,136,0.25); border-radius:var(--md-sys-shape-corner-full);"><i class="ph ph-barricade"></i> Volatile: ' + legacy.esc(legacy.formatPower(residual)) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="portal-military-grid">' +
          this.renderMilitaryTile('⚔️', 'Fleet Rating', player.fleet_rating, guildAvg.fleet_rating, '#a8c7fa') +
          this.renderMilitaryTile('🔬', 'Tech Power', player.tech_power, guildAvg.tech_power, '#d0bcff') +
          this.renderMilitaryTile('🚀', 'Flagship Power', player.flagship_power, guildAvg.flagship_power, '#ffe088') +
          this.renderMilitaryTile('👑', 'Champions Power', player.champion_power, guildAvg.champion_power, '#f472b6') +
          this.renderMilitaryTile('👥', 'Crew Power', player.crew_power, guildAvg.crew_power, '#70d7ff') +
          this.renderMilitaryTile('🏆', 'Glory Score', (player.glory_score || player.glory), guildAvg.glory_score, '#6dd58c') +
          this.renderMilitaryTile('🛡️', 'Total Power', player.overall_power, guildAvg.overall_power, '#e3e3e3') +
        '</div>' +
      '</div>';

    panel.innerHTML =
      '<header class="gm-page-header">' +
        '<div>' +
          '<h1 class="gm-page-title">My Progress</h1>' +
          '<p class="gm-page-subtitle">Your score progression, event performance, and guild benchmark comparison</p>' +
        '</div>' +
        periodHtml +
      '</header>' +
      kpiHtml +
      tilesHtml +
      tacticalBreakdownHtml +
      tilesHtml2 +
      '<div class="portal-charts-grid">' + chartsHtml + '</div>';

    panel.querySelectorAll('.portal-period-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.period = btn.getAttribute('data-period') || 'all';
        this.renderDashboardPanel();
      });
    });

    this.state.chartsDrawn = true;
    this.state.chartRegistry = chartKeys.map((key, idx) => ({ key: key, ev: hist[key], idx: idx }));
    winAny().requestAnimationFrame(() => {
      chartKeys.forEach((key, idx) => {
        this.drawChart(key, hist[key], idx);
      });
    });
  }

  private renderMilitaryTile(icon: string, label: string, playerVal: unknown, avgVal: unknown, color: string): string {
    const pVal = Number(playerVal) || 0;
    const aVal = Number(avgVal) || 0;
    let deltaHtml = '';
    if (aVal > 0 && pVal > 0) {
      const diffPct = Math.round(((pVal - aVal) / aVal) * 1000) / 10;
      if (diffPct >= 0) {
        deltaHtml = '<span class="gm-chip" style="font-size: var(--fs-xs); padding:0.1rem 0.38rem; color:#6dd58c; background:rgba(109,213,140,0.14); border:1px solid rgba(109,213,140,0.25); border-radius:var(--md-sys-shape-corner-full, 9999px); white-space:nowrap;">+' + diffPct + '%</span>';
      } else {
        deltaHtml = '<span class="gm-chip" style="font-size: var(--fs-xs); padding:0.1rem 0.38rem; color:#ffe088; background:rgba(255,224,136,0.14); border:1px solid rgba(255,224,136,0.25); border-radius:var(--md-sys-shape-corner-full, 9999px); white-space:nowrap;">' + diffPct + '%</span>';
      }
    }
    const avgFormatted = aVal > 0 ? legacy.formatPower(aVal) : (pVal > 0 ? legacy.formatPower(pVal) : '0');
    return '<div class="portal-military-tile">' +
              '<div class="portal-military-tile-header">' +
                '<div class="portal-military-tile-title">' +
                  '<span class="portal-military-tile-icon">' + icon + '</span>' +
                  '<span class="portal-military-tile-label">' + legacy.esc(label) + '</span>' +
                '</div>' +
                '<div class="portal-military-tile-delta">' + deltaHtml + '</div>' +
              '</div>' +
              '<div class="portal-military-tile-value" style="color:' + color + ';">' + legacy.esc(legacy.formatPower(pVal)) + '</div>' +
              '<div class="portal-military-tile-footer">' +
                '<i class="ph ph-users-three"></i>' +
                '<span class="portal-military-tile-avg-label">Guild Avg:</span>' +
                '<span class="portal-military-tile-avg-val">' + legacy.esc(avgFormatted) + '</span>' +
              '</div>' +
            '</div>';
  }

  private eventAccent(eventKey: string): string {
    const lower = String(eventKey).toLowerCase();
    if (lower.indexOf('svs') !== -1) return '#ffe088';
    if (lower.indexOf('gvg') !== -1) return '#a8c7fa';
    if (lower.indexOf('shadowfront') !== -1) return '#d0bcff';
    if (lower.indexOf('trade') !== -1 || lower.indexOf('dtr') !== -1) return '#70d7ff';
    if (lower.indexOf('arms') !== -1 || lower.indexOf('race') !== -1) return '#ffe088';
    if (lower.indexOf('glory') !== -1) return '#6dd58c';
    return '#c4c7c5';
  }

  private renderChartCard(eventKey: string, ev: any, idx: number): string {
    const icon = legacy.getEventIcon(eventKey);
    const accent = this.eventAccent(eventKey);
    return '<div class="portal-chart-card">' +
              '<div class="portal-chart-accent" style="background:' + accent + ';"></div>' +
              '<div class="portal-chart-head">' +
                '<div class="portal-chart-title"><i class="ph ' + icon + '" style="color:' + accent + ';"></i> ' + legacy.esc(eventKey) + '</div>' +
                '<div class="portal-chart-legend">' +
                  '<span style="display:inline-flex; align-items:center; gap:0.4rem; color:#6dd58c; font-weight:700;"><span style="width:12px; height:3px; background:#6dd58c; border-radius:2px; display:inline-block;"></span> You</span>' +
                  '<span style="display:inline-flex; align-items:center; gap:0.4rem; color:#ffe088; font-weight:700;"><span style="width:14px; height:0; border-top:2.5px dashed #ffe088; display:inline-block;"></span> Guild Avg (dashed)</span>' +
                '</div>' +
              '</div>' +
              '<canvas class="portal-chart-canvas" data-chart-key="' + legacy.esc(eventKey) + '" data-chart-idx="' + idx + '" width="1200" height="200"></canvas>' +
            '</div>';
  }

  private renderParticipationTile(eventKey: string, ev: any): string {
    const icon = legacy.getEventIcon(eventKey);
    const accent = this.eventAccent(eventKey);
    const attended = ev.attended || 0;

    let recentBadges = '';
    (ev.history || []).slice(0, 4).forEach((h: any) => {
      recentBadges += h.participated || h.sub_present
        ? '<span class="portal-badge" style="background:rgba(109,213,140,0.18); color:#6dd58c; border-color:rgba(109,213,140,0.4);">P</span>'
        : (h.excused ? '<span class="portal-badge" style="background:rgba(255,224,136,0.15); color:#ffe088; border-color:rgba(255,224,136,0.4);">E</span>'
           : '<span class="portal-badge" style="background:rgba(248,113,113,0.15); color:#f87171; border-color:rgba(248,113,113,0.4);">A</span>');
    });

    return '<div class="portal-participation-tile">' +
              '<div class="portal-chart-accent" style="background:' + accent + ';"></div>' +
              '<div class="portal-participation-body">' +
                '<div class="portal-participation-title"><i class="ph ' + icon + '" style="color:' + accent + ';"></i> ' + legacy.esc(eventKey) + '</div>' +
                '<div class="portal-participation-rate">' + legacy.esc(ev.rate) + '%</div>' +
                '<div class="portal-participation-sub">' + legacy.esc(attended) + '/' + legacy.esc(ev.count) + ' attended</div>' +
                '<div class="portal-participation-badges">' + recentBadges + '</div>' +
              '</div>' +
            '</div>';
  }

  private drawChart(eventKey: string, ev: any, idx: number): void {
    const canvas = document.querySelector('.portal-chart-canvas[data-chart-idx="' + idx + '"]');
    if (!canvas) return;
    legacy.drawScoreTrendChart(canvas, ev.history || []);
  }

  // ── Panel: Challenges ───────────────────────────────────────────────────
  private renderChallengesPanel(): void {
    const panel = document.getElementById('portal-panel-challenges');
    if (!panel) return;
    panel.innerHTML =
      '<header class="gm-page-header">' +
        '<div>' +
          '<h1 class="gm-page-title">Challenges</h1>' +
          '<p class="gm-page-subtitle">Weekly goals and your season progress</p>' +
        '</div>' +
      '</header>' +
      '<div id="portal-challenges-body"><div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading challenges...</div></div></div>';
    this.loadChallengesPanel();
  }

  private renderChallengeCard(challenge: any): string {
    const cls = challenge.done ? 'portal-challenge done' : 'portal-challenge';
    const pct = challenge.target > 0 ? Math.min(100, Math.round(challenge.progress / challenge.target * 100)) : 0;
    return '<div class="' + cls + '">' +
              '<div class="portal-challenge-icon"><i class="ph ' + challenge.icon + '"></i></div>' +
              '<div class="portal-challenge-info">' +
                '<div class="portal-challenge-name">' + legacy.esc(challenge.label) + '</div>' +
                '<div class="portal-challenge-progress"><div class="portal-challenge-progress-fill" style="width:' + pct + '%; background:' + (challenge.done ? 'var(--success)' : 'var(--accent)') + ';"></div></div>' +
              '</div>' +
              '<div class="portal-challenge-state">' +
                (challenge.done ? '<i class="ph ph-check-circle" style="color:var(--success);"></i>' : '<span class="portal-challenge-count">' + challenge.progress + '/' + challenge.target + '</span>') +
              '</div>' +
            '</div>';
  }

  private async loadChallengesPanel(): Promise<void> {
    const body = document.getElementById('portal-challenges-body');
    if (!body) return;
    const res = await this.invoke('get-weekly-challenges', {});
    if (!res.ok) {
      body.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-warning-circle gm-icon"></i><div class="gm-empty-title">Unable to load challenges.</div><div class="gm-empty-sub">' + legacy.esc(res.error || 'unknown error') + '</div></div>';
      return;
    }

    const levelMeta: Record<string, { label: string; color: string }> = {
      'None': { label: 'No season rank yet', color: 'var(--fg-dim)' },
      'Bronze': { label: 'Bronze season', color: '#cd7f32' },
      'Silver': { label: 'Silver season', color: '#c0c0c0' },
      'Gold': { label: 'Gold season', color: '#ffd700' }
    };
    const meta = levelMeta[res.season.level] || { label: res.season.level, color: 'var(--accent)' };

    const cards = res.challenges.map((c: any) => this.renderChallengeCard(c)).join('');

    body.innerHTML =
      '<div class="portal-challenges-summary">' +
        '<div class="portal-challenges-summary-item"><span class="portal-challenges-summary-value">' + res.completed + '/' + res.total + '</span><span class="portal-challenges-summary-label">challenges done this week</span></div>' +
        '<div class="portal-challenges-summary-item"><span class="portal-challenges-summary-value" style="color:' + meta.color + ';">' + res.season.events + '</span><span class="portal-challenges-summary-label">events over the season</span></div>' +
        '<div class="portal-challenges-summary-item"><span class="portal-challenges-summary-value" style="color:' + meta.color + ';">' + meta.label + '</span><span class="portal-challenges-summary-label">season</span></div>' +
      '</div>' +
      '<div class="portal-challenge-list">' + cards + '</div>';
  }

  // ── Panel: Badges ───────────────────────────────────────────────────────
  private renderBadgesPanel(): void {
    const panel = document.getElementById('portal-panel-badges');
    if (!panel) return;
    panel.innerHTML =
      '<header class="gm-page-header">' +
        '<div>' +
          '<h1 class="gm-page-title">Badges</h1>' +
          '<p class="gm-page-subtitle">Achievements that unlock as you grow in the guild</p>' +
        '</div>' +
      '</header>' +
      '<div id="portal-badges-body"><div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading badges...</div></div></div>';
    this.loadBadgesPanel();
  }

  private formatBadgeCurrent(badge: any): string {
    if (badge.category === 'rank') return 'R' + badge.current;
    if (badge.category === 'tenure') return legacy.formatNumber(badge.current) + 'd';
    if (badge.category === 'power') return legacy.formatPower(badge.current);
    if (badge.category === 'glory') return legacy.formatNumber(badge.current);
    return legacy.formatNumber(badge.current) + ' evts';
  }

  private formatBadgeTarget(badge: any): string {
    if (badge.category === 'rank') return 'R' + badge.target;
    if (badge.category === 'tenure') return legacy.formatNumber(badge.target) + 'd';
    if (badge.category === 'power') return legacy.formatPower(badge.target);
    if (badge.category === 'glory') return legacy.formatNumber(badge.target);
    return '';
  }

  private renderBadgeCard(badge: any): string {
    const cls = badge.earned ? 'portal-badge-card earned' : 'portal-badge-card locked';
    const iconCls = badge.earned ? 'portal-badge-icon' : 'portal-badge-icon dim';
    const stateHtml = badge.earned
      ? '<div class="portal-badge-state"><i class="ph ph-check-circle"></i> Unlocked</div>'
      : '<div class="portal-badge-state"><i class="ph ph-lock-key"></i> Locked</div>';

    const progressHtml = badge.earned
      ? '<div class="portal-badge-progress"><div class="portal-badge-progress-fill" style="width:100%; background:' + badge.color + ';"></div></div>'
      : '<div class="portal-badge-progress"><div class="portal-badge-progress-fill" style="width:' + badge.progress + '%; background:' + badge.color + ';"></div></div>';

    const metricHtml = badge.earned ? '' :
      '<div class="portal-badge-metric"><span>' + legacy.esc(this.formatBadgeCurrent(badge)) + '</span><span class="portal-badge-metric-sep">/</span><span>' + legacy.esc(this.formatBadgeTarget(badge)) + '</span></div>';

    return '<div class="' + cls + '">' +
              '<div class="' + iconCls + '" style="color:' + badge.color + ';' + (badge.earned ? ' border-color:' + badge.color + '; box-shadow:0 0 18px ' + badge.color + '55;' : '') + '">' +
                '<i class="ph ' + badge.icon + '"></i>' +
              '</div>' +
              '<div class="portal-badge-name">' + legacy.esc(badge.name) + '</div>' +
              '<div class="portal-badge-desc">' + legacy.esc(badge.desc) + '</div>' +
              progressHtml +
              metricHtml +
              stateHtml +
            '</div>';
  }

  private renderBadgesBody(data: any): void {
    const body = document.getElementById('portal-badges-body');
    if (!body) return;

    const summary =
      '<div class="portal-badges-summary">' +
        '<div class="portal-badges-summary-item"><span class="portal-badges-summary-value">' + data.earned + '</span><span class="portal-badges-summary-label">of ' + data.total + ' badges earned</span></div>' +
        '<div class="portal-badges-summary-item"><span class="portal-badges-summary-value">' + data.categories.length + '</span><span class="portal-badges-summary-label">achievement tracks</span></div>' +
      '</div>';

    const sections = data.categories.map((cat: any) => {
      const cards = cat.badges.map((b: any) => this.renderBadgeCard(b)).join('');
      return '<div class="portal-badge-section">' +
                '<div class="portal-badge-section-title"><i class="ph ' + cat.icon + '" style="color:' + cat.color + ';"></i> ' + legacy.esc(cat.label) + '</div>' +
                '<div class="portal-badge-grid">' + cards + '</div>' +
              '</div>';
    }).join('');

    body.innerHTML = summary + sections;
  }

  private async loadBadgesPanel(): Promise<void> {
    const body = document.getElementById('portal-badges-body');
    if (!body) return;

    const res = await this.invoke('get-badges', {});
    if (!res.ok) {
      body.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-warning-circle gm-icon"></i><div class="gm-empty-title">Unable to load your badges.</div><div class="gm-empty-sub">' + legacy.esc(res.error || 'unknown error') + '</div></div>';
      return;
    }

    const data = legacy.computeBadges({
      role: res.role,
      created_at: res.created_at,
      overall_power: res.overall_power,
      attended: res.attended,
      glory_best: res.glory_best
    });
    this.state.badgesLoaded = true;
    if (data) this.renderBadgesBody(data);
  }

  // ── Panel: Active Events ────────────────────────────────────────────────
  private renderEventsPanel(): void {
    const panel = document.getElementById('portal-panel-events');
    if (!panel) return;

    const sessions = this.state.sessions || [];
    const submittedCount = sessions.filter((s) => s.is_pending || s.validated).length;

    const headerHtml =
      '<header class="gm-page-header">' +
        '<div>' +
          '<h1 class="gm-page-title">Active Events</h1>' +
          '<p class="gm-page-subtitle">Tell the officers you took part and submit your scores</p>' +
        '</div>' +
      '</header>';

    if (!sessions || sessions.length === 0) {
      panel.innerHTML = headerHtml + '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-calendar-blank gm-icon"></i><div class="gm-empty-title">No active events right now.</div><div class="gm-empty-sub">When your guild starts an event, it will show up here for you to fill in.</div></div>';
      return;
    }

    const summaryHtml =
      '<div class="portal-events-summary">' +
        '<div class="portal-events-summary-item"><span class="portal-events-summary-value">' + sessions.length + '</span><span class="portal-events-summary-label">Active events</span></div>' +
        '<div class="portal-events-summary-item"><span class="portal-events-summary-value">' + (sessions.length - submittedCount) + '</span><span class="portal-events-summary-label">To submit</span></div>' +
        '<div class="portal-events-summary-item"><span class="portal-events-summary-value">' + submittedCount + '</span><span class="portal-events-summary-label">Submitted</span></div>' +
      '</div>';

    let html = '';
    sessions.forEach((sess) => {
      html += this.renderEventCard(sess);
    });
    panel.innerHTML = headerHtml + summaryHtml + '<div class="portal-events-grid">' + html + '</div>';
    this.wireEventCards(panel);
  }

  private renderEventCard(sess: any): string {
    const eventName = sess.event_name;
    const isSvsOrGvg = eventName === 'SvS' || eventName === 'GvG';
    // Shadowfront sessions are named per squad ("Shadowfront Squad 1").
    const isShadowfront = /^Shadowfront( Squad [12])?$/.test(eventName);
    const icon = legacy.getEventIcon(eventName);
    const accent = this.eventAccent(eventName);

    const EVENTS_WITHOUT_SCORE = ['Defend Trade Route', 'ARMS RACE STAGE A', 'ARMS RACE STAGE B'];
    const hasScore = !isShadowfront && EVENTS_WITHOUT_SCORE.indexOf(eventName) === -1;

    // get-active-sessions returns each session's row fields flat. This read a
    // `current_data` key the server never sent, so every card said "Not
    // submitted yet" whatever the database held.
    const curr = sess;
    const isValidated = !!curr.validated;
    const notInSession = curr.in_session === false;
    const isChecked = curr.participated > 0;
    const isLateChecked = !!curr.late;
    const isPending = !!curr.is_pending;

    const statusHtml = isValidated
      ? '<span class="portal-status portal-status-done"><i class="ph ph-seal-check"></i> Confirmed by an officer</span>'
      : isPending
        ? '<span class="portal-status portal-status-pending"><i class="ph ph-hourglass"></i> Awaiting approval</span>'
        : notInSession
          ? '<span class="portal-status portal-status-todo"><i class="ph ph-info"></i> ' + (isShadowfront ? 'Not in this squad' : 'Not in this event') + '</span>'
          : '<span class="portal-status portal-status-todo"><i class="ph ph-pencil-line"></i> Not submitted yet</span>';

    const startLabel = sess.start_at ? legacy.formatDateTimeUTC(sess.start_at) : '';

    const fieldsHtml =
      '<div class="portal-participation-box">' +
        '<label class="portal-participation-toggle">' +
          '<div class="check-toggle">' +
            '<input type="checkbox" class="participation-checkbox portal-check-participated" ' + (isChecked ? 'checked' : '') + '>' +
            '<span class="check-slider"></span>' +
          '</div>' +
          '<div class="portal-participation-text">' +
            '<span class="portal-participation-title">I participated in this event</span>' +
            '<span class="portal-participation-hint">Mark this to tell the officers you were there</span>' +
          '</div>' +
        '</label>' +
      '</div>';

    // "I was appointed" (DTR) and "I was excused" (Shadowfront) are not
    // offered: member-portal discards both on purpose -- a player cannot
    // credit their own appointment or excuse their own absence -- so the
    // toggles looked saved and wrote nothing. Officers set them.
    let detailsHtml = '';
    if (isShadowfront) {
      detailsHtml = '<div class="portal-details-label">Details (optional)</div><div class="portal-details-row">' +
        '<label class="portal-toggle-label"><div class="check-toggle"><input type="checkbox" class="participation-checkbox portal-check-late" ' + (isLateChecked ? 'checked' : '') + '><span class="check-slider"></span></div><span>I was late</span></label>' +
        '</div>';
    }

    let scoreHtml = '';
    if (hasScore) {
      scoreHtml = '<div class="portal-score-section">';
      if (isSvsOrGvg) {
        scoreHtml +=
          '<div class="portal-score-fields">' +
            '<div class="portal-field"><label class="portal-field-label">Days 1-5 score</label><input type="text" class="gm-input gm-input-sm portal-score-prep" value="' + legacy.esc(curr.score_prep != null ? curr.score_prep : '') + '" placeholder="e.g. 150000"></div>' +
            '<div class="portal-field"><label class="portal-field-label">Day 6 score</label><input type="text" class="gm-input gm-input-sm portal-score-pvp" value="' + legacy.esc(curr.score_pvp != null ? curr.score_pvp : '') + '" placeholder="e.g. 50000"></div>' +
          '</div>' +
          '<div class="portal-score-total"><span class="portal-score-total-label">Total</span><span class="portal-score-total-value" data-total>0</span></div>';
      } else {
        scoreHtml +=
          '<div class="portal-score-fields">' +
            '<div class="portal-field"><label class="portal-field-label">Score</label><input type="text" class="gm-input gm-input-sm portal-score" value="' + legacy.esc(curr.score != null ? curr.score : '') + '" placeholder="e.g. 45000"></div>' +
          '</div>' +
          '<div class="portal-score-total"><span class="portal-score-total-label">Score</span><span class="portal-score-total-value" data-total>0</span></div>';
      }
      scoreHtml += '</div>';
    }

    const submitBtnHtml = (isValidated || notInSession)
      ? ''
      : isPending
      ? '<button type="button" class="gm-btn gm-btn-success gm-btn-sm portal-submit-event-btn" disabled><i class="ph ph-check-circle"></i><span>Submitted</span></button>'
      : '<button type="button" class="gm-btn gm-btn-primary gm-btn-sm portal-submit-event-btn"><i class="ph ph-paper-plane-right"></i><span>Submit</span></button>';

    return '<div class="portal-event-card' + ((isPending || isValidated) ? ' portal-event-submitted' : '') + '" data-event="' + legacy.esc(eventName) + '" data-session="' + legacy.esc(sess.session_id) + '">' +
              '<div class="portal-event-head">' +
                '<div class="portal-event-icon" style="background:' + accent + '1f; color:' + accent + ';"><i class="ph ' + icon + '"></i></div>' +
                '<div class="portal-event-head-info">' +
                  '<div class="portal-event-title">' + legacy.esc(eventName) + '</div>' +
                  (startLabel ? '<div class="portal-event-sub"><i class="ph ph-clock"></i> ' + legacy.esc(startLabel) + '</div>' : '') +
                '</div>' +
                statusHtml +
              '</div>' +
              '<div class="portal-event-fields">' + fieldsHtml + detailsHtml + scoreHtml + '</div>' +
              submitBtnHtml +
            '</div>';
  }

  private async wireEventCards(panel: Element): Promise<void> {
    panel.querySelectorAll('.portal-score, .portal-score-prep, .portal-score-pvp').forEach((inp) => {
      legacy.attachNumberFormatter(inp);
      inp.addEventListener('input', () => { this.updateCardTotal(inp.closest('.portal-event-card')); });
    });

    panel.querySelectorAll('.portal-event-card').forEach((card) => {
      this.updateCardTotal(card);
    });

    panel.querySelectorAll('.portal-check-appointed').forEach((el) => {
      const cb = el as HTMLInputElement;
      cb.addEventListener('change', () => {
        if (cb.checked) {
          const card = cb.closest('.portal-event-card');
          const partCb = card ? card.querySelector('.portal-check-participated') as HTMLInputElement | null : null;
          if (partCb) partCb.checked = true;
        }
      });
    });

    panel.querySelectorAll('.portal-submit-event-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.portal-event-card') as HTMLElement | null;
        if (!card) return;
        const eventName = card.getAttribute('data-event');
        const sessionId = card.getAttribute('data-session');

        const participated = (card.querySelector('.portal-check-participated') as HTMLInputElement | null)?.checked;
        const appointed = (card.querySelector('.portal-check-appointed') as HTMLInputElement | null)?.checked;
        const late = (card.querySelector('.portal-check-late') as HTMLInputElement | null)?.checked;
        const excused = (card.querySelector('.portal-check-excused') as HTMLInputElement | null)?.checked;

        const scoreVal = (card.querySelector('.portal-score') as HTMLInputElement | null)?.value;
        const scorePrepVal = (card.querySelector('.portal-score-prep') as HTMLInputElement | null)?.value;
        const scorePvpVal = (card.querySelector('.portal-score-pvp') as HTMLInputElement | null)?.value;

        if (!participated && !appointed && !late && !excused &&
          !(scoreVal && scoreVal.replace(/[^0-9]/g, '')) &&
          !(scorePrepVal && scorePrepVal.replace(/[^0-9]/g, '')) &&
          !(scorePvpVal && scorePvpVal.replace(/[^0-9]/g, ''))) {
          legacy.showToast('Nothing to submit. Check participation or enter a score.', 'warning');
          return;
        }

        const payload: Record<string, any> = {
          event_name: eventName,
          session_id: sessionId,
          participated: participated,
          appointed: appointed,
          late: late,
          excused: excused,
          score: scoreVal !== undefined ? legacy.parseNumber(scoreVal) : undefined,
          score_prep: scorePrepVal !== undefined ? legacy.parseNumber(scorePrepVal) : undefined,
          score_pvp: scorePvpVal !== undefined ? legacy.parseNumber(scorePvpVal) : undefined
        };

        (btn as HTMLButtonElement).disabled = true;
        const span = btn.querySelector('span');
        const origText = span ? span.textContent : '';
        if (span) span.textContent = 'Submitting...';

        try {
          const res = await this.invoke('submit-scores', payload);
          if (!res.ok) throw new Error(res.error || 'submit_failed');
          legacy.showToast('Submitted! An officer will confirm it shortly.', 'success');
          const sess = (this.state.sessions || []).find((x: any) => x.event_name === eventName && x.session_id === sessionId);
          if (sess) {
            sess.is_pending = true;
            if (participated !== undefined) sess.participated = !!participated;
            if (payload.score !== undefined) sess.score = payload.score;
            if (payload.score_prep !== undefined) sess.score_prep = payload.score_prep;
            if (payload.score_pvp !== undefined) sess.score_pvp = payload.score_pvp;
            if (late !== undefined) sess.late = !!late;
          }
          this.renderEventsPanel();
        } catch (err: any) {
          console.error(err);
          legacy.showToast(submitErrorMessage(err && err.message), 'error');
          (btn as HTMLButtonElement).disabled = false;
          if (span) span.textContent = origText;
        }
      });
    });
  }

  private updateCardTotal(card: Element | null): void {
    if (!card) return;
    const totalEl = card.querySelector('[data-total]');
    if (!totalEl) return;
    const prep = legacy.parseNumber((card.querySelector('.portal-score-prep') as HTMLInputElement | null)?.value || '');
    const pvp = legacy.parseNumber((card.querySelector('.portal-score-pvp') as HTMLInputElement | null)?.value || '');
    const single = legacy.parseNumber((card.querySelector('.portal-score') as HTMLInputElement | null)?.value || '');
    const total = (prep || 0) + (pvp || 0) + (single || 0);
    totalEl.textContent = legacy.formatNumber(total || 0);
  }

  // ── Panel: My Info ──────────────────────────────────────────────────────
  private renderSettingsPanel(): void {
    const panel = document.getElementById('portal-panel-settings');
    if (!panel) return;

    panel.innerHTML =
      '<header class="gm-page-header">' +
        '<div>' +
          '<h1 class="gm-page-title">My Info</h1>' +
          '<p class="gm-page-subtitle">Manage your power, military metrics, glory, timezone and guild transfer requests</p>' +
        '</div>' +
      '</header>' +
      '<div class="portal-settings-grid">' +
        '<div class="portal-card" style="grid-column: 1 / -1;">' +
          '<div class="portal-card-title" style="display:flex; justify-content:space-between; align-items:center;">' +
            '<span><i class="ph ph-shield-chevron"></i> My Military Force Metrics</span>' +
            '<button class="gm-help-btn" data-help-id="help-portal-power" aria-label="Help: My Military Metrics"><i class="ph ph-info"></i></button>' +
          '</div>' +
          '<div class="portal-settings-sub" style="font-size: var(--fs-base); color:var(--text-muted); margin-bottom:1rem;">' +
            'Keep your combat metrics up to date to help your officers build optimal squads for SvS, GvG, and Shadowfront.' +
          '</div>' +
          '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.85rem; margin-bottom: 1rem;">' +
            '<div class="portal-field"><label for="portal-user-power" style="font-size: var(--fs-sm); font-weight:600; color:var(--fg); margin-bottom:0.25rem; display:block;">Overall Total Power</label><input type="text" id="portal-user-power" class="gm-input" placeholder="e.g. 100000000" value="' + legacy.esc(this.state.player.overall_power || '') + '"></div>' +
            '<div class="portal-field"><label for="portal-user-fleet" style="font-size: var(--fs-sm); font-weight:600; color:#60a5fa; margin-bottom:0.25rem; display:block;">⚔️ Fleet Rating (March 1)</label><input type="text" id="portal-user-fleet" class="gm-input" placeholder="e.g. 2000000" value="' + legacy.esc(this.state.player.fleet_rating || '') + '"></div>' +
            '<div class="portal-field"><label for="portal-user-tech" style="font-size: var(--fs-sm); font-weight:600; color:#a78bfa; margin-bottom:0.25rem; display:block;">🔬 Technology Power</label><input type="text" id="portal-user-tech" class="gm-input" placeholder="e.g. 15000000" value="' + legacy.esc(this.state.player.tech_power || '') + '"></div>' +
            '<div class="portal-field"><label for="portal-user-flagship" style="font-size: var(--fs-sm); font-weight:600; color:#fbbf24; margin-bottom:0.25rem; display:block;">🚀 Flagship Power</label><input type="text" id="portal-user-flagship" class="gm-input" placeholder="e.g. 10000000" value="' + legacy.esc(this.state.player.flagship_power || '') + '"></div>' +
            '<div class="portal-field"><label for="portal-user-champion" style="font-size: var(--fs-sm); font-weight:600; color:#f472b6; margin-bottom:0.25rem; display:block;">👑 Champions Total Power</label><input type="text" id="portal-user-champion" class="gm-input" placeholder="e.g. 30000000" value="' + legacy.esc(this.state.player.champion_power || '') + '"></div>' +
            '<div class="portal-field"><label for="portal-user-crew" style="font-size: var(--fs-sm); font-weight:600; color:#38bdf8; margin-bottom:0.25rem; display:block;">👥 Crew Total Power</label><input type="text" id="portal-user-crew" class="gm-input" placeholder="e.g. 5000000" value="' + legacy.esc(this.state.player.crew_power || '') + '"></div>' +
            '<div class="portal-field"><label for="portal-user-glory" style="font-size: var(--fs-sm); font-weight:600; color:#34d399; margin-bottom:0.25rem; display:block;">🏆 Glory Score</label><input type="text" id="portal-user-glory" class="gm-input" placeholder="e.g. 50000000" value="' + legacy.esc(this.state.player.glory_score || this.state.player.glory || '') + '"></div>' +
          '</div>' +
          '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem;">' +
            '<div id="portal-metrics-summary" style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">' +
              '<span class="gm-chip" id="portal-density-chip" style="color:#818cf8; background:rgba(99,102,241,0.12); border:1px solid rgba(99,102,241,0.3); font-size: var(--fs-sm);"><i class="ph ph-shield-check"></i> Density: ' + legacy.density(this.state.player) + '%</span>' +
              '<span class="gm-chip" id="portal-combativity-chip" style="color:#34d399; background:rgba(52,211,153,0.12); border:1px solid rgba(52,211,153,0.3); font-size: var(--fs-sm);"><i class="ph ph-crosshair"></i> Combativity: ' + legacy.combativity(this.state.player) + 'x</span>' +
            '</div>' +
            '<button type="button" id="portal-update-metrics-btn" class="gm-btn gm-btn-primary"><i class="ph ph-floppy-disk"></i><span>Save Military Metrics</span></button>' +
          '</div>' +
          '<div class="portal-msg" id="portal-metrics-msg"></div>' +
        '</div>' +

        '<div class="portal-card">' +
          '<div class="portal-card-title"><i class="ph ph-clock"></i> My Timezone<button class="gm-help-btn" data-help-id="help-portal-timezone" aria-label="Help: My Timezone"><i class="ph ph-info"></i></button></div>' +
          '<div class="portal-row"><select id="portal-timezone-select" class="gm-input"></select><button type="button" id="portal-timezone-detect-btn" class="gm-btn gm-btn-ghost gm-btn-sm" title="Detect my timezone"><i class="ph ph-crosshair"></i><span>Auto</span></button><button type="button" id="portal-timezone-btn" class="gm-btn gm-btn-primary gm-btn-sm"><i class="ph ph-floppy-disk"></i><span>Save</span></button></div>' +
          '<div class="portal-msg" id="portal-timezone-msg"></div>' +
          '<div class="portal-timezone-hint"><i class="ph ph-info"></i> Helps officers plan events when most players are available.</div>' +
        '</div>' +

        '<div class="portal-card">' +
          '<div class="portal-card-title"><i class="ph ph-discord-logo"></i> Link Discord<button class="gm-help-btn" data-help-id="help-portal-discord-link" aria-label="Help: Link Discord"><i class="ph ph-info"></i></button></div>' +
          '<div class="portal-row"><input type="text" id="portal-discord-code-input" class="gm-input" maxlength="6" placeholder="Code from /link in Discord" autocomplete="off" style="text-transform:uppercase;"><button type="button" id="portal-discord-link-btn" class="gm-btn gm-btn-primary gm-btn-sm"><i class="ph ph-link"></i><span>Confirm</span></button></div>' +
          '<div class="portal-msg" id="portal-discord-link-msg"></div>' +
          '<div class="portal-timezone-hint"><i class="ph ph-info"></i> Run <code>/link</code> in Discord first, then paste the code here to enable player commands like <code>/myinfo</code>.</div>' +
        '</div>' +

        '<div class="portal-card">' +
          '<div class="portal-card-title"><i class="ph ph-swap"></i> Request Guild Transfer<button class="gm-help-btn" data-help-id="help-portal-transfer" aria-label="Help: Guild Transfer"><i class="ph ph-info"></i></button></div>' +
          '<div class="portal-row"><select id="portal-transfer-select" class="gm-input"><option value="">Select Target Guild...</option></select><button type="button" id="portal-transfer-btn" class="gm-btn gm-btn-primary gm-btn-sm" disabled><i class="ph ph-paper-plane-tilt"></i><span>Send</span></button></div>' +
          '<div id="portal-transfer-msg" class="portal-msg"></div>' +
        '</div>' +

      '</div>';

    const powerInput = document.getElementById('portal-user-power') as HTMLInputElement | null;
    const fleetInput = document.getElementById('portal-user-fleet') as HTMLInputElement | null;
    const techInput = document.getElementById('portal-user-tech') as HTMLInputElement | null;
    const flagshipInput = document.getElementById('portal-user-flagship') as HTMLInputElement | null;
    const champInput = document.getElementById('portal-user-champion') as HTMLInputElement | null;
    const crewInput = document.getElementById('portal-user-crew') as HTMLInputElement | null;
    const gloryInput = document.getElementById('portal-user-glory') as HTMLInputElement | null;
    const metricsBtn = document.getElementById('portal-update-metrics-btn') as HTMLButtonElement | null;
    const metricsMsg = document.getElementById('portal-metrics-msg');

    const parseIntVal = (el: HTMLInputElement | null): number => el ? (parseInt(String(el.value).replace(/[^0-9]/g, ''), 10) || 0) : 0;

    [powerInput, fleetInput, techInput, flagshipInput, champInput, crewInput, gloryInput].forEach((inp) => {
      if (inp) {
        legacy.attachNumberFormatter(inp);
        inp.addEventListener('input', () => {
          const curObj = {
            overall_power: parseIntVal(powerInput),
            fleet_rating: parseIntVal(fleetInput),
            tech_power: parseIntVal(techInput),
            flagship_power: parseIntVal(flagshipInput),
            champion_power: parseIntVal(champInput),
            crew_power: parseIntVal(crewInput),
            glory_score: parseIntVal(gloryInput)
          };
          const d = legacy.density(curObj);
          const c = legacy.combativity(curObj);
          const dChip = document.getElementById('portal-density-chip');
          const cChip = document.getElementById('portal-combativity-chip');
          if (dChip) dChip.innerHTML = '<i class="ph ph-shield-check"></i> Density: ' + d + '%';
          if (cChip) cChip.innerHTML = '<i class="ph ph-crosshair"></i> Combativity: ' + c + 'x';
        });
      }
    });

    if (metricsBtn) metricsBtn.addEventListener('click', async () => {
      const totalVal = parseIntVal(powerInput);
      const fleetVal = parseIntVal(fleetInput);
      const techVal = parseIntVal(techInput);
      const flagshipVal = parseIntVal(flagshipInput);
      const champVal = parseIntVal(champInput);
      const crewVal = parseIntVal(crewInput);
      const gloryVal = parseIntVal(gloryInput);

      if (totalVal < 0) {
        legacy.showToast('Please enter a valid power number.', 'error');
        return;
      }

      metricsBtn.disabled = true;
      const span = metricsBtn.querySelector('span');
      const origText = span ? span.textContent : '';
      if (span) span.textContent = 'Saving...';

      try {
        const res = await this.invoke('update-metrics', {
          total_power: totalVal, fleet_rating: fleetVal, tech_power: techVal,
          flagship_power: flagshipVal, champion_power: champVal, crew_power: crewVal, glory_score: gloryVal
        });
        if (!res.ok) throw new Error(res.error || 'update_failed');

        this.state.player.overall_power = totalVal;
        this.state.player.fleet_rating = fleetVal;
        this.state.player.tech_power = techVal;
        this.state.player.flagship_power = flagshipVal;
        this.state.player.champion_power = champVal;
        this.state.player.crew_power = crewVal;
        this.state.player.glory_score = gloryVal;
        this.state.player.glory = gloryVal;

        const headerPower = document.querySelector('.portal-header-power-value');
        if (headerPower) headerPower.textContent = legacy.formatPower(totalVal);

        if (metricsMsg) {
          metricsMsg.textContent = 'Military force metrics saved successfully!';
          (metricsMsg as HTMLElement).style.color = 'var(--success)';
          (metricsMsg as HTMLElement).style.display = 'block';
        }
        legacy.showToast('Your military force metrics have been updated!', 'success');
      } catch (err: any) {
        if (metricsMsg) {
          metricsMsg.textContent = 'Failed to save: ' + err.message;
          (metricsMsg as HTMLElement).style.color = 'var(--danger)';
          (metricsMsg as HTMLElement).style.display = 'block';
        }
        legacy.showToast('Failed to update metrics: ' + err.message, 'error');
      } finally {
        metricsBtn.disabled = false;
        if (span) span.textContent = origText;
      }
    });

    // Timezone
    const tzSelect = document.getElementById('portal-timezone-select') as HTMLSelectElement | null;
    const tzDetectBtn = document.getElementById('portal-timezone-detect-btn') as HTMLButtonElement | null;
    const tzBtn = document.getElementById('portal-timezone-btn') as HTMLButtonElement | null;
    const tzMsg = document.getElementById('portal-timezone-msg');
    if (tzSelect) {
      const currentTz = (this.state.player && this.state.player.timezone) || '';
      const tzRegions = Array.from(new Set(COMMON_TIMEZONES.map((z) => z.region)));
      let tzOptions = '<option value="">-- Select your timezone --</option>';
      tzRegions.forEach((region) => {
        const zones = COMMON_TIMEZONES.filter((z) => z.region === region);
        tzOptions += '<optgroup label="' + legacy.esc(region) + '">';
        zones.forEach((z) => {
          const selected = currentTz === z.zone ? ' selected' : '';
          tzOptions += '<option value="' + legacy.esc(z.zone) + '"' + selected + '>' + legacy.esc(z.label) + '</option>';
        });
        tzOptions += '</optgroup>';
      });
      if (currentTz && !COMMON_TIMEZONES.some((z) => z.zone === currentTz)) {
        tzOptions += '<optgroup label="Custom"><option value="' + legacy.esc(currentTz) + '" selected>' + legacy.esc(currentTz) + '</option></optgroup>';
      }
      tzSelect.innerHTML = tzOptions;
    }

    if (tzDetectBtn && tzSelect) {
      tzDetectBtn.addEventListener('click', () => {
        const detected = detectUserTimezone();
        let exists = false;
        for (let i = 0; i < tzSelect.options.length; i++) {
          if (tzSelect.options[i].value === detected) {
            tzSelect.selectedIndex = i;
            exists = true;
            break;
          }
        }
        if (!exists && detected) {
          const opt = document.createElement('option');
          opt.value = detected;
          opt.textContent = detected + ' (Detected)';
          opt.selected = true;
          tzSelect.appendChild(opt);
        }
        legacy.showToast('Detected timezone: ' + detected, 'info');
      });
    }

    if (tzBtn && tzSelect) {
      tzBtn.addEventListener('click', async () => {
        const tzValue = tzSelect.value.trim();
        const offset = tzValue ? getTimezoneOffset(tzValue) : (this.state.player && this.state.player.timezone_offset != null ? this.state.player.timezone_offset : 0);
        tzBtn.disabled = true;
        const span = tzBtn.querySelector('span');
        const origText = span ? span.textContent : '';
        if (span) span.textContent = 'Saving...';
        try {
          const res = await this.invoke('update-timezone', { offset, timezone: tzValue || null });
          if (!res.ok) throw new Error(res.error || 'update_failed');
          if (this.state.player) {
            this.state.player.timezone_offset = offset;
            this.state.player.timezone = tzValue || null;
          }
          if (tzMsg) {
            tzMsg.textContent = 'Timezone saved. Your officers can now see when you are available.';
            (tzMsg as HTMLElement).style.color = 'var(--success)';
            (tzMsg as HTMLElement).style.display = 'block';
          }
          legacy.showToast('Timezone updated!', 'success');
        } catch (err: any) {
          if (tzMsg) {
            tzMsg.textContent = 'Failed to save: ' + err.message;
            (tzMsg as HTMLElement).style.color = 'var(--danger)';
            (tzMsg as HTMLElement).style.display = 'block';
          }
        } finally {
          tzBtn.disabled = false;
          if (span) span.textContent = origText;
        }
      });
    }

    // Link Discord
    const discordCodeInput = document.getElementById('portal-discord-code-input') as HTMLInputElement | null;
    const discordLinkBtn = document.getElementById('portal-discord-link-btn') as HTMLButtonElement | null;
    const discordLinkMsg = document.getElementById('portal-discord-link-msg');
    if (discordLinkBtn && discordCodeInput) {
      discordLinkBtn.addEventListener('click', async () => {
        const code = discordCodeInput.value.trim().toUpperCase();
        if (!code) return;
        discordLinkBtn.disabled = true;
        const span = discordLinkBtn.querySelector('span');
        const origText = span ? span.textContent : '';
        if (span) span.textContent = 'Linking...';
        try {
          const res = await this.invoke('confirm-discord-link', { code });
          if (!res.ok) {
            const errMap: Record<string, string> = {
              invalid_code: 'That code is invalid or already used.',
              code_expired: 'That code has expired — run /link in Discord again.',
              already_linked: 'This Discord account or player account is already linked.'
            };
            throw new Error(errMap[res.error] || res.error || 'link_failed');
          }
          discordCodeInput.value = '';
          if (discordLinkMsg) {
            discordLinkMsg.textContent = 'Discord account linked! Player commands like /myinfo are now available.';
            (discordLinkMsg as HTMLElement).style.color = 'var(--success)';
            (discordLinkMsg as HTMLElement).style.display = 'block';
          }
          legacy.showToast('Discord linked!', 'success');
        } catch (err: any) {
          if (discordLinkMsg) {
            discordLinkMsg.textContent = err.message;
            (discordLinkMsg as HTMLElement).style.color = 'var(--danger)';
            (discordLinkMsg as HTMLElement).style.display = 'block';
          }
        } finally {
          discordLinkBtn.disabled = false;
          if (span) span.textContent = origText;
        }
      });
    }

    // Transfer
    const transferSelect = document.getElementById('portal-transfer-select') as HTMLSelectElement | null;
    const transferBtn = document.getElementById('portal-transfer-btn') as HTMLButtonElement | null;
    const transferMsg = document.getElementById('portal-transfer-msg');

    const setTransferMsg = (msg: string, type: string): void => {
      if (!transferMsg) return;
      transferMsg.textContent = msg;
      (transferMsg as HTMLElement).style.color = type === 'error' ? 'var(--danger)' : 'var(--success)';
      (transferMsg as HTMLElement).style.display = 'block';
    };

    this.invoke('get-transfer-guilds', {}).then((res: any) => {
      if (!transferSelect) return;
      if (!res.ok) {
        transferSelect.innerHTML = '<option value="">Unable to load guilds</option>';
        return;
      }
      if (!res.guilds || res.guilds.length === 0) {
        transferSelect.innerHTML = '<option value="">No other guild available for transfer right now</option>';
        return;
      }
      let opts = '<option value="">Select Target Guild...</option>';
      res.guilds.forEach((g: any) => {
        let displayName = g.name ? g.name : g.id;
        if (g.is_same_server === false) displayName += ' (Server #' + g.server_number + ' — Migration Window)';
        opts += '<option value="' + legacy.esc(g.id) + '">' + legacy.esc(displayName) + '</option>';
      });
      transferSelect.innerHTML = opts;
    });

    if (transferSelect && transferBtn) {
      transferSelect.addEventListener('change', () => {
        transferBtn.disabled = !transferSelect.value;
      });
      transferBtn.addEventListener('click', async () => {
        const targetGuild = transferSelect.value;
        if (!targetGuild) return;
        transferBtn.disabled = true;
        transferSelect.disabled = true;
        const span = transferBtn.querySelector('span');
        const origText = span ? span.textContent : '';
        if (span) span.textContent = 'Sending...';
        if (transferMsg) (transferMsg as HTMLElement).style.display = 'none';
        try {
          const res = await this.invoke('submit-transfer-request', { targetGuild });
          if (!res.ok) {
            const code = res.error || 'unknown';
            if (code === 'already_pending') setTransferMsg('You already have a pending transfer request.', 'error');
            else if (code === 'same_guild') setTransferMsg('You cannot transfer to your current guild.', 'error');
            else setTransferMsg('Transfer request failed (' + code + ').', 'error');
          } else {
            setTransferMsg('Transfer request sent! Waiting for approval.', 'success');
          }
        } catch (err) {
          setTransferMsg('An error occurred.', 'error');
        } finally {
          if (span) span.textContent = origText;
          transferBtn.disabled = !transferSelect.value;
          transferSelect.disabled = false;
        }
      });
    }

  }

  // ── Panel: Absence ──────────────────────────────────────────────────────
  private renderAbsencePanel(): void {
    const panel = document.getElementById('portal-panel-absence');
    if (!panel) return;

    panel.innerHTML =
      '<header class="gm-page-header">' +
        '<div>' +
          '<h1 class="gm-page-title">Absence</h1>' +
          '<p class="gm-page-subtitle">Let your officers know you will be away or less active. This is visible to your guild admins.</p>' +
        '</div>' +
      '</header>' +
      '<div id="portal-absence-body"><div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-circle-notch ph-spin gm-icon"></i><div class="gm-empty-title">Loading...</div></div></div>';

    this.loadAbsencePanel();
  }

  private async loadAbsencePanel(): Promise<void> {
    const body = document.getElementById('portal-absence-body');
    if (!body) return;

    const res = await this.invoke('get-absences', {});
    if (!res.ok) {
      body.innerHTML = '<div class="gm-empty" style="padding:2rem 0;"><i class="ph ph-warning-circle gm-icon"></i><div class="gm-empty-title">Unable to load your absences.</div></div>';
      return;
    }

    const absences = res.absences || [];
    const now = new Date();
    const hasActive = absences.some((a: any) => {
      return new Date(a.end_date + 'T23:59:59') >= now && new Date(a.start_date + 'T00:00:00') <= now;
    });
    const hasUpcoming = absences.some((a: any) => {
      return new Date(a.start_date + 'T00:00:00') > now;
    });

    const formHtml =
      '<div class="portal-card portal-absence-form">' +
        '<div class="portal-card-title"><i class="ph ph-calendar-plus"></i> Declare a period</div>' +
        '<div class="portal-absence-fields">' +
          '<div class="portal-field"><label class="portal-field-label">Type</label><select id="portal-absence-kind" class="gm-input"><option value="full">Full absence</option><option value="reduced">Reduced activity</option></select></div>' +
          '<div class="portal-field"><label class="portal-field-label">From</label><input type="date" id="portal-absence-start" class="gm-input"></div>' +
          '<div class="portal-field"><label class="portal-field-label">To</label><input type="date" id="portal-absence-end" class="gm-input"></div>' +
          '<div class="portal-field"><label class="portal-field-label">Note (optional)</label><input type="text" id="portal-absence-note" class="gm-input" placeholder="e.g. exams, work, holidays" maxlength="120"></div>' +
        '</div>' +
        '<div id="portal-absence-msg" class="portal-msg"></div>' +
        '<button type="button" id="portal-absence-save-btn" class="gm-btn gm-btn-primary gm-btn-sm"><i class="ph ph-floppy-disk"></i><span>Save</span></button>' +
      '</div>';

    let listHtml = '';
    if (absences.length === 0) {
      listHtml = '<div class="gm-empty" style="padding:1.5rem 0;"><i class="ph ph-calendar-blank gm-icon"></i><div class="gm-empty-title">No declared absences.</div></div>';
    } else {
      listHtml = '<div class="portal-absence-list">' + absences.map((a: any) => {
        const start = new Date(a.start_date + 'T00:00:00');
        const end = new Date(a.end_date + 'T23:59:59');
        const status = end < now
          ? '<span class="portal-absence-badge portal-absence-badge-past">Past</span>'
          : (start > now ? '<span class="portal-absence-badge portal-absence-badge-upcoming">Upcoming</span>'
             : '<span class="portal-absence-badge portal-absence-badge-active">Active</span>');
        const kindLabel = a.kind === 'reduced' ? 'Reduced activity' : 'Full absence';
        return '<div class="portal-absence-item" data-id="' + legacy.esc(a.id) + '">' +
                  '<div class="portal-absence-item-head">' +
                    '<div class="portal-absence-item-title"><i class="ph ' + (a.kind === 'reduced' ? 'ph-gauge' : 'ph-user-minus') + '"></i> ' + legacy.esc(kindLabel) + '</div>' +
                    status +
                  '</div>' +
                  '<div class="portal-absence-item-dates">' + legacy.esc(a.start_date) + ' → ' + legacy.esc(a.end_date) + '</div>' +
                  (a.note ? '<div class="portal-absence-item-note">' + legacy.esc(a.note) + '</div>' : '') +
                  '<button type="button" class="gm-btn gm-btn-ghost gm-btn-sm portal-absence-delete-btn" data-id="' + legacy.esc(a.id) + '"><i class="ph ph-trash"></i><span>Remove</span></button>' +
                '</div>';
      }).join('') + '</div>';
    }

    const noticeHtml = hasActive || hasUpcoming
      ? '<div class="portal-absence-notice"><i class="ph ph-info"></i> Officers can see your declaration in the guild panel.</div>'
      : '';

    body.innerHTML = formHtml + '<div class="portal-absence-section-title">Your declarations</div>' + listHtml + noticeHtml;

    const kindEl = document.getElementById('portal-absence-kind') as HTMLSelectElement | null;
    const startEl = document.getElementById('portal-absence-start') as HTMLInputElement | null;
    const endEl = document.getElementById('portal-absence-end') as HTMLInputElement | null;
    const noteEl = document.getElementById('portal-absence-note') as HTMLInputElement | null;
    const saveBtn = document.getElementById('portal-absence-save-btn') as HTMLButtonElement | null;
    const msgEl = document.getElementById('portal-absence-msg');

    const setMsg = (text: string, type: string): void => {
      if (!msgEl) return;
      msgEl.textContent = text;
      (msgEl as HTMLElement).style.color = type === 'error' ? 'var(--danger)' : 'var(--success)';
      (msgEl as HTMLElement).style.display = 'block';
    };

    if (saveBtn && startEl && endEl) {
      saveBtn.addEventListener('click', async () => {
        const start = startEl.value;
        const end = endEl.value;
        if (!start || !end) {
          setMsg('Pick a start and an end date.', 'error');
          return;
        }
        if (end < start) {
          setMsg('The end date cannot be before the start date.', 'error');
          return;
        }
        saveBtn.disabled = true;
        const span = saveBtn.querySelector('span');
        const origText = span ? span.textContent : '';
        if (span) span.textContent = 'Saving...';
        try {
          const res = await this.invoke('set-absence', {
            start_date: start,
            end_date: end,
            kind: kindEl ? kindEl.value : 'full',
            note: noteEl ? noteEl.value.trim() : ''
          });
          if (!res.ok) throw new Error(res.error || 'save_failed');
          setMsg('Absence declared. Your officers can now see it.', 'success');
          this.loadAbsencePanel();
        } catch (err: any) {
          setMsg('Failed to save: ' + err.message, 'error');
          saveBtn.disabled = false;
          if (span) span.textContent = origText;
        }
      });
    }

    body.querySelectorAll('.portal-absence-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        (btn as HTMLButtonElement).disabled = true;
        try {
          const res = await this.invoke('delete-absence', { id: btn.getAttribute('data-id') });
          if (!res.ok) throw new Error(res.error || 'delete_failed');
          this.loadAbsencePanel();
        } catch (err: any) {
          legacy.showToast('Failed to remove: ' + err.message, 'error');
          (btn as HTMLButtonElement).disabled = false;
        }
      });
    });
  }
}

/** Shared singleton instance (bridged to `window.GM_PORTAL` at cutover). */
export const portalView = new PortalView();

export default portalView;
