/**
 * src/modules/app/router.ts
 *
 * Sous-lot 6.4/6.8 (Strangler) — tab router / view switching. After the final
 * cutover the legacy `app.js` IIFE is gone, so `triggerTabDataLoad` routes every
 * tab directly to the typed /src domain controllers through the `window.GM_*`
 * bridges assembled in main.ts (GM_MEMBERS / GM_ADMIN / GM_EVENTS / …).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { getDomRefs, getDomRef } from './dom-refs';

function w(): any {
  return (typeof window !== 'undefined' ? window : ({} as any)) as any;
}

function ls(): Storage | null {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

// P3-03: per-tab request lifecycle. A single in-flight batch per view load:
// switching tabs aborts the previous batch, and a redundant click on the same
// tab while it is still loading is ignored instead of doubling the queries.
let activeLoadController: AbortController | null = null;
let activeLoadTabId = '';
let loadingTab = false;

async function invokeMethod(namespaceName: string, method: string, ...args: unknown[]): Promise<boolean> {
  const ns = w()[namespaceName];
  if (!ns || typeof ns[method] !== 'function') return false;
  try {
    await ns[method](...args);
    return true;
  } catch (err) {
    console.error(namespaceName + '.' + method + ' failed:', err);
    return true;
  }
}

function resetTabChrome(): void {
  const blackout = getDomRef('gm-anti-capture-fullscreen-overlay');
  if (blackout) blackout.classList.add('hidden');
  if (typeof document !== 'undefined') document.body.classList.remove('gm-mobile-chat-open');
}

/**
 * Routes a tab id to its data loader. Every branch is defensive (missing
 * module/function = no-op).
 */
export async function triggerTabDataLoad(tabId: string): Promise<void> {
  if (!tabId) return;

  // Cancel the previous tab's still-running batch when the user navigated away
  // before it resolved (prevents wasted requests and stale renders).
  if (activeLoadTabId !== tabId && activeLoadController) {
    try { activeLoadController.abort(); } catch { /* noop */ }
    activeLoadController = null;
  }

  // Ignore redundant activation of the SAME tab while its batch is in flight.
  if (activeLoadTabId === tabId && loadingTab) return;

  resetTabChrome();

  const controller = new AbortController();
  activeLoadController = controller;
  activeLoadTabId = tabId;
  loadingTab = true;
  const signal = controller.signal;

  try {
    // ── Members / banned (GM_MEMBERS) ────────────────────────────────────────
    if (['admin-members', 'member-members', 'member-home', 'members'].includes(tabId)) {
      await invokeMethod('GM_MEMBERS', 'fetchGuildMembers', signal);
    }
    if (tabId === 'admin-banned' || tabId === 'banned') {
      await invokeMethod('GM_MEMBERS', 'fetchBannedPlayers');
    }

    // ── Accounts / guild settings (GM_ADMIN) ─────────────────────────────────
    if (tabId === 'admin-home' || tabId === 'accounts') {
      await invokeMethod('GM_ADMIN', 'fetchAccounts');
      await invokeMethod('GM_ADMIN', 'loadGuildSettings');
      await invokeMethod('GM_ADMIN', 'populateAccountGuildSelect');
      await invokeMethod('GM_ADMIN', 'wireJoinCode');
      await invokeMethod('GM_ADMIN', 'loadMyPasskeysCard');
    }
    if (tabId === 'admin-discord' || tabId === 'guild-settings') {
      await invokeMethod('GM_ADMIN', 'loadGuildSettings');
    }
    if (tabId === 'guild-requests') {
      await invokeMethod('GM_ADMIN', 'fetchGuildRequests');
    }
    if (tabId === 'subscriptions') {
      await invokeMethod('GM_ADMIN', 'renderGuildsSubscriptionList');
    }
    if (tabId === 'migration-groups') {
      await invokeMethod('GM_ADMIN', 'renderMigrationGroupsList');
    }
    if (tabId === 'admin-superadmin') {
      await invokeMethod('GM_ADMIN', 'renderGuildsSubscriptionList');
      await invokeMethod('GM_ADMIN', 'renderMigrationGroupsList');
      await invokeMethod('GM_ADMIN', 'fetchAccounts');
      await invokeMethod('GM_ADMIN', 'populateAccountGuildSelect');
      await invokeMethod('GM_ADMIN', 'fetchGuildRequests');
    }

    // ── Migrated /src-backed view modules ────────────────────────────────────
    if (tabId === 'tab-subscription') { await invokeMethod('GM_SUBSCRIPTION', 'load'); }
    if (tabId === 'tab-tickets') { await invokeMethod('GM_TICKETS', 'load'); }
    if (tabId === 'tab-sanctions' || tabId === 'sanctions') { await invokeMethod('GM_SANCTIONS', 'load'); }
    if (tabId === 'gm-overview' || tabId === 'overview') { await invokeMethod('GM_OVERVIEW', 'load'); }
    if (tabId === 'event-svs' || tabId === 'svs') { await invokeMethod('GM_EVENTS', 'loadEvent', 'SvS'); }
    if (tabId === 'event-gvg' || tabId === 'gvg') { await invokeMethod('GM_EVENTS', 'loadEvent', 'GvG'); }
    if (tabId === 'event-shadowfront' || tabId === 'Shadowfront' || tabId === 'shadowfront') {
      await invokeMethod('GM_SHADOWFRONT', 'load');
    }
    if (tabId === 'event-dtr' || tabId === 'dtr') { await invokeMethod('GM_EVENTS', 'loadEvent', 'Defend Trade Route'); }
    if (tabId === 'event-arms-race' || tabId === 'ARMS RACE' || tabId === 'Arms Race' || tabId === 'armsrace') {
      await invokeMethod('GM_ARMSRACE', 'load');
    }
    if (tabId === 'event-glory' || tabId === 'glory') { await invokeMethod('GM_GLORY', 'load'); }
    if (tabId === 'event-history' || tabId === 'history') { await invokeMethod('GM_HISTORY', 'load'); }
    if (tabId === 'stats-admin' || tabId === 'stats-member' || tabId === 'stats') {
      await invokeMethod('GM_STATS', 'load');
    }
    if ((tabId === 'player-portal-view' || tabId === 'portal') && w().GM_PORTAL) {
      await invokeMethod('GM_PORTAL', 'loadDashboard');
    }
  } finally {
    // Only the still-current controller releases the lock; an aborted older
    // invocation must not clobber the newer load.
    if (activeLoadController === controller) {
      activeLoadController = null;
      activeLoadTabId = '';
      loadingTab = false;
    }
  }
}

