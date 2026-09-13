/**
 * src/main.ts
 *
 * Primary application entrypoint for FGF Guild Management Tool.
 * Bootstraps i18n, Supabase bridge, reactive Store, Workers, Services, PWA, and UI Components.
 */

import { t } from './core/i18n/i18n';
import { getSupabaseClient, escapeHTML } from './core/api/supabase';
import {
  isoWeekKey,
  dateKey,
  eventScoringKey,
  sessionDateFromId,
  buildEventSessionId
} from './core/config/events';
import { GVG_DAILY_TASKS, buildGvgDailyTaskEmbed } from './core/config/gvg-tasks';
import { normalizeRole, roleFromStorage, isSuperAdmin, isServerAdmin, isGuildAdmin } from './core/auth/roles';
import {
  calculateCombatDensity,
  calculateRallyScore,
  calculateRallyGrade,
  calculateResidualPower,
  calculateCombativity,
  calculateWarScore,
  getRallyRoleMeta,
  getPowerTier,
  getPowerTierMeta,
  parseSafeMetric,
  COMBAT_WEIGHTS
} from './core/scoring/combat';
import {
  pad2,
  getWeekStart,
  getPrevWeekStart,
  formatWeek,
  newSessionId,
  formatChartDate
} from './core/utils/date';
import {
  formatNumber,
  parseNumber,
  formatPower,
  avatarInit,
  cleanPlayerPseudo,
  levenshteinDistance,
  calculateStringSimilarity,
  findBestMatchingMember,
  parseGeminiJson,
  MAX_NUMERIC
} from './core/utils/text';
import { appStore } from './core/store/store';
import { calculateMatchupData, calculateMatchupAsync } from './workers/matchup.worker';
import { EventsService } from './modules/events/events.service';
import { ShadowfrontService } from './modules/shadowfront/shadowfront.service';
import { StatsService } from './modules/stats/stats.service';
import { statsView } from './modules/stats/views/StatsView';
import { shellView } from './modules/shell/views/ShellView';
import { shadowfrontView } from './modules/shadowfront/views/ShadowfrontView';
import { armsRaceView } from './modules/armsrace/views/ArmsRaceView';
import { portalView } from './modules/portal/views/PortalView';
import { PortalService } from './modules/portal/portal.service';
import { AuditService } from './modules/audit/audit.service';
import { logger } from './core/logger/logger';

import { BaseComponent } from './components/ui/BaseComponent';
import { ToastNotification } from './components/ui/Toast';
import { PortalChart } from './modules/portal/components/PortalChart';
import { OverviewView } from './modules/overview/views/OverviewView';
import { HistoryView } from './modules/history/views/HistoryView';
import { SanctionsView } from './modules/sanctions/views/SanctionsView';
import { CrossRankView } from './modules/matchup/cross-rank';
import { GloryView } from './modules/glory/glory-view';
import { SubscriptionView } from './modules/subscription/subscription-view';
import { BadgesView } from './modules/badges/badges-view';
import { initPWA, promptPWAInstall, setAppNotificationBadge } from './core/pwa/pwa';

