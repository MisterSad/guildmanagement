/**
 * src/modules/stats/views/StatsView.ts
 *
 * Strangler Phase 1 port of the legacy `stats.js` (1,463 lines) to a strict
 * TypeScript view module. This file is NOT bridged onto `window.GM_STATS` yet
 * (the legacy script still owns that global until the cutover step): it is
 * exercised by `tests/stats_view.test.js`, which asserts byte-for-byte parity
 * of the calculated data structures against the legacy implementation.
 *
 * Architecture:
 *   - Pure calculations are delegated to `StatsService` (single source of truth).
 *   - Pure typed helpers (`eventScoringKey`, `getWeekStart`, `formatWeek`,
 *     `formatNumber`, `avatarInit`, `getPowerTier`) are imported from `/src`.
 *   - The Supabase client, guild config, cache, i18n, auth session and the
 *     player-history dialog are imported directly (phase M4c). The module
 *     neither reads nor assigns any `window.GM*` variable.
 */

import { getWeekStart, formatWeek } from '../../../core/utils/date';
import { formatNumber, avatarInit, escapeHTML, formatPower } from '../../../core/utils/text';
import { getPowerTier } from '../../../core/scoring/combat';
import { t } from '../../../core/i18n/i18n';
import { getClient, ensureAuthSession } from '../../../core/api/supabase';
import { isFresh as isCacheFresh, markFresh as markCacheFresh } from '../../../core/cache/cache';
import { getGuildConfig } from '../../../core/config/guild-config';
import { getActiveGuild } from '../../../core/auth/roles';
import { showPlayerHistoryDialog } from '../../app/dialogs/dialogs.service';
import {
  StatsService,
  DEFAULT_EVENT_COEFFS,
  type EventCoeffs,
  type StatsMembersPayload,
  type AggregateMemberRow,
  type StatsHealthPayload,
  type StatsEventsPayload,
  type EventsMemberRow,
  type EventsWar,
  type HealthWar,
  type HealthPowerPoint,
  type HealthWeek,
  type ReliabilityRow,
  summariseEngagement,
  queryStatsWeeks,
  queryStatsHealth,
  queryStatsMembers,
  queryRosterPower,
  queryPendingIncomingTransfers,
  queryStatsEvents
} from '../stats.service';


// ── Local helpers (mirrors of stats.js internals) ─────────────────────────────

// Delegates to the single escaping boundary. This used to be a local copy that
// silently omitted the backtick, so StatsView escaped less than every other view.
function esc(str: unknown): string {
  return escapeHTML(str);
}

function fmt(num: number | null | undefined): string {
  if (num === null || num === undefined || Number.isNaN(num)) return '0';
  return formatNumber(num);
}

function getWeekNumber(ws?: string | null): number | '' {
  if (!ws) return '';
  const d = new Date(ws.length === 10 ? ws + 'T12:00:00Z' : ws);
  if (isNaN(d.getTime())) return '';
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
}

function isFutureWeek(weekStart?: string | null): boolean {
  if (!weekStart) return false;
  const cur = getWeekStart();
  if (!cur) return false;
  return String(weekStart).localeCompare(cur) > 0;
}

// keepOnlyPastOrCurrent() was removed with the last raw-row payload in phase
// S5. Every RPC now applies `week_start <= date_trunc('week', now())` in SQL,
// at the source, so a week that has not started cannot reach the client to be
// filtered out again. isFutureWeek() above is still used, on the week LIST.

/**
 * The event picker's keys are not the bucket names the aggregation uses.
 * `gm_stats_events` validates its argument against a fixed set, so this maps
 * once, here, instead of every call site guessing.
 */
function resolveEventBucket(eventName?: string): string {
  const key = String(eventName || '').trim().toLowerCase();
  if (key === 'svs') return 'SvS';
  if (key === 'gvg') return 'GvG';
  if (key.indexOf('shadowfront') !== -1) return 'Shadowfront';
  if (key.indexOf('arms race') !== -1) return 'Arms Race';
  if (key === 'dtr' || key.indexOf('defend trade route') !== -1) return 'DTR';
  if (key === 'glory') return 'Glory';
  return 'SvS';
}

function shortDate(iso?: string | null): string {
  if (!iso) return '-';
  return String(iso).slice(5, 10);
}

// formatBigNum() lived here: a byte-level duplicate of formatBigNumber() in
// src/modules/overview/overview.service.ts, and both duplicated
// formatCompactNumber()/formatPower() in src/core/utils/text.ts, which are the
// intended helpers. The Health tab uses formatPower(); the last caller of this
// copy went with the old cockpit.


const STATS_CACHE_TTL_MS = 15000;

// ── State ─────────────────────────────────────────────────────────────────────

type PrimaryView = 'cockpit' | 'leaderboard' | 'events';
type StatsPeriod = '1w' | '2w' | '4w' | '8w' | 'all';

interface StatsState {
  activeGuild: string | null;
  primaryView: PrimaryView;
  currentMode: string;
  selectedEvent: string;
  statsPeriod: StatsPeriod;
  selectedWeek: string;
  searchQuery: string;
  allWeeks: string[];
  activeWeeksLoaded: string[];
  /** How many weeks the trend comparison covers on each side; 0 when absent. */
  trendWeeks: number;
  /** war_sessions rows for the selected SvS/GvG bucket; empty otherwise. */
  eventWar: EventsWar[];
  /** How many sessions of the selected bucket ran in the window. */
  eventSessions: number;
  leaderboardData: any[];
  uidMap: Record<string, string>;
  isLoading: boolean;
}

function createState(): StatsState {
  return {
    // H2: no tenant until one is resolved; 'ALPHA' here meant every
    // pre-resolution render queried a real guild's stats.
    activeGuild: null,
    primaryView: 'leaderboard',
    currentMode: 'global',
    selectedEvent: 'SvS',
    statsPeriod: '1w',
    selectedWeek: '',
    searchQuery: '',
    allWeeks: [],
    activeWeeksLoaded: [],
    trendWeeks: 0,
    eventWar: [],
    eventSessions: 0,
    leaderboardData: [],
    uidMap: {},
    isLoading: false
  };
}

export class StatsView {
  private state: StatsState = createState();

  public getState(): StatsState {
    return this.state;
  }

  public load(): Promise<void> {
    return this.initAndLoad();
  }

  public loadSingleEvent(eventName: string, explicitWeeks?: string[]): Promise<void> {
    return this.loadSingleEventMode(eventName, explicitWeeks);
  }

  public renderLeaderboard(): void {
    this.renderLeaderboardImpl();
  }

  private getWeeksToLoad(): string[] {
    const state = this.state;
    if (state.statsPeriod === 'all') {
      return state.allWeeks.slice();
    }
    let count = 1;
    if (state.statsPeriod === '2w') count = 2;
    else if (state.statsPeriod === '4w') count = 4;
    else if (state.statsPeriod === '8w') count = 8;

    let idx = state.allWeeks.indexOf(state.selectedWeek);
    if (idx === -1) idx = 0;
    let weeks = state.allWeeks.slice(idx, idx + count);
    if (!weeks.length && state.selectedWeek) weeks = [state.selectedWeek];
    return weeks;
  }

  // ── Initialisation et Chargement ────────────────────────────────────────────