/** Visually activates the nav button + panel for a tab id. */
function activateTabVisual(tabId: string, viewId?: string | null): void {
  if (typeof document === 'undefined') return;
  const doc = document;
  const viewEl = viewId
    ? doc.getElementById(viewId)
    : (doc.getElementById('dashboard-view') || doc.body);
  const scope: ParentNode = viewEl || doc;

  scope.querySelectorAll('.nav-tab').forEach((btn) => {
    if (btn.getAttribute('data-tab') === tabId) btn.classList.add('active');
    else btn.classList.remove('active');
  });

  scope.querySelectorAll('.tab-panel, .tab-content').forEach((panel) => panel.classList.remove('active'));
  const panel = doc.getElementById(tabId);
  if (panel) panel.classList.add('active');
}

/** Activates a tab and triggers its data loader. */
export async function onTabActivated(tabId: string, viewId?: string | null): Promise<void> {
  if (!tabId) return;
  activateTabVisual(tabId, viewId);
  await triggerTabDataLoad(tabId);
}

/** Shows the admin dashboard container and hides the login panel. */
export function showAdminDashboard(): void {
  const refs = getDomRefs();
  if (refs.loginView) refs.loginView.classList.add('hidden');
  if (refs.dashboardView) {
    refs.dashboardView.classList.remove('hidden');
    refs.dashboardView.classList.add('active');
  }
}

/** Shows the login panel and hides the dashboard container. */
export function showLogin(): void {
  const refs = getDomRefs();
  if (refs.dashboardView) {
    refs.dashboardView.classList.add('hidden');
    refs.dashboardView.classList.remove('active');
  }
  if (refs.loginView) {
    refs.loginView.classList.remove('hidden');
    refs.loginView.classList.add('active');
  }
}

/**
 * Restores the last active tab: `gm_active_tab` → `gm_last_tab` → default.
 * Prefers the modern shell (which owns the item→panel mapping); otherwise
 * activates the stored id directly.
 */
export function restoreSavedTab(defaultTab = 'overview'): void {
  const store = ls();
  const saved = (store ? store.getItem('gm_active_tab') : null)
    || (store ? store.getItem('gm_last_tab') : null)
    || defaultTab;

  const shell = w().GM_SHELL;
  if (shell && typeof shell.gotoItem === 'function') {
    shell.gotoItem(saved);
    return;
  }
  void onTabActivated(saved);
}

/** Re-loads the currently active panel's data. */
export function reloadActiveView(): void {
  if (typeof document === 'undefined') return;
  const panel = document.querySelector('.tab-panel.active, .tab-content.active');
  const id = panel ? panel.id : '';
  if (id) void triggerTabDataLoad(id);
}

/**
 * Delegated `.nav-tab` click binding. Idempotent via a flag on the container
 * (defaults to `document`).
 */
export function initTabNavigation(container?: HTMLElement): void {
  const scope: any = container || (typeof document !== 'undefined' ? document : null);
  if (!scope || typeof scope.addEventListener !== 'function') return;
  if (scope.__gmTabNavWired) return;
  scope.__gmTabNavWired = true;

  scope.addEventListener('click', (ev: Event) => {
    const target = ev.target;
    const btn = target instanceof HTMLElement ? (target.closest('.nav-tab') as HTMLElement | null) : null;
    if (!btn) return;
    const tabId = btn.getAttribute('data-tab');
    if (!tabId) return;
    void onTabActivated(tabId, btn.getAttribute('data-view'));
  });
}
