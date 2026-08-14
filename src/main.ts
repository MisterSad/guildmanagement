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
import { normalizeRole, roleFromStorage, isSuperAdmin, isGuildAdmin } from './core/auth/roles';
import { appStore } from './core/store/store';
import { calculateMatchupData } from './workers/matchup.worker';
import { EventsService } from './modules/events/events.service';
import { ShadowfrontService } from './modules/shadowfront/shadowfront.service';
import { StatsService } from './modules/stats/stats.service';
import { PortalService } from './modules/portal/portal.service';
import { logger } from './core/logger/logger';

import { BaseComponent } from './components/ui/BaseComponent';
import { ToastNotification } from './components/ui/Toast';
import { PortalChart } from './modules/portal/components/PortalChart';
import { OverviewView } from './modules/overview/views/OverviewView';
import { HistoryView } from './modules/history/views/HistoryView';
import { SanctionsView } from './modules/sanctions/views/SanctionsView';
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
  (window as any).GM.isGuildAdmin = isGuildAdmin;

  // Store, Worker & Services bridge
  (window as any).GM.store = appStore;
  (window as any).GM.logger = logger;
  (window as any).GM.calculateMatchupData = calculateMatchupData;
  (window as any).GM.services = {
    events: EventsService,
    shadowfront: ShadowfrontService,
    stats: StatsService,
    portal: PortalService
  };

  (window as any).GM.components = {
    BaseComponent,
    ToastNotification,
    PortalChart,
    OverviewView,
    HistoryView,
    SanctionsView
  };

  (window as any).GM.pwa = {
    promptPWAInstall,
    setAppNotificationBadge
  };

  document.addEventListener('DOMContentLoaded', () => {
    applyTranslations();
    initPWA();
  });
}
