/**
 * src/main.ts
 *
 * Primary application entrypoint for FGF Guild Management Tool.
 * Bootstraps i18n, Supabase bridge, reactive Store, Workers, Services, PWA, and UI Components.
 */

import { applyTranslations, t } from './core/i18n/i18n';
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
import { appStore } from './core/store/store';
import { calculateMatchupData, calculateMatchupAsync } from './workers/matchup.worker';
import { EventsService } from './modules/events/events.service';
import { ShadowfrontService } from './modules/shadowfront/shadowfront.service';
import { StatsService } from './modules/stats/stats.service';
import { PortalService } from './modules/portal/portal.service';
import { AuditService } from './modules/audit/audit.service';
import { AuditView } from './modules/audit/audit-view';
import { logger } from './core/logger/logger';

import { BaseComponent } from './components/ui/BaseComponent';
import { ToastNotification } from './components/ui/Toast';
import { PortalChart } from './modules/portal/components/PortalChart';
import { OverviewView } from './modules/overview/views/OverviewView';
import { HistoryView } from './modules/history/views/HistoryView';
import { SanctionsView } from './modules/sanctions/views/SanctionsView';
import { CrossRankView } from './modules/matchup/cross-rank';
import { SvSMatchupView } from './modules/matchup/svs-matchup';
import { GvGMatchupView } from './modules/matchup/gvg-matchup';
import { ArmsRaceView } from './modules/armsrace/armsrace-view';
import { GloryView } from './modules/glory/glory-view';
import { SubscriptionView } from './modules/subscription/subscription-view';
import { BadgesView } from './modules/badges/badges-view';
import { initPWA, promptPWAInstall, setAppNotificationBadge } from './core/pwa/pwa';

// Initialize global window.GM bridge for full backward compatibility
if (typeof window !== 'undefined') {
  (window as any).GM = (window as any).GM || {};
  (window as any).GM.t = t;
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

  (window as any).GM.components = {
    BaseComponent,
    ToastNotification,
    PortalChart,
    OverviewView,
    HistoryView,
    SanctionsView,
    CrossRankView,
    SvSMatchupView,
    GvGMatchupView,
    ArmsRaceView,
    GloryView,
    SubscriptionView,
    BadgesView
  };

  (window as any).GM.pwa = {
    promptPWAInstall,
    setAppNotificationBadge
  };

  (window as any).GM_AUDIT = AuditView;
  (window as any).GM_CROSSRANK = CrossRankView;
  (window as any).GM_SVS_MATCHUP = SvSMatchupView;
  (window as any).GM_GVG_MATCHUP = GvGMatchupView;

  document.addEventListener('DOMContentLoaded', () => {
    applyTranslations();
    initPWA();
    AuditView.init();
  });
}