// Initialize global window.GM bridge for full backward compatibility
if (typeof window !== 'undefined') {
  (window as any).GM = (window as any).GM || {};
  // Prefer the legacy, complete dictionary (i18n.js — a classic sync script,
  // already executed by the time this deferred module runs) over the /src
  // one, which only covers strings authored so far. Several legacy modules
  // (StatsView, app.js, etc.) read window.GM.t dynamically at call time.
  (window as any).GM.t = ((window as any).GM_I18N && (window as any).GM_I18N.t) || t;
  (window as any).GM.escapeHTML = escapeHTML;
  (window as any).GM.db = (window as any).GM.db || getSupabaseClient();
  (window as any).GM.isoWeekKey = isoWeekKey;
  (window as any).GM.dateKey = dateKey;
  (window as any).GM.eventScoringKey = eventScoringKey;
  (window as any).GM.sessionDateFromId = sessionDateFromId;
  (window as any).GM.buildEventSessionId = buildEventSessionId;
  (window as any).GM.normalizeRole = normalizeRole;
  (window as any).GM.roleFromStorage = roleFromStorage;
  (window as any).GM.isSuperAdmin = isSuperAdmin;
  (window as any).GM.isServerAdmin = isServerAdmin;
  (window as any).GM.isGuildAdmin = isGuildAdmin;
  (window as any).GM.gvgTasks = {
    GVG_DAILY_TASKS,
    buildGvgDailyTaskEmbed
  };

  // Tactical scoring & military metrics
  (window as any).GM.calculateCombatDensity = calculateCombatDensity;
  (window as any).GM.calculateRallyScore = calculateRallyScore;
  (window as any).GM.calculateRallyGrade = calculateRallyGrade;
  (window as any).GM.calculateResidualPower = calculateResidualPower;
  (window as any).GM.calculateCombativity = calculateCombativity;
  (window as any).GM.calculateWarScore = calculateWarScore;
  (window as any).GM.getRallyRoleMeta = getRallyRoleMeta;
  (window as any).GM.getPowerTier = getPowerTier;
  (window as any).GM.getPowerTierMeta = getPowerTierMeta;
  (window as any).GM.parseSafeMetric = parseSafeMetric;
  (window as any).GM.COMBAT_WEIGHTS = COMBAT_WEIGHTS;

  // Date utilities
  (window as any).GM.pad2 = pad2;
  (window as any).GM.getWeekStart = getWeekStart;
  (window as any).GM.getPrevWeekStart = getPrevWeekStart;
  (window as any).GM.formatWeek = formatWeek;
  (window as any).GM.newSessionId = newSessionId;
  (window as any).GM.formatChartDate = formatChartDate;

  // Text, Number & Fuzzy utilities
  (window as any).GM.formatNumber = formatNumber;
  (window as any).GM.parseNumber = parseNumber;
  (window as any).GM.formatPower = formatPower;
  (window as any).GM.avatarInit = avatarInit;
  (window as any).GM.cleanPlayerPseudo = cleanPlayerPseudo;
  (window as any).GM.levenshteinDistance = levenshteinDistance;
  (window as any).GM.calculateStringSimilarity = calculateStringSimilarity;
  (window as any).GM.findBestMatchingMember = findBestMatchingMember;
  (window as any).GM.parseGeminiJson = parseGeminiJson;
  (window as any).GM.MAX_NUMERIC = MAX_NUMERIC;

  // Store, Worker & Services bridge
  (window as any).GM.store = appStore;
  (window as any).GM.logger = logger;
  (window as any).GM.calculateMatchupData = calculateMatchupData;
  (window as any).GM.calculateMatchupAsync = calculateMatchupAsync;
  (window as any).GM.services = {
    events: EventsService,
    shadowfront: ShadowfrontService,
    stats: StatsService,
    portal: PortalService,
    audit: AuditService
  };

  // Backward-compatible stats entrypoint. Replaces the former root stats.js
  // (Strangler cutover): every legacy caller (app.js tab wiring, shell.js)
  // still calls window.GM_STATS.load()/loadSingleEvent()/renderLeaderboard()
  // unchanged, now served by the /src StatsView module.
  (window as any).GM_STATS = {
    load: () => statsView.load(),
    loadSingleEvent: (eventName: any, weeks: any) => statsView.loadSingleEvent(eventName, weeks),
    renderLeaderboard: () => statsView.renderLeaderboard(),
    getState: () => statsView.getState()
  };

  // Backward-compatible shell entrypoint. Replaces the former root shell.js
  // (Strangler cutover): app.js, gm-leader-hall.js and subscription.service.ts
  // keep calling window.GM_SHELL.gotoItem/renderShell/renderSidebar/renderTopbar.
  (window as any).GM_SHELL = {
    gotoItem: (itemId: string) => shellView.gotoItem(itemId),
    renderShell: () => shellView.renderShell(),
    renderSidebar: () => shellView.renderSidebar(),
    renderTopbar: () => shellView.renderTopbar()
  };

  // Backward-compatible Shadowfront entrypoint. Replaces the former root
  // shadowfront.js (Strangler cutover): app.js, ShellView's lazy registry and
  // OCR flows keep calling window.GM_SHADOWFRONT.load()/render()/getAssignments().
  (window as any).GM_SHADOWFRONT = {
    load: () => shadowfrontView.load(),
    render: () => shadowfrontView.render(),
    setStateForTest: (state: any) => shadowfrontView.setStateForTest(state),
    getAssignments: () => shadowfrontView.getAssignments(),
    getActiveSquadSession: (squadKey: any) => shadowfrontView.getActiveSquadSession(squadKey)
  };

  // Backward-compatible Arms Race entrypoint. Replaces the former root
  // armsrace.js (Strangler cutover): app.js and ShellView's lazy registry keep
  // calling window.GM_ARMSRACE.load()/addMemberToActiveEvents()/removeMember…
  (window as any).GM_ARMSRACE = {
    load: () => armsRaceView.load(),
    addMemberToActiveEvents: (pseudo: string) => armsRaceView.addMemberToActiveEvents(pseudo),
    removeMemberFromActiveEvents: (pseudo: string) => armsRaceView.removeMemberFromActiveEvents(pseudo)
  };

  // Backward-compatible Player Portal entrypoint. Replaces the former root
  // portal.js (Strangler cutover): app.js and e2e call
  // window.GM_PORTAL.loadDashboard() / renderDashboard() unchanged.
  (window as any).GM_PORTAL = {
    loadDashboard: () => portalView.loadDashboard(),
    renderDashboard: () => portalView.renderDashboard()
  };

  (window as any).GM.components = {
    BaseComponent,
    ToastNotification,
    PortalChart,
    OverviewView,
    HistoryView,
    SanctionsView,
    CrossRankView,
    GloryView,
    SubscriptionView,
    BadgesView
  };

  (window as any).GM.pwa = {
    promptPWAInstall,
    setAppNotificationBadge
  };

  (window as any).GM_CROSSRANK = CrossRankView;
  // SvS/GvG matchup have no /src port: svs-matchup.ts/gvg-matchup.ts existed
  // only as 50-line stubs (a fixed hardcoded RPC call, no real table render)
  // that risked silently shadowing the complete legacy implementations
  // (svs-matchup.js / gvg-matchup.js — side-by-side rosters, combined
  // dangerosity leaderboard, sorting) once this module started executing in
  // production (build pipeline fix, 2026-08-30). Removed rather than kept
  // around unfinished; a real port is a from-scratch task, not a resume.
  // window.GM_SUBSCRIPTION is self-registered by importing SubscriptionView
  // above (see subscription-view.ts) — replaces legacy subscription.js.

  document.addEventListener('DOMContentLoaded', () => {
    // NOT applyTranslations() here: i18n.js (legacy) already runs its own,
    // complete applyTranslations() before this deferred module executes.
    // The /src dictionary only covers strings authored so far and doesn't
    // own this page yet — calling it here overwrote already-correct text
    // with raw i18n keys for every element outside that partial dictionary.
    // Migrating i18n itself is a separate future module.
    initPWA();
    // Former shell.js bootstrap (DOMContentLoaded): wrap the dashboard and
    // render the shell once the DOM is ready.
    shellView.init();
  });
}
