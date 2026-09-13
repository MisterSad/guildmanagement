/**
 * src/main.ts
 *
 * Primary application entrypoint for FGF Guild Management Tool.
 * Bootstraps i18n, Supabase bridge, reactive Store, Workers, Services, PWA, and UI Components.
 */

import { t, getLang, setLang, applyTranslations } from './core/i18n/i18n';
import { getSupabaseClient, escapeHTML } from './core/api/supabase';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './core/config/constants';
import { installDbWriteGuard } from './core/api/db-guard';
import { installGmBridge } from './core/gm-bridge';
import { runGmBootstrap } from './core/bootstrap';
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
import * as badgesService from './modules/badges/badges.service';
import { pushService } from './modules/push/PushService';
import { helpView } from './modules/help/HelpView';
import { ticketsView } from './modules/tickets/views/TicketsView';
import { gloryView } from './modules/glory/views/GloryView';
import { sanctionsView } from './modules/sanctions/views/SanctionsView';
import { historyView } from './modules/history/views/HistoryView';
import { eventsView } from './modules/events/views/EventsView';
import { overviewView } from './modules/overview/views/OverviewView';
import { webAuthnService } from './core/auth/webauthn.service';
import { mountPasskeysPanel, downloadBackupCodes } from './modules/auth/PasskeysPanel';
import { logger } from './core/logger/logger';
import {
  showConfirm,
  showToast as showAppToast,
  showPlayerHistoryDialog
} from './modules/app/dialogs/dialogs.service';
import {
  initAppState,
  getAppState,
  patchAppState,
  resetAppState
} from './modules/app/state/app-state';
import {
  restoreSession,
  handleSuccessfulLogin,
  doLogout,
  showAuthTab,
  showRegisterForm,
  maybeShowSecureAccountPrompt,
  wirePasskeyLoginButton,
  openBackupCodeDialog,
  initAuthForms,
  startConditionalPasskeyListener
} from './modules/app/auth/auth.controller';
import {
  checkForNewVersion,
  showNewVersionBanner,
  initVersionCheck,
  resetVersionCheck
} from './modules/app/auth/version-check';
import { handlePortalLookupSuccess } from './modules/app/auth/portal.controller';
import {
  triggerTabDataLoad,
  onTabActivated,
  reloadActiveView,
  restoreSavedTab,
  initTabNavigation,
  showAdminDashboard,
  showLogin
} from './modules/app/router';
import {
  fetchAccounts,
  deleteAccount,
  fetchGuilds,
  populateAccountGuildSelect,
  wireJoinCode,
  initAccountsUi,
  generatePassword,
  mountMyPasskeysCard,
  loadMyPasskeysCard
} from './modules/app/admin/accounts.controller';
import {
  fetchGuildRequests,
  renderGuildRequestsList,
  wireGuildRequestListeners,
  loadGuildSettings,
  renderPendingRegistrations,
  resolveRegistration,
  initGuildRequestsUi
} from './modules/app/admin/guild-requests.controller';
import { renderMigrationGroupsList } from './modules/app/admin/migration-groups.controller';
import { renderGuildsSubscriptionList } from './modules/app/admin/subscriptions.controller';
import {
  fetchGuildMembers,
  handleAddMember,
  deleteGuildMember,
  renameGuildMember,
  renderPendingTransfers,
  resolveTransfer,
  showUidTakenDialog,
  showEditMemberDialog,
  showTransferMemberDialog,
  initMembersUi
} from './modules/app/members/members.controller';
import {
  renderGuildMembers,
  buildMilitaryMatrixHtml,
  bulkUpdateMemberRoles,
  renderAbsenceSummary,
  renderTimezoneCoverage,
  memberTileHtml
} from './modules/app/members/members.render';
import {
  fetchBannedPlayers,
  renderBannedPlayers,
  handleAddBannedPlayer,
  deleteBannedPlayer,
  initBannedUi
} from './modules/app/members/banned.controller';
import {
  openOcrModal,
  closeOcrModal,
  setOcrMetric,
  resetOcrModalState,
  initOcrDropdown,
  initTimezoneCollapsible,
  initOcrGeminiModule,
  extractFramesFromVideo,
  handleOcrFiles,
  callGeminiOcrBatchApi,
  commitOcrUpdates,
  executeRosterCommit
} from './modules/app/ocr/ocr.controller';
import {
  renderOcrResults,
  toggleAllCheckboxes,
  updateCommitButtonCount,
  renderOcrRankCell
} from './modules/app/ocr/ocr.render';
import { getOcrModel, getOcrExtractedPlayers, OCR_METRICS_META } from './modules/app/ocr/ocr.meta';

