/**
 * src/modules/app/lazy-views.ts
 *
 * The tab views, loaded on first use (medium-term plan, M5). Each view is its
 * own chunk: a member never downloads the admin tabs, an admin never downloads
 * the player portal, and nobody downloads Stats before opening it.
 *
 * Two ways to reach a view:
 *   - `get()` imports it if needed and resolves to the singleton -- for the
 *     router and anything that is about to SHOW the view;
 *   - `peek()` returns the singleton only if it is already loaded, else null --
 *     for code that merely keeps an open view in step (adding a member, an OCR
 *     commit). A view that was never opened has nothing to refresh: it loads
 *     fresh, from the database, the first time it is shown.
 *
 * Nothing else may import a view module statically, or the bundler folds it
 * back into the entry chunk; tests/code_splitting.test.js checks it.
 */

import type { EventsView } from '../events/views/EventsView';
import type { ShadowfrontView } from '../shadowfront/views/ShadowfrontView';
import type { ArmsRaceView } from '../armsrace/views/ArmsRaceView';
import type { OverviewView } from '../overview/views/OverviewView';
import type { PortalView } from '../portal/views/PortalView';
import type { StatsView } from '../stats/views/StatsView';
import type { HistoryView } from '../history/views/HistoryView';
import type { GloryView } from '../glory/views/GloryView';
import type { TicketsView } from '../tickets/views/TicketsView';
import type { SanctionsView } from '../sanctions/views/SanctionsView';
import type { MigrationHubView } from '../migration/views/MigrationHubView';

export interface LazyView<T> {
  /** Imports the view on first call; every call resolves to the same singleton. */
  get(): Promise<T>;
  /** The singleton if already loaded, else null. Never triggers a download. */
  peek(): T | null;
}

function lazyView<T>(load: () => Promise<T>): LazyView<T> {
  let instance: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    get() {
      if (instance) return Promise.resolve(instance);
      if (!pending) {
        pending = load().then((view) => {
          instance = view;
          return view;
        });
        // A failed download (offline, a deploy replaced the chunk) must not
        // poison the cache: the next call retries.
        pending.catch(() => {
          pending = null;
        });
      }
      return pending;
    },
    peek() {
      return instance;
    },
  };
}

export const eventsViewLazy = lazyView<EventsView>(() =>
  import('../events/views/EventsView').then((m) => m.eventsView)
);
export const shadowfrontViewLazy = lazyView<ShadowfrontView>(() =>
  import('../shadowfront/views/ShadowfrontView').then((m) => m.shadowfrontView)
);
export const armsRaceViewLazy = lazyView<ArmsRaceView>(() =>
  import('../armsrace/views/ArmsRaceView').then((m) => m.armsRaceView)
);
export const overviewViewLazy = lazyView<OverviewView>(() =>
  import('../overview/views/OverviewView').then((m) => m.overviewView)
);
export const portalViewLazy = lazyView<PortalView>(() =>
  import('../portal/views/PortalView').then((m) => m.portalView)
);
export const statsViewLazy = lazyView<StatsView>(() => import('../stats/views/StatsView').then((m) => m.statsView));
export const historyViewLazy = lazyView<HistoryView>(() =>
  import('../history/views/HistoryView').then((m) => m.historyView)
);
export const gloryViewLazy = lazyView<GloryView>(() => import('../glory/views/GloryView').then((m) => m.gloryView));
export const ticketsViewLazy = lazyView<TicketsView>(() =>
  import('../tickets/views/TicketsView').then((m) => m.ticketsView)
);
export const migrationHubViewLazy = lazyView<MigrationHubView>(() =>
  import('../migration/views/MigrationHubView').then((m) => m.migrationHubView)
);
// The sanctions form is wired by init(); it used to run at boot, it now runs
// with the first load -- the form cannot be submitted before its tab is shown.
export const sanctionsViewLazy = lazyView<SanctionsView>(() =>
  import('../sanctions/views/SanctionsView').then((m) => {
    m.sanctionsView.init();
    return m.sanctionsView;
  })
);
