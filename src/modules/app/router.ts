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
import { getVerifiedRole } from '../../core/auth/roles';
// FINDING M8, phase 7. Every tab loader below used to be resolved by string on
// `window` (`invokeMethod('GM_MEMBERS', 'fetchGuildMembers')`) and no-opped
// silently when the name was wrong -- so renaming a loader left `tsc --noEmit`
// green while the tab stopped loading, and no test could see it. They are
// ordinary imports now: the same rename is a compile error.
import { fetchGuildMembers } from './members/members.controller';
import { fetchBannedPlayers } from './members/banned.controller';
import {
  fetchAccounts,
  fetchGuilds,
  populateAccountGuildSelect,
  wireJoinCode,
  wireAdminInvite,
  loadRecoveryCodesCard,
  wireRecoveryCodesCard
} from './admin/accounts.controller';
import { loadGuildSettings, fetchGuildRequests } from './admin/guild-requests.controller';
import { renderGuildsList } from './admin/guilds.controller';
import { renderMigrationGroupsList } from './admin/migration-groups.controller';
import { migrationHubView } from '../migration/views/MigrationHubView';
import { ticketsView } from '../tickets/views/TicketsView';
import { sanctionsView } from '../sanctions/views/SanctionsView';
import { overviewView } from '../overview/views/OverviewView';
import { eventsView } from '../events/views/EventsView';
import { shadowfrontView } from '../shadowfront/views/ShadowfrontView';
import { armsRaceView } from '../armsrace/views/ArmsRaceView';
import { gloryView } from '../glory/views/GloryView';
import { historyView } from '../history/views/HistoryView';
import { statsView } from '../stats/views/StatsView';
import { portalView } from '../portal/views/PortalView';
import { shellView } from '../shell/views/ShellView';

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

/**
 * Runs one tab loader, keeping a failure from aborting the rest of the batch.
 *
 * The predecessor also swallowed a MISSING loader, returning false and carrying
 * on -- which is how a renamed method turned into a silently blank tab. There is
 * nothing left to miss: `load` is a real reference, checked at compile time.
 */
async function runLoader(label: string, load: () => unknown): Promise<void> {
  try {
    await load();
  } catch (err) {
    console.error(label + ' failed:', err);
  }
}

function resetTabChrome(): void {
  const blackout = getDomRef('gm-anti-capture-fullscreen-overlay');
  if (blackout) blackout.classList.add('hidden');
  if (typeof document !== 'undefined') document.body.classList.remove('gm-mobile-chat-open');
}

/**
 * Views that hold resources beyond their DOM and must be torn down when the
 * user navigates away from them.
 *
 * Seven views define a `destroy()`; before this, **none of them was ever
 * called**, so everything they allocate leaked for the lifetime of the session:
 *
 *  - `GM_MIGRATION_HUB` holds two Realtime WebSocket channels. Worse than a
 *    leak: its page handler listens for `event: '*'` and re-runs a full
 *    `select('*')` of the wiki table on any remote change, so with *n* admins
 *    editing, each edit triggered *n* full refetches -- including for the n-1
 *    users sitting on a completely different tab.
 *  - `GM_OVERVIEW` holds two `setInterval`s (event countdowns and the timezone
 *    clocks) that kept firing and touching the DOM of a hidden tab forever.
 *  - `GM_SANCTIONS` holds a `rad-lang-change` window listener.
 *
 * Deliberately NOT listed: `ShellView` and `HelpView` are global chrome, not
 * tabs -- destroying them on a tab switch would dismantle the navigation and
 * the help popover. `PortalView` is the player portal, which is the whole app
 * for a member rather than one tab among others.
 *
 * Both listed views re-arm their resources inside `load()` (OverviewView
 * re-creates its timers, MigrationHubView re-subscribes once `destroy()` has
 * nulled the channels), so destroy-then-load is safe and idempotent.
 */
interface TeardownTarget {
  readonly label: string;
  readonly destroy: () => void;
}

const MIGRATION_HUB_TEARDOWN: TeardownTarget = {
  label: 'MigrationHubView',
  destroy: () => migrationHubView.destroy()
};
const OVERVIEW_TEARDOWN: TeardownTarget = {
  label: 'OverviewView',
  destroy: () => overviewView.destroy()
};
const SANCTIONS_TEARDOWN: TeardownTarget = {
  label: 'SanctionsView',
  destroy: () => sanctionsView.destroy()
};

const TEARDOWN_BY_TAB: Record<string, TeardownTarget> = {
  'admin-migration-hub': MIGRATION_HUB_TEARDOWN,
  'migration-hub': MIGRATION_HUB_TEARDOWN,
  'gm-overview': OVERVIEW_TEARDOWN,
  'overview': OVERVIEW_TEARDOWN,
  'tab-sanctions': SANCTIONS_TEARDOWN,
  'sanctions': SANCTIONS_TEARDOWN,
};

/** Tears down the view we are navigating away from. Never throws. */
function teardownPreviousTab(previousTabId: string, nextTabId: string): void {
  if (!previousTabId || previousTabId === nextTabId) return;
  const target = TEARDOWN_BY_TAB[previousTabId];
  if (!target) return;
  // Two ids can map to the same view (e.g. 'overview' / 'gm-overview'); do not
  // tear down when we are merely switching between those aliases. Comparing the
  // shared object identity is what makes that work.
  if (TEARDOWN_BY_TAB[nextTabId] === target) return;
  try {
    target.destroy();
  } catch (err) {
    console.error(target.label + '.destroy failed:', err);
  }
}

