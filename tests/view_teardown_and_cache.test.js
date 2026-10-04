// Phase 6b: view teardown and derived-cache invalidation.
//
// Two defects, both structural rather than local:
//
//  1. Seven views define a `destroy()` and **none was ever called**. Everything
//     they allocate leaked for the whole session: two Realtime WebSocket
//     channels (Migration Hub), two setIntervals still touching the DOM of a
//     hidden tab (Overview), and window/document listeners. The Migration Hub
//     was worse than a leak -- its page handler re-ran a full `select('*')` on
//     any remote change, so with n admins editing, each edit cost n refetches,
//     including for users sitting on a different tab.
//
//  2. 55 write call sites across EventsView, ShadowfrontView, ArmsRaceView and
//     SanctionsView, and not one invalidated the Stats/History freshness
//     markers. Editing a war score and switching to Stats within the 15s TTL
//     showed the pre-edit numbers.
//
// Both fixes are placed where they cannot be forgotten: the router owns tab
// switching, and the write guard is the one path every tenant write takes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { installDbWriteGuard, TENANT_TABLES } from '../src/core/api/db-guard.ts';
import { isFresh, markFresh, invalidateGuildViews, derivedViewKeys, clear } from '../src/core/cache/cache.ts';
import { setVerifiedRole } from '../src/core/auth/roles.ts';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('derived-view cache invalidation', () => {
  beforeEach(() => clear());

  it('keys Stats and History exactly as those two views do', () => {
    // The only two readers of this cache key it this way; a drift here would
    // silently stop invalidating them.
    expect(derivedViewKeys('ALPHA')).toEqual(['stats:ALPHA', 'history:ALPHA']);

    const stats = read('src/modules/stats/views/StatsView.ts');
    const history = read('src/modules/history/views/HistoryView.ts');
    expect(stats).toContain("'stats:' + getActiveGuild()");
    expect(history).toContain("'history:' + currentG");
  });

  it('drops both markers for the guild, and leaves other guilds alone', () => {
    markFresh('stats:ALPHA');
    markFresh('history:ALPHA');
    markFresh('stats:BABE');

    invalidateGuildViews('ALPHA');

    expect(isFresh('stats:ALPHA', 15000)).toBe(false);
    expect(isFresh('history:ALPHA', 15000)).toBe(false);
    expect(isFresh('stats:BABE', 15000), 'another guild must not be purged').toBe(true);
  });
});

describe('the write guard invalidates on every tenant write', () => {
  /** Minimal Supabase-builder stand-in that records what was called. */
  function fakeDb() {
    const calls = [];
    const builder = () => {
      const b = {
        delete: (...a) => { calls.push(['delete', a]); return b; },
        update: (v) => { calls.push(['update', v]); return b; },
        insert: (v) => { calls.push(['insert', v]); return b; },
        upsert: (v) => { calls.push(['upsert', v]); return b; },
        eq: () => b,
      };
      return b;
    };
    return { from: () => builder(), __calls: calls };
  }

  beforeEach(() => {
    clear();
    // A super_admin can write any guild, so canWriteGuild() short-circuits to
    // true and the test isolates the invalidation rather than the ACL.
    setVerifiedRole('super_admin', 'tester');
    try { localStorage.setItem('gm_current_guild', 'ALPHA'); } catch { /* jsdom */ }
  });

  afterEach(() => setVerifiedRole(null, null));

  for (const op of ['delete', 'update', 'insert', 'upsert']) {
    it(`invalidates on ${op}`, () => {
      const db = installDbWriteGuard(fakeDb());
      markFresh('stats:ALPHA');
      markFresh('history:ALPHA');

      const b = db.from('event_participants');
      if (op === 'delete') b.delete();
      else b[op]({ pseudo: 'x' });

      expect(isFresh('stats:ALPHA', 15000), `${op} must drop the stats marker`).toBe(false);
      expect(isFresh('history:ALPHA', 15000), `${op} must drop the history marker`).toBe(false);
    });
  }

  it('covers the tables Stats and History actually aggregate', () => {
    // War scores, sanctions and weekly scores all feed those two views.
    for (const t of ['event_participants', 'event_daily_scores', 'war_sessions', 'sanctions', 'weekly_scores']) {
      expect(TENANT_TABLES, `${t} must be guarded for invalidation to reach it`).toContain(t);
    }
  });

  it('does not invalidate for a non-tenant table', () => {
    const db = installDbWriteGuard(fakeDb());
    markFresh('stats:ALPHA');
    db.from('accounts').update({ role: 'member' });
    expect(isFresh('stats:ALPHA', 15000)).toBe(true);
  });
});