  private async initAndLoad(): Promise<void> {
    const state = this.state;
    if (state.isLoading) return;

    const cacheKey = 'stats:' + getActiveGuild();
    if (isCacheFresh(cacheKey, STATS_CACHE_TTL_MS)) {
      return;
    }

    state.isLoading = true;

    const db = getClient();
    if (!db) {
      console.warn('[GM_STATS] Base de données indisponible');
      state.isLoading = false;
      return;
    }

    await ensureAuthSession();

    state.activeGuild = getActiveGuild();
    if (!state.selectedWeek) {
      state.selectedWeek = getWeekStart();
    }

    // Restore saved mode
    let savedMode: string | null = null;
    try { savedMode = localStorage.getItem('gm_stats_mode'); } catch (_) { /* ignore */ }
    if (savedMode) {
      state.currentMode = savedMode;
      if (savedMode.indexOf('kpi-') === 0 || savedMode === 'cockpit') {
        state.primaryView = 'cockpit';
      } else if (['SvS', 'GvG', 'Shadowfront', 'Arms Race', 'DTR'].indexOf(savedMode) !== -1) {
        state.primaryView = 'events';
        state.selectedEvent = savedMode;
      } else {
        state.primaryView = 'leaderboard';
      }
    }

    try {
      await this.fetchAvailableWeeks();
      this.renderControls();

      if (state.primaryView === 'cockpit' || state.currentMode.indexOf('kpi-') === 0) {
        await this.renderCockpitView();
      } else if (state.primaryView === 'events' || ['SvS', 'GvG', 'Shadowfront', 'Arms Race', 'DTR'].indexOf(state.currentMode) !== -1) {
        await this.loadSingleEventMode(state.selectedEvent || state.currentMode);
      } else {
        await this.fetchAndComputeLeaderboard();
      }
      markCacheFresh(cacheKey);
    } catch (err) {
      console.error('[GM_STATS] load error', err);
    } finally {
      state.isLoading = false;
    }
  }

  private async fetchAvailableWeeks(): Promise<void> {
    const state = this.state;
    const db = getClient();
    if (!db) return;

    try {
      // `list_event_weeks` was dropped by migration 20260926070155 and no gm_*
      // twin was ever written, so this call answered { data: null, error } for
      // months. Nothing read `.error`, the list fell through to the single-week
      // fallback below, and every period filter (2w / 4w / 8w) silently became
      // 1w because it was slicing a one-element array. Read the error now.
      const rpcRes = await queryStatsWeeks(db, state.activeGuild);
      if (rpcRes.error) throw rpcRes.error;

      const payload = (rpcRes.data || {}) as { ok?: boolean; error?: string; weeks?: unknown };
      if (payload.ok === false) throw new Error(payload.error || 'stats_weeks_failed');

      let weeks: string[] = (Array.isArray(payload.weeks) ? payload.weeks : [])
        .map((w) => (typeof w === 'string' ? w : ''))
        .filter(Boolean);
      weeks = weeks.filter((w) => !isFutureWeek(w));
      weeks.sort((a, b) => b.localeCompare(a));

      if (weeks.length > 0) {
        state.allWeeks = weeks;
        if (!state.selectedWeek || weeks.indexOf(state.selectedWeek) === -1) {
          state.selectedWeek = weeks[0];
        }
      } else {
        const defW = getWeekStart();
        state.allWeeks = defW ? [defW] : [];
        state.selectedWeek = defW;
      }
    } catch (err) {
      console.warn('[GM_STATS] Erreur fetchAvailableWeeks', err);
      let fallbackW = '';
      try {
        fallbackW = getWeekStart();
      } catch (fallbackErr) {
        console.warn('[GM_STATS] Erreur fetchAvailableWeeks fallback', fallbackErr);
      }
      state.allWeeks = fallbackW ? [fallbackW] : [];
      state.selectedWeek = fallbackW;
    }
  }

  // ── Render Contrôles (Haut de page) ─────────────────────────────────────────

  private renderControls(): void {
    const state = this.state;
    const containers = document.querySelectorAll('.stats-controls');
    if (!containers || !containers.length) return;

    containers.forEach((el) => {
      if (state.primaryView === 'cockpit' || state.currentMode.indexOf('kpi-') === 0) {
        el.innerHTML = '';
        return;
      }

      const weekOpts = state.allWeeks.map((w) => {
        return '<option value="' + w + '"' + (w === state.selectedWeek ? ' selected' : '') + '>' + formatWeek(w) + '</option>';
      }).join('');

      const periodOpts = [
        { key: '1w', label: t('stats_period_1w') || '1 Week' },
        { key: '2w', label: t('stats_period_2w') || '2 Weeks' },
        { key: '4w', label: t('stats_period_4w') || '4 Weeks' },
        { key: '8w', label: t('stats_period_8w') || '8 Weeks' },
        { key: 'all', label: t('stats_period_all') || 'All Time (Total)' }
      ].map((p) => {
        return '<option value="' + p.key + '"' + (p.key === state.statsPeriod ? ' selected' : '') + '>' + esc(p.label) + '</option>';
      }).join('');

      // If in Event Analytics view: add event picker
      let eventPickerHtml = '';
      if (state.primaryView === 'events') {
        const eventsList = [
          { key: 'SvS', label: '⚔️ SvS Battle' },
          { key: 'GvG', label: '🚩 GvG War' },
          { key: 'Shadowfront', label: '🌌 Shadowfront (Squads & Attendance)' },
          { key: 'Arms Race', label: '🚀 Arms Race (Stage A & B)' },
          { key: 'DTR', label: '🛡️ DTR (Defend Route)' },
          { key: 'Glory', label: '✨ Glory' }
        ];
        eventPickerHtml = '<select class="gm-select event-select" aria-label="Event" style="width:auto; min-width:180px; font-weight:700;">' +
          eventsList.map((ev) => {
            return '<option value="' + ev.key + '"' + (ev.key === (state.selectedEvent || state.currentMode) ? ' selected' : '') + '>' + esc(ev.label) + '</option>';
          }).join('') +
        '</select>';
      }

      // The metric picker offered "Global Score (Composite)" and "Attendance
      // Rate (%)". Two answers to one question, in a dropdown, disagreeing
      // about the same member. Removed in phase S3: there is one board, and it
      // shows its components as columns instead of hiding them behind a choice.

      el.innerHTML =
        '<div class="gm-row" style="gap:.5rem; flex-wrap:wrap; align-items:center;">' +
          eventPickerHtml +
          '<select class="gm-select week-select" aria-label="Week" style="width:auto; min-width:160px;">' + weekOpts + '</select>' +
          '<select class="gm-select period-select" aria-label="Period" style="width:auto; min-width:140px;">' + periodOpts + '</select>' +
        '</div>';

      const eventSelect = el.querySelector('.event-select') as HTMLSelectElement | null;
      if (eventSelect) {
        eventSelect.addEventListener('change', () => {
          state.selectedEvent = eventSelect.value;
          state.currentMode = eventSelect.value;
          try { localStorage.setItem('gm_stats_mode', state.currentMode); } catch (_) { /* ignore */ }
          this.loadSingleEventMode(eventSelect.value);
        });
      }

      const weekSelect = el.querySelector('.week-select') as HTMLSelectElement | null;
      if (weekSelect) {
        weekSelect.addEventListener('change', () => {
          state.selectedWeek = weekSelect.value;
          if (state.primaryView === 'events') {
            this.loadSingleEventMode(state.selectedEvent || state.currentMode);
          } else {
            this.fetchAndComputeLeaderboard();
          }
        });
      }

      const periodSelect = el.querySelector('.period-select') as HTMLSelectElement | null;
      if (periodSelect) {
        periodSelect.addEventListener('change', () => {
          state.statsPeriod = periodSelect.value as StatsPeriod;
          if (state.primaryView === 'events') {
            this.loadSingleEventMode(state.selectedEvent || state.currentMode);
          } else {
            this.fetchAndComputeLeaderboard();
          }
        });
      }
    });
  }

  // ── 3 Vues Principales (Navigation Bar) ─────────────────────────────────────

  private getTabsHtml(): string {
    const state = this.state;
    const views = [
      { key: 'cockpit', label: 'Guild Cockpit', icon: 'ph-heartbeat' },
      { key: 'leaderboard', label: 'Leaderboard', icon: 'ph-trophy' },
      { key: 'events', label: 'Event Deep-Dive', icon: 'ph-sword' }
    ];

    // There used to be eleven more buttons here, rendered with
    // `style="display:none"` under the comment "Hidden aliases so all Vitest
    // test battery expectations pass with 100% green". They were not a
    // compatibility shim: `wireModeTabs` gave them a SECOND, complete switching
    // implementation that wrote `primaryView`, `currentMode` and
    // `localStorage.gm_stats_mode` differently from the visible one, and the
    // four `kpi-*` aliases all rendered the same cockpit -- four test names
    // describing one screen. Tests now drive `setView()` below, which is the
    // same method the visible buttons call, so there is one path and it is the
    // one the user actually exercises.
    return '<div class="gm-tabs-pill" style="margin-bottom:1.25rem; display:flex; gap:.5rem; flex-wrap:wrap;">' +
      views.map((v) => {
        const isActive = (state.primaryView === v.key);
        return '<button class="gm-tab-pill' + (isActive ? ' gm-active' : '') + '" data-gm-view="' + v.key + '" style="padding:.65rem 1.15rem; font-size: var(--fs-md); font-weight:700;">' +
          '<i class="ph ' + v.icon + '" style="font-size: var(--fs-xl);"></i> ' + esc(v.label) + '</button>';
      }).join('') +
    '</div>';
  }