import { BaseComponent } from './components/ui/BaseComponent';
import { ToastNotification } from './components/ui/Toast';
import { PortalChart } from './modules/portal/components/PortalChart';
import { SubscriptionView } from './modules/subscription/subscription-view';
import { initPWA, promptPWAInstall, setAppNotificationBadge } from './core/pwa/pwa';

// Initialize global window.GM bridge for full backward compatibility
if (typeof window !== 'undefined') {
  (window as any).GM = (window as any).GM || {};
  // i18n is now served by /src (Strangler cutover): bridge the complete
  // translation table for every legacy consumer (app.js, gm-utils.js, ...)
  // that reads window.GM_I18N / window.GM.t dynamically at call time.
  (window as any).GM_I18N = { t, getLang, setLang, applyTranslations };
  (window as any).GM.t = t;
  (window as any).GM.escapeHTML = escapeHTML;
  // P3: build the client from hardcoded constants (never import.meta.env) and
  // install the multi-tenant write guard, exactly like the legacy gm-utils.js.
  const wAny = window as any;
  const rawClient = wAny.GM.db || (typeof wAny.supabase?.createClient === 'function'
    ? wAny.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : createClient(SUPABASE_URL, SUPABASE_KEY));
  wAny.GM.db = installDbWriteGuard(rawClient);
  // Assemble the full legacy window.GM surface (~108 members) from the typed
  // /src modules (gm-utils Strangler cutover).
  installGmBridge();

  // Sous-lot 6.1 (Strangler): global dialogs/toasts now owned by /src. The
  // legacy app.js classic script still loads and sets these at parse time, so
  // these assignments overwrite its bridges with the typed implementations
  // (app.js is removed in the final cutover lot).
  wAny.showConfirm = showConfirm;
  wAny.GM_APP = wAny.GM_APP || {};
  wAny.GM_APP.showToast = showAppToast;
  wAny.GM_APP.showPlayerHistory = showPlayerHistoryDialog;

  // Sous-lot 6.2 (Strangler): unified cross-cutting state. Init before the
  // bootstrap and expose typed accessors for /src modules; every write is
  // mirrored onto window.* so the still-loaded classic app.js stays coherent.
  initAppState();
  wAny.GM.appState = { get: getAppState, patch: patchAppState, reset: resetAppState };

  // Sous-lot 6.3 (Strangler): auth/session/version/portal handlers exposed for
  // the legacy cutover. NOT auto-initialized while app.js still wires its own
  // listeners (would double-bind forms/pollers).
  wAny.GM_AUTH = {
    restoreSession,
    handleSuccessfulLogin,
    doLogout,
    showAuthTab,
    showRegisterForm,
    maybeShowSecureAccountPrompt,
    wirePasskeyLoginButton,
    openBackupCodeDialog,
    initAuthForms,
    startConditionalPasskeyListener,
    checkForNewVersion,
    showNewVersionBanner,
    initVersionCheck,
    resetVersionCheck,
    handlePortalLookupSuccess
  };

  // Sous-lot 6.4/6.8 (Strangler): tab router / view switching now routes every
  // tab directly to the typed /src domain controllers through the window.GM_*
  // bridges (the legacy app.js IIFE has been removed).
  wAny.GM_APP.onTabActivated = (tabId: string) => { void onTabActivated(tabId); };
  wAny.GM_APP.reloadActiveView = () => { reloadActiveView(); };
  wAny.GM_APP.showAdminDashboard = showAdminDashboard;
  wAny.GM_APP.fetchGuilds = fetchGuilds;
  wAny.GM_ROUTER = {
    triggerTabDataLoad,
    onTabActivated,
    reloadActiveView,
    restoreSavedTab,
    initTabNavigation,
    showAdminDashboard,
    showLogin
  };

  // Sous-lot 6.5 (Strangler): admin/accounts/guild-request/migration/subscription
  // handlers exposed under GM_ADMIN for the cutover. Deliberately NOT assigned to
  // bare window.fetchAccounts/loadGuildSettings/... while app.js runs: its tab
  // loaders also call IIFE-private helpers (loadMyPasskeysCard, members badge
  // re-render) that /src does not yet own, so the router keeps delegating whole
  // tabs to the captured legacy loader. Also NOT auto-initializing the form
  // wiring (app.js already binds those forms => would double-submit).
  wAny.GM_ADMIN = {
    fetchAccounts,
    deleteAccount,
    fetchGuilds,
    populateAccountGuildSelect,
    wireJoinCode,
    initAccountsUi,
    generatePassword,
    mountMyPasskeysCard,
    loadMyPasskeysCard,
    fetchGuildRequests,
    renderGuildRequestsList,
    wireGuildRequestListeners,
    loadGuildSettings,
    renderPendingRegistrations,
    resolveRegistration,
    initGuildRequestsUi,
    renderMigrationGroupsList,
    renderGuildsSubscriptionList
  };

  // Sous-lot 6.6 (Strangler): members/roster/matrix/transfers/absences/banned
  // exposed under GM_MEMBERS (namespaced). Names are NOT assigned to the bare
  // window.* probes used by the router's legacyTabLoader, so app.js keeps
  // owning the live roster until the full cutover.
  wAny.GM_MEMBERS = {
    fetchGuildMembers,
    renderGuildMembers,
    buildMilitaryMatrixHtml,
    bulkUpdateMemberRoles,
    renderPendingTransfers,
    resolveTransfer,
    fetchBannedPlayers,
    renderBannedPlayers,
    handleAddMember,
    deleteGuildMember,
    renameGuildMember,
    showUidTakenDialog,
    showEditMemberDialog,
    showTransferMemberDialog,
    renderAbsenceSummary,
    renderTimezoneCoverage,
    memberTileHtml,
    handleAddBannedPlayer,
    deleteBannedPlayer,
    initMembersUi,
    initBannedUi
  };

  // Sous-lot 6.7 (Strangler): OCR bulk roster pipeline exposed under GM_OCR.
  // The bare window.openOcrModal/closeOcrModal are only backfilled when absent
  // (app.js already defines them) so its UI buttons keep working unchanged.
  wAny.GM_OCR = {
    openOcrModal,
    closeOcrModal,
    setOcrMetric,
    resetOcrModalState,
    initOcrDropdown,
    initTimezoneCollapsible,
    initOcrGeminiModule,
    extractFramesFromVideo,
    handleOcrFiles,
    callGeminiOcrBatchApi,
    commitOcrUpdates,
    executeRosterCommit,
    renderOcrResults,
    toggleAllCheckboxes,
    updateCommitButtonCount,
    renderOcrRankCell,
    getOcrModel,
    getOcrExtractedPlayers,
    metrics: OCR_METRICS_META
  };
  wAny.openOcrModal = (metric?: string) => { void openOcrModal(metric); };
  wAny.closeOcrModal = () => { closeOcrModal(); };
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

  // Wave 1 Strangler bridges (satellites badges/push/help/tickets).
  (window as any).GM_BADGES = {
    computeBadges: badgesService.computeBadges,
    parseRank: badgesService.parseRank,
    daysSince: badgesService.daysSince
  };
  (window as any).GM_PUSH = {
    mount: (container: HTMLElement) => pushService.mount(container)
  };
  (window as any).GM_HELP = {
    open: (id: string) => helpView.open(id),
    close: () => helpView.close(),
    init: () => helpView.init()
  };
  (window as any).GM_TICKETS = {
    load: () => ticketsView.load(),
    loadingHtml: () => ticketsView.loadingHtml()
  };

  // Wave 2 Strangler bridges (glory / sanctions / history).
  (window as any).GM_GLORY = { load: () => gloryView.load() };
  (window as any).GM_SANCTIONS = { load: () => sanctionsView.load() };
  (window as any).GM_HISTORY = { load: () => historyView.load() };

  // Wave 3 Strangler bridges (events / overview).
  (window as any).GM_EVENTS = {
    loadEvent: (tabId: string, customGuildId?: string) => eventsView.loadEvent(tabId, customGuildId),
    addMemberToActiveEvents: (pseudo: string) => eventsView.addMemberToActiveEvents(pseudo),
    removeMemberFromActiveEvents: (pseudo: string) => eventsView.removeMemberFromActiveEvents(pseudo)
  };
  (window as any).GM_OVERVIEW = {
    load: () => overviewView.load()
  };

  // Wave 4 Strangler bridge: WebAuthn is nested under window.GM (not a GM_*
  // global), consumed by app.js and gm-utils.js login helpers.
  (window as any).GM = (window as any).GM || {};
  (window as any).GM.webauthn = {
    isSupported: () => webAuthnService.isSupported(),
    registerPasskey: (pseudo?: string) => webAuthnService.registerPasskey(pseudo),
    authenticateWithPasskey: (accountId?: string) => webAuthnService.authenticateWithPasskey(accountId),
    redeemBackupCode: (accountId: string, code: string) => webAuthnService.redeemBackupCode(accountId, code),
    listPasskeys: (accountId?: string) => webAuthnService.listPasskeys(accountId),
    renamePasskey: (credentialId: string, label: string) => webAuthnService.renamePasskey(credentialId, label),
    removePasskey: (credentialId: string) => webAuthnService.removePasskey(credentialId),
    regenerateBackupCodes: (accountId?: string) => webAuthnService.regenerateBackupCodes(accountId),
    downloadBackupCodes: (codes: string[], accountId: string) => downloadBackupCodes(codes, accountId),
    mountPasskeysPanel: (config: any) => mountPasskeysPanel(config),
    adminResetPasskeys: (accountId: string) => webAuthnService.adminResetPasskeys(accountId),
    isConditionalMediationAvailable: () => webAuthnService.isConditionalMediationAvailable(),
    startConditionalAuth: (onSuccess: (accId: string) => void) => webAuthnService.startConditionalAuth(onSuccess),
    abortConditionalAuth: () => webAuthnService.abortConditionalAuth()
  };

  (window as any).GM.components = {
    BaseComponent,
    ToastNotification,
    PortalChart,
    SubscriptionView
  };

  (window as any).GM.pwa = {
    promptPWAInstall,
    setAppNotificationBadge
  };

  // window.GM_SUBSCRIPTION is self-registered by importing SubscriptionView
  // above (see subscription-view.ts) — replaces legacy subscription.js.

  document.addEventListener('DOMContentLoaded', () => {
    // Full cutover bootstrap order (app.js removed). gm-utils startup
    // side-effects (rad_* migration, window.currentGuild, terms modal) first.
    runGmBootstrap();
    // Auth/session form wiring, tab router, admin forms, OCR dropdown, tz
    // collapsible, stale-tab detection.
    initAuthForms();
    initTabNavigation();
    initAccountsUi();
    initGuildRequestsUi();
    initMembersUi();
    initBannedUi();
    initOcrDropdown();
    initTimezoneCollapsible();
    initVersionCheck();
    initPWA();
    // Former shell.js/gm-help.js/push.js/sanctions bootstrap.
    shellView.init();
    helpView.init();
    pushService.init();
    sanctionsView.init();
    // i18n single pass over the complete dictionary once the DOM is ready.
    applyTranslations();
    // Former app.js document-level OCR trigger delegation. Without it the
    // .btn-ocr-trigger dropdown/menu buttons would no longer open the modal.
    document.addEventListener('click', (ev) => {
      const target = ev.target;
      const btn = target instanceof HTMLElement ? target.closest('.btn-ocr-trigger') : null;
      if (!btn) return;
      const metric = btn.getAttribute('data-metric') || 'members';
      void openOcrModal(metric);
    });
    // Restore the persisted session, then the last active tab on success.
    void restoreSession().then((res) => {
      if (res && res.restored) restoreSavedTab();
    });
  });
}