describe('the router tears down the view it navigates away from', () => {
  const router = stripComments(read('src/modules/app/router.ts'));

  it('maps the views that hold timers, channels or listeners', () => {
    // Phase 7: these were `window.GM_*` namespace names resolved by string.
    // They are imported view objects now, so a rename is a compile error rather
    // than a teardown that silently stops happening.
    expect(router).toContain('TEARDOWN_BY_TAB');
    // M5: the views are lazy; only one already loaded has anything to release.
    for (const view of ['migrationHubView', 'overviewView', 'sanctionsView']) {
      expect(router, `${view} must be torn down`).toContain(`${view}Lazy.peek()?.destroy()`);
    }
  });

  it('leaves the global chrome alone', () => {
    // Destroying these on a tab switch would dismantle the navigation and the
    // help popover -- they are not tabs.
    const map = router.slice(router.indexOf('TEARDOWN_BY_TAB'), router.indexOf('teardownPreviousTab'));
    expect(map).not.toContain('shellView');
    expect(map).not.toContain('helpView');
  });

  it('calls the teardown before mounting the next view, and tracks what is mounted', () => {
    expect(router).toContain('teardownPreviousTab(mountedTabId, tabId)');
    expect(router).toContain('mountedTabId = tabId');
  });

  it('does not tear down when switching between aliases of the same view', () => {
    // 'overview' and 'gm-overview' are the same view; a switch between them
    // must not clear its timers.
    // The two ids now map to the SAME object, so identity comparison is what
    // distinguishes an alias switch from a real one.
    expect(router).toContain('if (TEARDOWN_BY_TAB[nextTabId] === target) return;');
  });

  it('never lets a failing destroy break navigation', () => {
    const fn = router.slice(router.indexOf('function teardownPreviousTab'), router.indexOf('let mountedTabId'));
    expect(fn).toContain('try {');
    expect(fn).toContain('catch');
  });
});

describe('the views the router tears down actually define destroy', () => {
  // Phase 7: this used to check the `window.GM_*` bridge exposed `destroy`.
  // The router holds the view objects directly, so the bridge is no longer the
  // thing that has to carry it -- the view is.
  const views = {
    migrationHubView: 'src/modules/migration/views/MigrationHubView.ts',
    overviewView: 'src/modules/overview/views/OverviewView.ts',
    sanctionsView: 'src/modules/sanctions/views/SanctionsView.ts'
  };

  for (const [name, file] of Object.entries(views)) {
    it(`${name} defines destroy()`, () => {
      expect(stripComments(read(file)), `${file} must define destroy()`).toMatch(/\bdestroy\(\)\s*:?\s*(void)?\s*\{/);
    });
  }
});

describe('Migration Hub realtime no longer amplifies', () => {
  const view = read('src/modules/migration/views/MigrationHubView.ts');
  const code = stripComments(view);

  it('debounces the page-change reload instead of refetching per event', () => {
    expect(code).toContain('reloadFromRealtime');
    expect(code).toMatch(/debounce\(/);
    // The handler must no longer call load() directly.
    const pagesAt = code.indexOf("table: 'migration_wiki_pages'");
    const handler = code.slice(pagesAt, code.indexOf('.subscribe()', pagesAt));
    expect(handler).toContain('this.reloadFromRealtime()');
    expect(handler).not.toMatch(/this\.load\(\);/);
  });

  it('will not resurrect the channels after destroy has removed them', () => {
    // `debounce` exposes no cancel, so a reload scheduled just before the user
    // navigates away would otherwise fire after destroy() and re-subscribe.
    const decl = code.slice(code.indexOf('reloadFromRealtime = debounce'), code.indexOf('}, 800)'));
    expect(decl).toContain('if (!this.realtimeChannel) return;');
  });

  it('keeps the comments handler targeted, as it already was', () => {
    expect(code).toContain('payload.new?.page_id === activePageId');
  });
});