  /**
   * Switches primary view, and optionally the mode within it. The single
   * switching path: the tab buttons call it, and so do the tests, which is what
   * stops the two from drifting.
   *
   * `mode` picks the event bucket when `view` is 'events'
   * ('SvS' | 'GvG' | 'Shadowfront' | 'Arms Race' | 'DTR'); it is ignored
   * otherwise, the leaderboard having only one metric since phase S3.
   */
  public async setView(view: PrimaryView, mode?: string): Promise<void> {
    const state = this.state;
    state.primaryView = view;

    if (view === 'cockpit') {
      state.currentMode = 'kpi-health';
    } else if (view === 'events') {
      state.currentMode = mode || state.selectedEvent || 'SvS';
      state.selectedEvent = state.currentMode;
    } else {
      state.currentMode = 'global';
    }

    try { localStorage.setItem('gm_stats_mode', state.currentMode); } catch (_) { /* ignore */ }
    this.renderControls();

    if (view === 'cockpit') {
      await this.renderCockpitView();
    } else if (view === 'events') {
      await this.loadSingleEventMode(state.selectedEvent);
    } else {
      await this.fetchAndComputeLeaderboard();
    }
  }

  private wireModeTabs(container: Element): void {
    // Wire Primary Views (Cockpit / Leaderboard / Events)
    container.querySelectorAll('[data-gm-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.getAttribute('data-gm-view') as PrimaryView;
        void this.setView(view);
      });
    });
  }

  // ── 1. VUE 1 : COCKPIT EXÉCUTIF ─────────────────────────────────────────────

  /**
   * The Health tab: is my guild getting better or worse, and where are we
   * losing?
   *
   * Phase S4. This used to be the "Guild Cockpit", and it computed everything
   * in the browser from the raw `gm_stats_data` dump. Two of its cards were
   * built on sand: "Weekly participation rate" divided by TODAY's roster size,
   * so every removal silently rewrote every historical bar, and "Members
   * engaged per event type" counted a member who attended one Arms Race day out
   * of eighty the same as one who attended all eighty.
   *
   * What it shows now is what the database already knew and the page never
   * asked for: the war record, the power curve, and who is actually turning up.
   */
  private async renderCockpitView(): Promise<void> {
    const state = this.state;
    const containers = document.querySelectorAll('.stats-leaderboard-area');
    if (!containers || !containers.length) return;
    const container = containers[0];
    const tabsHtml = this.getTabsHtml();

    const db = getClient();
    if (!db || !state.activeGuild) {
      container.innerHTML = tabsHtml + '<div class="gm-empty" style="padding:3rem;"><div class="gm-empty-title">Database unavailable.</div></div>';
      this.wireModeTabs(container);
      return;
    }

    container.innerHTML = tabsHtml + '<div class="gm-empty" style="padding:3rem;"><div class="gm-empty-title">Loading guild metrics...</div></div>';

    const g = state.activeGuild;
    try {
      const recentWeeks = state.allWeeks.slice(0, 4);
      const [healthRes, membersRes, rosterRes, transRes] = await Promise.all([
        queryStatsHealth(db, g),
        queryStatsMembers(db, g, recentWeeks, false),
        queryRosterPower(db, g),
        queryPendingIncomingTransfers(db, g)
      ]);

      if (healthRes.error) throw healthRes.error;
      const health = (healthRes.data || {}) as StatsHealthPayload;
      if (health.ok === false) throw new Error(health.error || 'stats_health_failed');

      const membersPayload = (membersRes.data || {}) as StatsMembersPayload;
      const coeffs = await this.getConfiguredCoeffs();
      const reliability = membersPayload.ok === false
        ? []
        : StatsService.computeReliabilityLeaderboard(membersPayload, coeffs);
      const segments = summariseEngagement(reliability);

      const roster: any[] = rosterRes.data || [];
      const pendingTransfers: any[] = transRes.data || [];

      const html = tabsHtml +
        this.renderHealthHeadline(health, segments, reliability) +
        this.renderEngagementCard(segments, reliability, recentWeeks.length) +
        '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap:.85rem; margin-top:.85rem;">' +
          this.renderWarCard(health) +
          this.renderPowerCard(health) +
        '</div>' +
        '<div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap:.85rem; margin-top:.85rem;">' +
          this.renderParticipationCard(health) +
          this.renderRosterCard(roster) +
        '</div>' +
        this.renderQualityCard(health, pendingTransfers);

      container.innerHTML = html;
      this.wireModeTabs(container);
    } catch (err) {
      console.error('[GM_STATS] Health error', err);
      container.innerHTML = tabsHtml + '<div class="gm-empty" style="padding:3rem;"><div class="gm-empty-title">Failed to load metrics.</div></div>';
      this.wireModeTabs(container);
    }
  }

  private renderHealthHeadline(
    health: StatsHealthPayload,
    segments: Record<string, number>,
    reliability: ReliabilityRow[]
  ): string {
    const measured = reliability.filter((r) => r.reliability !== null) as Array<ReliabilityRow & { reliability: number }>;
    const median = measured.length
      ? measured.slice().sort((a, b) => a.reliability - b.reliability)[Math.floor(measured.length / 2)].reliability
      : null;
    const pending = (health.quality && health.quality.pending_rows) || 0;
    return '<div class="gm-kpi-grid">' +
      kpiTile('Roster', health.roster_size || 0, 'ph-users', 'stat-theme-cyan') +
      kpiTile('Core members', segments.core || 0, 'ph-shield-check', (segments.core || 0) > 0 ? 'stat-theme-lime' : 'stat-theme-coral') +
      kpiTile('Dormant', segments.dormant || 0, 'ph-moon', (segments.dormant || 0) > (health.roster_size || 0) / 3 ? 'stat-theme-coral' : 'stat-theme-mint') +
      kpiTile('Median reliability', median === null ? '—' : median + '%', 'ph-gauge', 'stat-theme-lime') +
      (pending > 0 ? kpiTile('Pending approvals', pending, 'ph-hourglass', 'stat-theme-coral') : '') +
    '</div>';
  }

  /**
   * Four segments over the last four weeks. The cuts (60 and 30) are calibrated
   * against production rather than chosen for roundness -- see
   * ENGAGEMENT_THRESHOLDS in stats.service.ts.
   */
  private renderEngagementCard(segments: Record<string, number>, reliability: ReliabilityRow[], weeks: number): string {
    const order: Array<[string, string, string]> = [
      ['core', 'Core', '#34d399'],
      ['regular', 'Regular', '#a78bfa'],
      ['occasional', 'Occasional', '#fbbf24'],
      ['dormant', 'Dormant', '#f87171'],
      ['unmeasured', 'Unmeasured', 'var(--fg-dim)']
    ];
    const total = reliability.length || 1;
    const bars = order.filter(([key]) => (segments[key] || 0) > 0).map(([key, label, colour]) => {
      const n = segments[key] || 0;
      const pct = Math.round((n / total) * 100);
      return '<div class="gm-kpi-row">' +
        '<span class="gm-kpi-label">' + esc(label) + '</span>' +
        '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + pct + '%; background:' + colour + ';"></div></div>' +
        '<span class="gm-kpi-value">' + n + '</span>' +
      '</div>';
    }).join('');

    // The thresholds live here rather than in the labels: .gm-kpi-label is a
    // 96px column that ellipsises, so "Occasional (under 30%)" renders as
    // "Occasional (u...".
    const subtitle = weeks > 0
      ? 'Weighted reliability over the last ' + weeks + ' week' + (weeks > 1 ? 's' : '') +
        ' — core 60%+, regular 30-60%, occasional under 30%, dormant nothing at all'
      : 'No weeks with data yet';

    return '<div class="gm-kpi-card" style="margin-top:.85rem;">' +
      '<div class="gm-kpi-card-title"><i class="ph ph-users-three"></i> Engagement</div>' +
      '<div class="gm-kpi-card-body">' +
        '<div style="font-size: var(--fs-sm); color:var(--fg-dim); margin-bottom:.6rem;">' + esc(subtitle) + '</div>' +
        (bars || '<div style="color:var(--fg-dim);">Nothing to measure yet.</div>') +
      '</div>' +
    '</div>';
  }

  /**
   * War record. The per-day split is the actionable half: it says whether the
   * guild loses the preparation days or the PvP day. The denominator is days
   * actually RECORDED -- never assumed to be six.
   */
  private renderWarCard(health: StatsHealthPayload): string {
    const wars = health.war || [];
    if (!wars.length) {
      return '<div class="gm-kpi-card" style="margin-top:0;">' +
        '<div class="gm-kpi-card-title"><i class="ph ph-sword"></i> War record</div>' +
        '<div class="gm-kpi-card-body"><div style="color:var(--fg-dim);">No war sessions recorded yet. Open one from the SvS or GvG screen to start the record.</div></div>' +
      '</div>';
    }
    const body = wars.map((w: HealthWar) => {
      const total = w.day_wins + w.day_losses;
      const pct = total > 0 ? Math.round((w.day_wins / total) * 100) : 0;
      const colour = pct >= 60 ? '#34d399' : pct >= 40 ? '#fbbf24' : '#f87171';
      const days = [1, 2, 3, 4, 5, 6].map((d) => {
        const cell = (w.per_day || {})[String(d)];
        if (!cell || (cell.won + cell.lost) === 0) {
          return '<span title="Day ' + d + ': not recorded" style="color:var(--fg-dim);">·</span>';
        }
        const won = cell.won >= cell.lost;
        return '<span title="Day ' + d + ': ' + cell.won + ' won, ' + cell.lost + ' lost" style="color:' +
          (won ? '#34d399' : '#f87171') + '; font-weight:700;">' + (won ? 'W' : 'L') + '</span>';
      }).join(' ');
      return '<div style="margin-bottom:.75rem;">' +
        '<div class="gm-kpi-row">' +
          '<span class="gm-kpi-label">' + esc(w.event_name) + '</span>' +
          '<span class="gm-kpi-value" style="color:' + colour + ';">' + w.day_wins + 'W - ' + w.day_losses + 'L</span>' +
        '</div>' +
        '<div style="font-size: var(--fs-sm); color:var(--fg-dim); display:flex; gap:.5rem; align-items:center;">' +
          '<span>' + w.sessions + ' session' + (w.sessions > 1 ? 's' : '') + '</span>' +
          '<span style="letter-spacing:.2em; font-family:var(--font-display);">' + days + '</span>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="gm-kpi-card" style="margin-top:0;">' +
      '<div class="gm-kpi-card-title"><i class="ph ph-sword"></i> War record</div>' +
      '<div class="gm-kpi-card-body">' + body +
        '<div style="font-size: var(--fs-xs); color:var(--fg-dim);">Day 1 to 5 are preparation, day 6 is the battle. A dot means that day was never recorded.</div>' +
      '</div>' +
    '</div>';
  }

  /**
   * Power progression. Median, not sum: a guild's first OCR week covers part of
   * the roster (CLAW went from 11 players scanned to 114 in one week) and a sum
   * would draw a tenfold jump that never happened. Every point carries the
   * number of players it is based on.
   */
  private renderPowerCard(health: StatsHealthPayload): string {
    const series = (health.power && health.power.series) || [];
    if (series.length < 2) {
      return '<div class="gm-kpi-card" style="margin-top:0;">' +
        '<div class="gm-kpi-card-title"><i class="ph ph-trend-up"></i> Power progression</div>' +
        '<div class="gm-kpi-card-body"><div style="color:var(--fg-dim);">' +
          (series.length === 1
            ? 'Only one snapshot so far. A second weekly scan will start the curve.'
            : 'No power snapshots yet. They are written when you run a power or roster scan.') +
        '</div></div>' +
      '</div>';
    }
    const first = series[0];
    const last = series[series.length - 1];
    const growth = first.median > 0 ? Math.round(((last.median - first.median) / first.median) * 1000) / 10 : 0;
    const peak = series.reduce((a: number, p: HealthPowerPoint) => Math.max(a, p.median), 0) || 1;

    const bars = series.map((p: HealthPowerPoint) => {
      const pct = Math.round((p.median / peak) * 100);
      return '<div class="gm-kpi-row">' +
        '<span class="gm-kpi-label">' + esc(formatWeek(p.week_start).split(' ')[0]) + '</span>' +
        '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + pct + '%; background:#60a5fa;"></div></div>' +
        '<span class="gm-kpi-value" title="' + p.players + ' players scanned that week">' + formatPower(p.median) + '</span>' +
      '</div>';
    }).join('');

    return '<div class="gm-kpi-card" style="margin-top:0;">' +
      '<div class="gm-kpi-card-title"><i class="ph ph-trend-up"></i> Power progression</div>' +
      '<div class="gm-kpi-card-body">' +
        '<div style="font-size: var(--fs-sm); color:var(--fg-dim); margin-bottom:.6rem;">' +
          'Median member power, ' + series.length + ' snapshots. ' +
          '<strong style="color:' + (growth >= 0 ? '#34d399' : '#f87171') + ';">' +
          (growth >= 0 ? '+' : '') + growth + '%</strong> since ' + esc(first.week_start) +
          ' (based on ' + first.players + ' to ' + last.players + ' players scanned).' +
        '</div>' + bars +
      '</div>' +
    '</div>';
  }

  private renderParticipationCard(health: StatsHealthPayload): string {
    const weeks = health.participation || [];
    const roster = health.roster_size || 0;
    if (!weeks.length) {
      return '<div class="gm-kpi-card" style="margin-top:0;">' +
        '<div class="gm-kpi-card-title"><i class="ph ph-chart-line-up"></i> Members turning up each week</div>' +
        '<div class="gm-kpi-card-body"><div style="color:var(--fg-dim);">No weeks with data yet.</div></div>' +
      '</div>';
    }
    const peak = weeks.reduce((a: number, w: HealthWeek) => Math.max(a, w.present_members), 0) || 1;
    const bars = weeks.slice().reverse().map((w: HealthWeek) => {
      const pct = Math.round((w.present_members / peak) * 100);
      const share = roster > 0 ? Math.round((w.present_members / roster) * 100) : 0;
      const colour = share >= 70 ? '#34d399' : share >= 40 ? '#a78bfa' : '#f87171';
      return '<div class="gm-kpi-row">' +
        '<span class="gm-kpi-label">' + esc(formatWeek(w.week_start).split(' ')[0]) + '</span>' +
        '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + pct + '%; background:' + colour + ';"></div></div>' +
        '<span class="gm-kpi-value" title="' + w.opportunities + ' events ran that week">' + w.present_members + '</span>' +
      '</div>';
    }).join('');

    return '<div class="gm-kpi-card" style="margin-top:0;">' +
      '<div class="gm-kpi-card-title"><i class="ph ph-chart-line-up"></i> Members turning up each week</div>' +
      '<div class="gm-kpi-card-body">' + bars +
        '<div style="font-size: var(--fs-xs); color:var(--fg-dim); margin-top:.5rem;">' +
          'Distinct members present. The colour compares against today’s roster of ' + roster +
          '; the count itself does not, because the schema keeps no roster history.' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  private renderRosterCard(roster: any[]): string {
    const withPower = roster.filter((m) => (parseInt(m.overall_power, 10) || 0) > 0);
    const maxPower = roster.reduce((a, m) => Math.max(a, parseInt(m.overall_power, 10) || 0), 0);
    const tiers: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0 };
    roster.forEach((m) => {
      const tier = getPowerTier(m.overall_power, maxPower);
      if (tiers[tier] !== undefined) tiers[tier]++;
    });
    const tierColours: Record<string, string> = { S: '#fbbf24', A: '#f87171', B: '#c084fc', C: '#60a5fa', D: '#34d399' };
    const peak = Math.max(...Object.values(tiers), 1);
    const tierBars = ['S', 'A', 'B', 'C', 'D'].map((t) =>
      '<div class="gm-kpi-row">' +
        '<span class="gm-kpi-label">Tier ' + t + '</span>' +
        '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + Math.round((tiers[t] / peak) * 100) + '%; background:' + tierColours[t] + ';"></div></div>' +
        '<span class="gm-kpi-value">' + tiers[t] + '</span>' +
      '</div>').join('');

    const roles: Record<string, number> = {};
    roster.forEach((m) => { const r = m.role || 'R1'; roles[r] = (roles[r] || 0) + 1; });
    const rolePeak = Math.max(...Object.values(roles), 1);
    const roleBars = Object.keys(roles).sort().reverse().map((r) =>
      '<div class="gm-kpi-row">' +
        '<span class="gm-kpi-label">' + esc(r) + '</span>' +
        '<div class="gm-kpi-bar-track"><div class="gm-kpi-bar" style="width:' + Math.round((roles[r] / rolePeak) * 100) + '%; background:var(--accent);"></div></div>' +
        '<span class="gm-kpi-value">' + roles[r] + '</span>' +
      '</div>').join('');

    return '<div class="gm-kpi-card" style="margin-top:0;">' +
      '<div class="gm-kpi-card-title"><i class="ph ph-user-list"></i> Roster</div>' +
      '<div class="gm-kpi-card-body">' +
        '<div class="gm-kpi-inline" style="margin-bottom:.85rem;">' +
          kpiMini('Members', roster.length) +
          kpiMini('With power', withPower.length) +
          kpiMini('No power', roster.length - withPower.length) +
        '</div>' +
        '<div style="font-weight:700; font-size: var(--fs-sm); margin-bottom:.35rem; color:var(--fg-dim);">Power tiers</div>' + tierBars +
        '<div style="font-weight:700; font-size: var(--fs-sm); margin:.75rem 0 .35rem; color:var(--fg-dim);">Roles</div>' + roleBars +
      '</div>' +
    '</div>';
  }

  /**
   * Every other number on this page is a function of how completely the guild
   * records its events. Without this an admin reading 16% Arms Race attendance
   * cannot tell "nobody plays it" from "nobody records it".
   */
  private renderQualityCard(health: StatsHealthPayload, pendingTransfers: any[]): string {
    const q = health.quality || { pending_rows: 0, weeks_with_data: 0, last_week: null };
    const cov = health.coverage || {};
    const members = cov.members || 0;
    const sparse = ['tech_power', 'champion_power', 'crew_power', 'flagship_power', 'fleet_rating']
      .map((k) => ({ k, n: cov[k] || 0 }))
      .filter((x) => members > 0 && x.n / members < 0.6);

    const label: Record<string, string> = {
      tech_power: 'Tech', champion_power: 'Champions', crew_power: 'Crew',
      flagship_power: 'Flagship', fleet_rating: 'Fleet'
    };

    return '<div class="gm-kpi-card" style="margin-top:.85rem;">' +
      '<div class="gm-kpi-card-title"><i class="ph ph-seal-check"></i> How complete is this data?</div>' +
      '<div class="gm-kpi-card-body">' +
        '<div class="gm-kpi-inline" style="margin-bottom:.6rem;">' +
          kpiMini('Weeks recorded', q.weeks_with_data) +
          kpiMini('Last week', q.last_week ? String(q.last_week) : '—') +
          kpiMini('Awaiting approval', q.pending_rows) +
          kpiMini('Pending transfers', pendingTransfers.length) +
          ((q.scheduled_ahead || 0) > 0 ? kpiMini('Scheduled ahead', q.scheduled_ahead as number) : '') +
        '</div>' +
        (sparse.length
          ? '<div style="font-size: var(--fs-sm); color:var(--fg-dim);">Scanned for fewer than 60% of members, so they are left off the cards above: ' +
              sparse.map((x) => esc(label[x.k] || x.k) + ' (' + Math.round((x.n / members) * 100) + '%)').join(', ') + '.</div>'
          : '<div style="font-size: var(--fs-sm); color:var(--fg-dim);">Every metric is scanned for most of the roster.</div>') +
      '</div>' +
    '</div>';
  }

  // ── 2. VUE 2 & 3 : LEADERBOARD & EVENT ANALYTICS ────────────────────────────

  private async fetchAndComputeLeaderboard(): Promise<void> {
    const state = this.state;
    const db = getClient();
    if (!db) return;

    const weeksToLoad = this.getWeeksToLoad();

    if (state.primaryView === 'events' || ['SvS', 'GvG', 'Shadowfront', 'Arms Race', 'DTR'].indexOf(state.currentMode) !== -1) {
      await this.loadSingleEventMode(state.selectedEvent || state.currentMode, weeksToLoad);
      return;
    }

    await this.loadGlobalMode(weeksToLoad);
  }

  /**
   * Fetches the aggregated counters for a set of weeks.
   *
   * Phase S2. This replaces `gm_stats_data`, which shipped every participation
   * row of the tenant -- about 10,000 for OMEGA -- on every one of its four
   * calls per visit, with no week filter and no aggregation. The RPC returns
   * one object per roster member plus per-bucket counts: 5,118 in-window rows
   * for OMEGA become 142 member objects.
   */
  private async fetchStatsMembers(weeks: string[], withTrend?: boolean): Promise<StatsMembersPayload | null> {
    const db = getClient();
    if (!db) return null;
    const res = await queryStatsMembers(db, this.state.activeGuild, weeks, withTrend);
    if (res.error) throw res.error;
    const payload = (res.data || null) as StatsMembersPayload | null;
    if (!payload || payload.ok === false) {
      throw new Error((payload && payload.error) || 'stats_members_failed');
    }
    return payload;
  }

  private async loadGlobalMode(weeksToLoad: string[]): Promise<void> {
    const state = this.state;
    try {
      const isAllTime = (state.statsPeriod === 'all');
      const requested = isAllTime ? state.allWeeks.slice() : weeksToLoad;
      const payload = await this.fetchStatsMembers(requested, true);
      if (!payload) { state.leaderboardData = []; this.renderLeaderboardImpl(); return; }

      // The roster is the member list. Every participation row carries a
      // (guild, pseudo) foreign key into guild_members, so the pseudos the old
      // code harvested from the participant, glory and squad arrays were always
      // a subset of it -- verified against production: zero orphans.
      state.uidMap = {};
      (payload.members || []).forEach((m: AggregateMemberRow) => { if (m.pseudo) state.uidMap[m.pseudo] = m.uid || ''; });

      const actualWeeks = (payload.weeks && payload.weeks.length) ? payload.weeks : requested;
      state.activeWeeksLoaded = actualWeeks;

      const coeffs = await this.getConfiguredCoeffs();
      state.leaderboardData = StatsService.computeReliabilityLeaderboard(payload, coeffs);
      state.trendWeeks = (payload.trend && payload.trend.weeks_recent) || 0;

      this.renderLeaderboardImpl();
    } catch (err) {
      console.error('[GM_STATS] Erreur loadGlobalMode', err);
      state.leaderboardData = [];
      this.renderLeaderboardImpl();
    }
  }

  private async getConfiguredCoeffs(): Promise<EventCoeffs> {
    try {
      const raw = await Promise.all([
        getGuildConfig('coeff_svs'),
        getGuildConfig('coeff_gvg'),
        getGuildConfig('coeff_shadowfront'),
        getGuildConfig('coeff_dtr'),
        getGuildConfig('coeff_armsrace')
      ]);
      const num = (val: unknown, fallback: number): number => {
        const n = parseFloat(String(val));
        return isNaN(n) ? fallback : n;
      };
      return {
        'SvS': num(raw[0], DEFAULT_EVENT_COEFFS['SvS']),
        'GvG': num(raw[1], DEFAULT_EVENT_COEFFS['GvG']),
        'Shadowfront': num(raw[2], DEFAULT_EVENT_COEFFS['Shadowfront']),
        'DTR': num(raw[3], DEFAULT_EVENT_COEFFS['DTR']),
        'Arms Race': num(raw[4], DEFAULT_EVENT_COEFFS['Arms Race'])
      };
    } catch (err) {
      console.warn('[GM_STATS] Failed to load configured coefficients, using defaults', err);
      return DEFAULT_EVENT_COEFFS;
    }
  }

  /**
   * The Event Deep-Dive, and the last caller of `gm_stats_data`.
   *
   * Phase S5. The bucket is resolved server-side and the per-member counts come
   * back aggregated, so the browser stops receiving the tenant's entire
   * participation history to filter it down to one event.
   */
  private async loadSingleEventMode(eventName: string, explicitWeeks?: string[]): Promise<void> {
    const state = this.state;
    const db = getClient();
    try {
      const weeksToLoad = explicitWeeks || this.getWeeksToLoad();
      const isAllTime = (state.statsPeriod === 'all');
      const requested = isAllTime ? state.allWeeks.slice() : weeksToLoad;

      const res = await queryStatsEvents(db, state.activeGuild, resolveEventBucket(eventName), requested);
      if (res.error) throw res.error;
      const payload = (res.data || {}) as StatsEventsPayload;
      if (payload.ok === false) throw new Error(payload.error || 'stats_events_failed');

      state.uidMap = state.uidMap || {};
      (payload.members || []).forEach((m: EventsMemberRow) => {
        if (m.pseudo) state.uidMap[m.pseudo] = m.uid || '';
      });

      state.activeWeeksLoaded = (payload.weeks && payload.weeks.length) ? payload.weeks : requested;
      state.eventWar = payload.war || [];
      state.eventSessions = (payload.sessions || []).length;
      state.leaderboardData = StatsService.computeEventLeaderboardFromPayload(payload);

      this.renderLeaderboardImpl();
    } catch (err) {
      console.error('[GM_STATS] Erreur loadSingleEventMode', err);
      state.leaderboardData = [];
      state.eventWar = [];
      this.renderLeaderboardImpl();
    }
  }

  // loadParticipationMode() was removed in phase S3. The page used to offer
  // "Global Score (Composite)" and "Attendance Rate (%)" as two options of one
  // dropdown -- two answers to one question, which disagreed about the same
  // member because one counted a recorded score as attendance and the other did
  // not. There is one board now, and it shows its own components as columns.

  private renderLeaderboardImpl(): void {
    const state = this.state;
    const containers = document.querySelectorAll('.stats-leaderboard-area');
    if (!containers || !containers.length) return;

    const tabsHtml = this.getTabsHtml();

    containers.forEach((container) => {
      const hasData = state.leaderboardData && state.leaderboardData.length > 0;
      const hasScores = hasData && state.leaderboardData.some((m) => {
        return (m.score > 0) || (m.score_prep > 0) || (m.score_pvp > 0) || (m.events_done > 0);
      });

      if (!hasData || !hasScores) {
        const titleKey = 'stats_no_event_data_title';
        const i18nTitle = t(titleKey);
        const emptyTitle = (i18nTitle !== null && i18nTitle !== titleKey)
          ? i18nTitle
          : 'No event data for this period';
        const descKey = 'stats_no_event_data_desc';
        const i18nDesc = t(descKey);
        const emptyDesc = (i18nDesc !== null && i18nDesc !== descKey)
          ? i18nDesc
          : 'No scores recorded for this event in the selected week. Try selecting another week or trigger an OCR scan.';

        container.innerHTML = tabsHtml +
          '<div class="gm-empty gm-leaderboard-empty" style="padding:3.5rem 1.5rem; text-align:center; background:var(--bg-1); border-radius:var(--radius-xl); border:1px dashed var(--border-soft); margin-top:1rem;">' +
            '<i class="ph ph-trophy gm-icon" style="font-size: var(--fs-5xl); color:var(--fg-dim); margin-bottom:.75rem; display:block; opacity:0.6;"></i>' +
            '<div class="gm-empty-title" style="font-size: var(--fs-xl); font-weight:700; color:var(--fg); margin-bottom:.5rem;">' + esc(emptyTitle) + '</div>' +
            '<div class="gm-empty-hint" style="font-size: var(--fs-sm); color:var(--fg-dim); max-width:480px; margin:0 auto; line-height:1.5;">' + esc(emptyDesc) + '</div>' +
          '</div>';
        this.wireModeTabs(container);
        return;
      }

      // Timeframe Context Pill
      const periodDesc = state.statsPeriod === 'all' ? 'All Time (Total History)' : (state.statsPeriod === '1w' ? ('Week ' + (getWeekNumber(state.selectedWeek) || shortDate(state.selectedWeek))) : (state.statsPeriod + ' window starting ' + shortDate(state.selectedWeek)));
      const weeksCount = (state.activeWeeksLoaded && state.activeWeeksLoaded.length) || 1;

      // Top 3 Podium Stage
      let podHtml = '';
      if (state.leaderboardData.length >= 3) {
        const top1 = state.leaderboardData[0];
        const top2 = state.leaderboardData[1];
        const top3 = state.leaderboardData[2];

        podHtml =
          '<div class="gm-podium-stage-container">' +
            '<div class="gm-podium-stage">' +
              this.render3DPodiumColumn(top2, 'silver', '2') +
              this.render3DPodiumColumn(top1, 'gold', '1') +
              this.render3DPodiumColumn(top3, 'bronze', '3') +
            '</div>' +
            '<div class="gm-stats-leaderboard-banner">' +
              '<h3>CLIMB THE LEADERBOARD &amp; CLAIM GUILD GLORY</h3>' +
              '<p>Aggregated across <strong>' + esc(periodDesc) + '</strong> (' + weeksCount + ' week' + (weeksCount > 1 ? 's' : '') + ').</p>' +
            '</div>' +
          '</div>';
      }

      const currentEvent = state.selectedEvent || state.currentMode;
      const isBattleEventMode = (state.primaryView === 'events' && (currentEvent === 'SvS' || currentEvent === 'GvG')) || (state.currentMode === 'SvS' || state.currentMode === 'GvG');
      const isShadowfrontMode = (state.primaryView === 'events' && currentEvent === 'Shadowfront') || state.currentMode === 'Shadowfront';
      const isArmsRaceMode = (state.primaryView === 'events' && currentEvent === 'Arms Race') || state.currentMode === 'Arms Race';


      // Table Headers
      let theadCols = '<th class="gm-center" style="width:65px;">#</th>' +
                      '<th>' + (t('col_member') || 'Member') + '</th>';

      // The "Late / Excused" column was removed on 2026-09-27. Measured in
      // production: `late` is set on 0.09% of the 55,739 participation rows and
      // `excused` on 0.41%. The cell rendered "-" for the other 99.5%, so the
      // column cost a column of horizontal scroll on mobile to tell an admin
      // nothing. The two counters are still aggregated in stats.service.ts and
      // still travel on the row, so putting the column back is a render change,
      // not a data change -- and `excused` earns a real job in phase S3, where
      // it is removed from a member's denominator instead of being displayed.

      if (isShadowfrontMode) {
        theadCols += '<th class="gm-center">Squad Assigned</th>' +
                     '<th class="gm-center">Present (Attended)</th>' +
                     '<th class="gm-center">Substitute</th>' +
                     '<th class="gm-center">Attendance Rate</th>' +
                     '<th class="gm-right">' + (t('stats_score_pts') || 'Score Pts') + '</th>';
      } else if (isArmsRaceMode) {
        theadCols += '<th class="gm-center">Stage A</th>' +
                     '<th class="gm-center">Stage B</th>' +
                     '<th class="gm-center">' + (t('stats_events') || 'Events') + '</th>' +
                     '<th class="gm-right">' + (t('stats_score_pts') || 'Score Pts') + '</th>';
      } else if (isBattleEventMode) {
        theadCols += '<th class="gm-center">' + (t('stats_events') || 'Events') + '</th>' +
                     '<th class="gm-center">' + (t('col_score_prep') || 'Day 1 to 5 score') + '</th>' +
                     '<th class="gm-center">' + (t('col_score_pvp') || 'Day 6 score') + '</th>' +
                     '<th class="gm-right">' + (t('stats_score_pts') || 'Score Pts') + '</th>';
      } else {
        // Phase S3: the components of the score are columns, not a hidden
        // formula. "82%" is not an instruction; "attends every SvS, never once
        // did Shadowfront" is.
        theadCols += '<th class="gm-center">By event</th>' +
                     '<th class="gm-center">Attended</th>' +
                     (state.trendWeeks > 0 ? '<th class="gm-center">Trend</th>' : '') +
                     '<th class="gm-right">Reliability</th>';
      }

      let tableHtml =
        '<div class="gm-card glass-card" style="padding:1.25rem;">' +
          '<div class="gm-table-wrapper" style="overflow-x:auto;">' +
            '<table class="gm-table gm-resp-table" style="width:100%; border-collapse:collapse;">' +
              '<thead><tr>' + theadCols + '</tr></thead><tbody>';

      state.leaderboardData.forEach((m, idx) => {
        const rank = idx + 1;
        const initial = avatarInit(m.pseudo);
        const rankBadge = rank === 1 ? '<span class="gm-rank-badge">🥇</span>' : rank === 2 ? '<span class="gm-rank-badge">🥈</span>' : rank === 3 ? '<span class="gm-rank-badge">🥉</span>' : '<span class="gm-rank-num">' + rank + '</span>';

        const scoreDisplay = (m.score > 0) ? (fmt(m.score) + ' pts') : (m.events_done > 0 ? (m.events_done + ' pts') : '0 pts');

        let rowCells = '<td class="gm-center" style="font-weight:700;">' + rankBadge + '</td>' +
          '<td data-label="Player">' +
            '<div class="gm-member-id" style="display:flex; align-items:center; gap:.75rem;">' +
              '<div class="gm-avatar gm-avatar-squircle" style="width:38px; height:38px; font-size: var(--fs-lg); font-weight:700;">' + esc(initial) + '</div>' +
              '<strong class="gm-member-pseudo" style="color:var(--fg); font-weight:700;">' + esc(m.pseudo) + '</strong>' +
            '</div>' +
          '</td>';

        if (isShadowfrontMode) {
          const ratePct = Math.round((m.attendance_rate || 0) * 100);
          const rateBadge = ratePct >= 80 ? '<span style="color:#34d399; font-weight:700;">' + ratePct + '%</span>' : (ratePct >= 50 ? '<span style="color:#fbbf24; font-weight:700;">' + ratePct + '%</span>' : '<span style="color:var(--fg-dim);">' + ratePct + '%</span>');

          const squadBreakdown = m.assigned_count > 0
            ? (m.assigned_count + ' squad' + (m.assigned_count > 1 ? 's' : '') +
               (m.commander_count > 0 ? ' <span title="Commander">👑</span>' : '') +
               '<div style="font-size: var(--fs-sm); font-weight:400; color:var(--fg-dim);">' +
               'S1: ' + m.squad1_count + ' · S2: ' + m.squad2_count +
               '</div>' +
               '<div style="font-size: var(--fs-sm); font-weight:400; color:var(--fg-dim);">' +
               m.participant_count + ' main · ' + m.reserve_count + ' sub' + (m.reserve_count !== 1 ? 's' : '') + '</div>')
            : '-';
          rowCells +=
            '<td data-label="Squads" class="gm-center" style="font-family:var(--font-display); font-weight:600;">' + squadBreakdown + '</td>' +
            '<td data-label="Done" class="gm-center" style="font-family:var(--font-display); font-weight:600;">' + (m.events_done > 0 ? ('<span style="color:#34d399; font-weight:700;">✅ ' + m.events_done + '</span>') : '<span style="color:var(--fg-dim);">0</span>') + '</td>' +
            '<td data-label="Subs" class="gm-center" style="font-family:var(--font-display); font-weight:600;">' + (m.sub_count > 0 ? ('<span style="color:#fbbf24; font-weight:700;">🔁 ' + m.sub_count + '</span>') : '-') + '</td>' +
            '<td data-label="Rate" class="gm-center" style="font-family:var(--font-display);">' + rateBadge + '</td>' +
            '<td data-label="Score" class="gm-right" style="font-family:var(--font-display); font-weight:800; color:var(--accent-lime); font-size: var(--fs-lg);"><span class="gm-score-display">' + esc(scoreDisplay) + '</span></td>';
        } else if (isArmsRaceMode) {
          rowCells +=
            '<td data-label="Stage A" class="gm-center">' + (m.ara_count > 0 ? ('<span style="color:#34d399; font-weight:700;">✅ ' + m.ara_count + '</span>') : '<span style="color:var(--fg-dim);">-</span>') + '</td>' +
            '<td data-label="Stage B" class="gm-center">' + (m.arb_count > 0 ? ('<span style="color:#34d399; font-weight:700;">✅ ' + m.arb_count + '</span>') : '<span style="color:var(--fg-dim);">-</span>') + '</td>' +
            '<td data-label="Events" class="gm-center" style="font-family:var(--font-display); font-weight:600;">' + m.events_done + (m.events_total > 0 ? '/' + m.events_total : '') + '</td>' +
            '<td data-label="Score" class="gm-right" style="font-family:var(--font-display); font-weight:800; color:var(--accent-lime); font-size: var(--fs-lg);"><span class="gm-score-display">' + esc(scoreDisplay) + '</span></td>';
        } else if (isBattleEventMode) {
          rowCells +=
            '<td data-label="Events" class="gm-center" style="font-family:var(--font-display); font-weight:600;">' + m.events_done + (m.events_total > 0 ? '/' + m.events_total : '') + '</td>' +
            '<td data-label="Day 1-5" class="gm-center" style="font-family:var(--font-display); font-weight:600; color:var(--fg-dim); font-variant-numeric:tabular-nums;">' + fmt(m.score_prep || 0) + '</td>' +
            '<td data-label="Day 6" class="gm-center" style="font-family:var(--font-display); font-weight:600; color:var(--fg-dim); font-variant-numeric:tabular-nums;">' + fmt(m.score_pvp || 0) + '</td>' +
            '<td data-label="Score" class="gm-right" style="font-family:var(--font-display); font-weight:800; color:var(--accent-lime); font-size: var(--fs-lg);"><span class="gm-score-display">' + esc(scoreDisplay) + '</span></td>';
        } else {
          rowCells +=
            '<td data-label="By event" class="gm-center">' + this.renderBucketChips(m) + '</td>' +
            '<td data-label="Attended" class="gm-center" style="font-family:var(--font-display); font-weight:600;">' + m.events_done + (m.events_total > 0 ? '/' + m.events_total : '') + '</td>' +
            (state.trendWeeks > 0 ? '<td data-label="Trend" class="gm-center">' + this.renderTrend(m) + '</td>' : '') +
            '<td data-label="Reliability" class="gm-right" style="font-family:var(--font-display); font-weight:800; font-size: var(--fs-lg);">' + this.renderReliability(m) + '</td>';
        }

        const rowUid = (state.uidMap && state.uidMap[m.pseudo]) || '';
        tableHtml += '<tr class="gm-stats-row-clickable" style="border-bottom:1px solid var(--border-soft); cursor:pointer;" data-player-uid="' + esc(rowUid) + '" data-player-pseudo="' + esc(m.pseudo) + '" title="View player history">' + rowCells + '</tr>';
      });

      tableHtml += '</tbody></table></div></div>';

      container.innerHTML = tabsHtml + podHtml + this.renderEventWarStrip() + tableHtml;
      this.wireModeTabs(container);

      const tbody = container.querySelector('table tbody');
      if (tbody) {
        tbody.addEventListener('click', (ev) => {
          const target = ev.target as Element | null;
          const row = target ? target.closest('.gm-stats-row-clickable') : null;
          if (!row) return;
          const uid = row.getAttribute('data-player-uid');
          const pseudo = row.getAttribute('data-player-pseudo');
          if (uid && pseudo) {
            void showPlayerHistoryDialog(uid, pseudo);
          }
        });
      }
    });
  }

  /**
   * The per-bucket breakdown: "SvS 2/3 · GvG 2/2 · Arms Race 12/24".
   *
   * A bucket the guild did not run for this member renders as an em dash, not
   * 0%. "Did not attend" and "was never asked" are different facts, and the old
   * page reported both as zero.
   */
  /**
   * The war record for the selected bucket, above its table. SvS and GvG are
   * the only events with an opponent and a day-by-day result, and until now the
   * Stats page never showed either.
   */
  private renderEventWarStrip(): string {
    const wars = this.state.eventWar || [];
    if (!wars.length) return '';
    const rows = wars.slice(0, 6).map((w) => {
      const days = ['1', '2', '3', '4', '5', '6'].map((d) => {
        const r = (w.results || {})[d];
        if (r !== 'won' && r !== 'lost') return '<span title="Day ' + d + ': not recorded" style="color:var(--fg-dim);">·</span>';
        return '<span title="Day ' + d + ': ' + r + '" style="color:' + (r === 'won' ? '#34d399' : '#f87171') + '; font-weight:700;">' +
          (r === 'won' ? 'W' : 'L') + '</span>';
      }).join(' ');
      const won = ['1', '2', '3', '4', '5', '6'].filter((d) => (w.results || {})[d] === 'won').length;
      const lost = ['1', '2', '3', '4', '5', '6'].filter((d) => (w.results || {})[d] === 'lost').length;
      return '<div class="gm-kpi-row">' +
        '<span class="gm-kpi-label">' + esc(w.opponent || 'Unknown opponent') + '</span>' +
        '<span style="letter-spacing:.2em; font-family:var(--font-display);">' + days + '</span>' +
        '<span class="gm-kpi-value" style="color:' + (won >= lost ? '#34d399' : '#f87171') + ';">' + won + 'W - ' + lost + 'L</span>' +
      '</div>';
    }).join('');

    return '<div class="gm-kpi-card" style="margin-bottom:.85rem;">' +
      '<div class="gm-kpi-card-title"><i class="ph ph-sword"></i> War record</div>' +
      '<div class="gm-kpi-card-body">' + rows +
        '<div style="font-size: var(--fs-xs); color:var(--fg-dim); margin-top:.4rem;">Days 1 to 5 are preparation, day 6 is the battle. A dot means that day was never recorded.</div>' +
      '</div>' +
    '</div>';
  }

  private renderBucketChips(m: any): string {
    const buckets = (m && m.buckets) || [];
    if (!buckets.length) {
      return '<span style="color:var(--fg-dim);" title="No events ran for this member in this window">—</span>';
    }
    return '<div style="display:flex; gap:.35rem; flex-wrap:wrap; justify-content:center;">' +
      buckets.map((b: any) => {
        if (!b.opp) {
          return '<span class="gm-chip" style="font-size: var(--fs-xs); color:var(--fg-dim);" title="' +
            esc(b.bucket) + ': not run for this member in this window">' + esc(b.bucket) + ' —</span>';
        }
        const pct = b.rate === null ? 0 : b.rate;
        const colour = pct >= 80 ? '#34d399' : pct >= 50 ? '#fbbf24' : '#f87171';
        return '<span class="gm-chip" style="font-size: var(--fs-xs); color:' + colour + ';" title="' +
          esc(b.bucket) + ': ' + b.att + ' of ' + b.opp + ' (weight ' + b.coeff + ')' +
          (b.exc > 0 ? ', ' + b.exc + ' excused and not counted' : '') + '">' +
          esc(b.bucket) + ' ' + b.att + '/' + b.opp + '</span>';
      }).join('') +
    '</div>';
  }

  /** The headline, or an em dash when the member had no opportunities at all. */
  private renderReliability(m: any): string {
    if (!m || m.reliability === null || m.reliability === undefined) {
      return '<span style="color:var(--fg-dim); font-weight:600;" title="Nothing ran for this member in this window">—</span>';
    }
    const pct = m.reliability;
    const colour = pct >= 80 ? 'var(--accent-lime)' : pct >= 50 ? '#fbbf24' : '#f87171';
    // A rate always carries its n. 4/4 and 58/62 are both "94%-ish" and they
    // are not the same claim.
    const title = 'Weighted: ' + Math.round(m.weighted_att) + ' of ' + Math.round(m.weighted_opp) +
      ' opportunities, weighted by this guild\'s event coefficients';
    return '<span class="gm-score-display" style="color:' + colour + ';" title="' + esc(title) + '">' + pct + '%</span>';
  }

  /** Recent four weeks against the four before them, or nothing to say. */
  private renderTrend(m: any): string {
    const t = (m && m.trend) || null;
    if (!t || !t.eligible || t.delta === null) {
      return '<span style="color:var(--fg-dim);" title="Not enough history on both sides to compare">—</span>';
    }
    const d = t.delta;
    if (Math.abs(d) < 5) {
      return '<span style="color:var(--fg-dim);" title="' + esc(t.prior + '% → ' + t.recent + '%') + '">steady</span>';
    }
    const up = d > 0;
    return '<span style="color:' + (up ? '#34d399' : '#f87171') + '; font-weight:700;" title="' +
      esc(t.prior + '% → ' + t.recent + '% over the last 4 weeks vs the 4 before') + '">' +
      (up ? '▲ +' : '▼ ') + d + '</span>';
  }

  private render3DPodiumColumn(member: any, medalClass: string, rankNum: string): string {
    if (!member) return '';
    const initial = avatarInit(member.pseudo);
    const crownHtml = rankNum === '1' ? '<div class="gm-podium-crown-wrap"><i class="ph ph-crown gm-podium-crown"></i></div>' : '';
    return '<div class="gm-podium-column gm-' + medalClass + '">' +
      crownHtml +
      '<div class="gm-podium-avatar-wrap gm-podium-avatar-hex">' +
        '<div class="gm-avatar gm-avatar-m3">' + esc(initial) + '</div>' +
        '<div class="gm-podium-rank-badge gm-podium-hex-rank">' + rankNum + '</div>' +
      '</div>' +
      '<div class="gm-podium-player-name">' + esc(member.pseudo) + '</div>' +
      '<div class="gm-podium-score-val">' +
        (member.reliability !== undefined
          ? (member.reliability === null ? '—' : member.reliability + '%')
          : fmt(member.score) + ' pts') +
      '</div>' +
      '<div class="gm-podium-pedestal">' +
        '<div class="gm-podium-pedestal-content">' +
          '<i class="ph ' + (rankNum === '1' ? 'ph-trophy' : rankNum === '2' ? 'ph-medal' : 'ph-seal-check') + ' gm-podium-pedestal-icon"></i>' +
        '</div>' +
      '</div>' +
    '</div>';
  }
}

// ── KPI Helpers ───────────────────────────────────────────────────────────────

function kpiTile(label: string, value: string | number, icon: string, theme?: string): string {
  return '<div class="gm-kpi-tile ' + (theme || '') + '">' +
    '<i class="ph ' + icon + '"></i>' +
    '<div class="gm-kpi-tile-value">' + value + '</div>' +
    '<div class="gm-kpi-tile-label">' + label + '</div>' +
  '</div>';
}

function kpiMini(label: string, value: string | number): string {
  return '<div class="gm-kpi-mini"><span class="gm-kpi-mini-value">' + value + '</span><span class="gm-kpi-mini-label">' + label + '</span></div>';
}

/** Shared singleton instance (bridged to `window.GM_STATS` at cutover). */
export const statsView = new StatsView();

export default statsView;