/** The tab whose view is currently mounted, for teardown on the next switch. */
let mountedTabId = '';

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

  // Release the previous view's timers / Realtime channels / listeners before
  // mounting the next one.
  teardownPreviousTab(mountedTabId, tabId);
  mountedTabId = tabId;

  resetTabChrome();

  const controller = new AbortController();
  activeLoadController = controller;
  activeLoadTabId = tabId;
  loadingTab = true;
  const signal = controller.signal;

  try {
    // ── Members / banned (GM_MEMBERS) ────────────────────────────────────────
    if (['admin-members', 'member-members', 'member-home', 'members'].includes(tabId)) {
      await runLoader('members', () => fetchGuildMembers({ signal }));
    }
    if (tabId === 'admin-banned' || tabId === 'banned') {
      await runLoader('banned', () => fetchBannedPlayers());
    }

    // ── Accounts / guild settings (GM_ADMIN) ─────────────────────────────────
    if (tabId === 'admin-home' || tabId === 'accounts') {
      // Before anything that reads the guild map: `fetchGuilds` is what fills
      // `window.guildsList` / `guildsData`, and nothing on this tab used to
      // call it. The "Create Admin Account" guild dropdown was therefore empty
      // unless the user happened to arrive via a path that fetched guilds.
      await runLoader('guilds', () => fetchGuilds());
      await runLoader('accounts', () => fetchAccounts());
      wireRecoveryCodesCard();
      await runLoader('recovery-codes', () => loadRecoveryCodesCard());
      await runLoader('guild-settings', () => loadGuildSettings());
      await runLoader('account-guild-select', () => populateAccountGuildSelect());
      await runLoader('join-code', () => wireJoinCode());
      await runLoader('admin-invite', () => wireAdminInvite());
    }
    if (tabId === 'admin-discord' || tabId === 'guild-settings') {
      await runLoader('guild-settings', () => loadGuildSettings());
    }
    if (tabId === 'guild-requests') {
      await runLoader('guild-requests', () => fetchGuildRequests());
    }
    if (tabId === 'guilds') {
      await runLoader('guilds-list', () => renderGuildsList());
    }
    if (tabId === 'migration-groups') {
      await runLoader('migration-groups', () => renderMigrationGroupsList());
    }
    if (tabId === 'admin-superadmin') {
      await runLoader('guilds', () => fetchGuilds());
      await runLoader('guilds-list', () => renderGuildsList());
      await runLoader('migration-groups', () => renderMigrationGroupsList());
      await runLoader('accounts', () => fetchAccounts());
      await runLoader('account-guild-select', () => populateAccountGuildSelect());
      await runLoader('admin-invite', () => wireAdminInvite());
      await runLoader('guild-requests', () => fetchGuildRequests());
    }

    // ── Migrated /src-backed view modules ────────────────────────────────────
    if (tabId === 'admin-migration-hub' || tabId === 'migration-hub') { await runLoader('migration-hub', () => migrationHubView.load()); }
    if (tabId === 'tab-tickets') { await runLoader('tickets', () => ticketsView.load()); }
    if (tabId === 'tab-sanctions' || tabId === 'sanctions') { await runLoader('sanctions', () => sanctionsView.load()); }
    if (tabId === 'gm-overview' || tabId === 'overview') { await runLoader('overview', () => overviewView.load()); }
    if (tabId === 'event-svs' || tabId === 'svs') { await runLoader('events:SvS', () => eventsView.loadEvent('SvS')); }
    if (tabId === 'event-gvg' || tabId === 'gvg') { await runLoader('events:GvG', () => eventsView.loadEvent('GvG')); }
    if (tabId === 'event-shadowfront' || tabId === 'Shadowfront' || tabId === 'shadowfront') {
      await runLoader('shadowfront', () => shadowfrontView.load());
    }
    if (tabId === 'event-dtr' || tabId === 'dtr') { await runLoader('events:DTR', () => eventsView.loadEvent('Defend Trade Route')); }
    if (tabId === 'event-arms-race' || tabId === 'ARMS RACE' || tabId === 'Arms Race' || tabId === 'armsrace') {
      await runLoader('armsrace', () => armsRaceView.load());
    }
    if (tabId === 'event-glory' || tabId === 'glory') { await runLoader('glory', () => gloryView.load()); }
    if (tabId === 'event-history' || tabId === 'history') { await runLoader('history', () => historyView.load()); }
    if (tabId === 'stats-admin' || tabId === 'stats-member' || tabId === 'stats') {
      await runLoader('stats', () => statsView.load());
    }
    if (tabId === 'player-portal-view' || tabId === 'portal') {
      await runLoader('portal', () => portalView.loadDashboard());
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
  const store = ls();
  const role = getVerifiedRole() || (store ? store.getItem('gm_role') : null);
  if (role === 'member' && tabId !== 'player-portal-view' && tabId !== 'portal') {
    return;
  }
  activateTabVisual(tabId, viewId);
  await triggerTabDataLoad(tabId);
}

/** Shows the admin dashboard container and hides the login panel. */
export function showAdminDashboard(): void {
  const refs = getDomRefs();
  if (refs.loginView) refs.loginView.classList.add('hidden');
  if (refs.playerPortalView) {
    refs.playerPortalView.classList.add('hidden');
    refs.playerPortalView.classList.remove('portal-connected');
  }
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
  if (refs.playerPortalView) {
    refs.playerPortalView.classList.add('hidden');
    refs.playerPortalView.classList.remove('portal-connected');
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
  const role = getVerifiedRole() || (store ? store.getItem('gm_role') : null);
  if (role === 'member') return;

  const saved = (store ? store.getItem('gm_active_tab') : null)
    || (store ? store.getItem('gm_last_tab') : null)
    || defaultTab;

  // Phase 7: the shell is imported, so this can no longer silently fall through
  // to the bare tab activation because a namespace name drifted.
  shellView.gotoItem(saved);
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
