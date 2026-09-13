// Regression guard for Phase C of the UX audit roadmap: parallelized
// independent queries, batched per-row Supabase calls (OCR commit, bulk
// approve), a TTL freshness cache on the Stats/History tab loads (with
// explicit invalidation after mutations), and JS/CSS minification in the
// build pipeline.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('window.GM.debounce / runInChunks / cache (GM bridge)', () => {
  beforeEach(() => {
    if (window.GM && window.GM.cache) window.GM.cache.invalidate();
  });

  it('debounce collapses a burst of calls into one, after the delay', async () => {
    let calls = 0;
    const fn = window.GM.debounce(() => { calls++; }, 30);
    fn(); fn(); fn();
    expect(calls).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBe(1);
  });

  it('runInChunks processes all items in batches and returns their results in order', async () => {
    const seenConcurrently = [];
    const items = [1, 2, 3, 4, 5];
    const results = await window.GM.runInChunks(items, 2, async (n) => {
      seenConcurrently.push(n);
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(seenConcurrently.sort()).toEqual(items);
  });

  it('cache.isFresh is false until markFresh, true within the TTL, and false again after invalidate', () => {
    const key = 'test:key';
    expect(window.GM.cache.isFresh(key, 1000)).toBe(false);
    window.GM.cache.markFresh(key);
    expect(window.GM.cache.isFresh(key, 1000)).toBe(true);
    window.GM.cache.invalidate(key);
    expect(window.GM.cache.isFresh(key, 1000)).toBe(false);
  });

  it('cache.invalidate() with no key clears every tracked key', () => {
    window.GM.cache.markFresh('a');
    window.GM.cache.markFresh('b');
    window.GM.cache.invalidate();
    expect(window.GM.cache.isFresh('a', 1000)).toBe(false);
    expect(window.GM.cache.isFresh('b', 1000)).toBe(false);
  });
});

describe('StatsView / HistoryView TTL freshness gating', () => {
  // Stats + History migrated from root scripts to /src (Strangler cutover): the
  // TTL gates now live in their views behind the typed legacy cache adapter.
  const statsJs = read('src/modules/stats/views/StatsView.ts');
  const historyJs = read('src/modules/history/views/HistoryView.ts');

  it('initAndLoad() checks the cache freshness before re-fetching, keyed per guild', () => {
    expect(statsJs).toContain("const cacheKey = 'stats:'");
    expect(statsJs).toContain('legacy.cacheIsFresh(cacheKey, STATS_CACHE_TTL_MS)');
    expect(statsJs).toContain('legacy.cacheMarkFresh(cacheKey)');
  });

  it('loadHistory() has the same freshness gate plus a re-entrancy guard (previously had neither)', () => {
    expect(historyJs).toContain("const cacheKey = 'history:'");
    expect(historyJs).toContain('legacy.cacheIsFresh(cacheKey, HISTORY_CACHE_TTL_MS)');
    expect(historyJs).toContain('legacy.cacheMarkFresh(cacheKey)');
    expect(historyJs).toContain('historyLoading');
  });
});

describe('member mutations invalidate the cache the Stats/History pages depend on', () => {
  const membersCtrl = read('src/modules/app/members/members.controller.ts');
  const ocrCtrl = read('src/modules/app/ocr/ocr.controller.ts');

  it('invalidates after member delete, add, and edit', () => {
    const deleteStart = membersCtrl.indexOf('function deleteGuildMember');
    const deleteFn = membersCtrl.slice(deleteStart, deleteStart + 1500);
    expect(deleteFn).toContain('cache.invalidate()');

    const addStart = membersCtrl.indexOf('function handleAddMember');
    const addNextFn = membersCtrl.indexOf('export async function', addStart + 10);
    const addFn = membersCtrl.slice(addStart, addNextFn > addStart ? addNextFn : addStart + 6000);
    expect(addFn).toContain('cache.invalidate()');

    expect(membersCtrl).toMatch(/showToast\(t\('toast_member_updated'\), 'success'\);\s*if \(gm && gm\.cache && typeof gm\.cache\.invalidate === 'function'\) gm\.cache\.invalidate\(\);/);
  });

  it('invalidates after both OCR commit branches (event participation + roster metrics)', () => {
    const occurrences = ((membersCtrl + ocrCtrl).match(/cache\.invalidate\(/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(6);
  });

  it('invalidates after both transfer paths (instant transfer and the approve/reject queue)', () => {
    const resolveStart = membersCtrl.indexOf('function resolveTransfer');
    const resolveFn = membersCtrl.slice(resolveStart, resolveStart + 2000);
    expect(resolveFn).toContain('cache.invalidate()');
    expect(membersCtrl).toContain('transfer_guild_member');
  });
});

describe('Batched per-row Supabase calls (previously sequential for-loops)', () => {
  const ocrJs = read('src/modules/app/ocr/ocr.controller.ts');
  const eventsJs = read('src/modules/events/views/EventsView.ts');

  it('commitOcrUpdates/executeRosterCommit batch all known loops via runInChunks', () => {
    const start = ocrJs.indexOf('export async function commitOcrUpdates');
    const end = ocrJs.indexOf('function invalidateCache');
    const ocrFn = ocrJs.slice(start, end > start ? end : undefined);
    const runInChunksCalls = (ocrFn.match(/runInChunks\(/g) || []).length;
    expect(runInChunksCalls).toBeGreaterThanOrEqual(5);
    expect(ocrFn).not.toMatch(/for \(var i = 0; i < selected(Players|Existing)\.length; i\+\+\)/);
  });

  it('EventsView batches the "Approve All" loop via runInChunks', () => {
    expect(eventsJs).toContain('runInChunks(pendingPseudos, 10');
    expect(eventsJs).not.toMatch(/for \(var pi = 0; pi < pendingPseudos\.length; pi\+\+\)/);
  });
});

describe('showTransferMemberDialog fires its two independent queries in parallel', () => {
  const membersCtrl = read('src/modules/app/members/members.controller.ts');

  it('kicks off both promises before awaiting either', () => {
    const fnStart = membersCtrl.indexOf('function showTransferMemberDialog');
    const fn = membersCtrl.slice(fnStart, fnStart + 3000);
    const eligIdx = fn.indexOf('const eligPromise = client.rpc');
    const curIdx = fn.indexOf('const curPromise = client.from');
    const firstAwaitIdx = fn.indexOf('await eligPromise');
    expect(eligIdx).toBeGreaterThan(-1);
    expect(curIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(curIdx); // both created before either is awaited
  });
});

describe('Build pipeline minifies legacy JS/CSS instead of a byte-for-byte copy', () => {
  const buildJs = read('scripts/build.js');

  it('uses esbuild transform to minify legacy root scripts', () => {
    expect(buildJs).toContain("import { transform } from 'esbuild'");
    expect(buildJs).toContain("minify: true");
  });

  it('still runs the pre-existing node --check syntax gate before minifying', () => {
    expect(buildJs).toContain('node --check');
    expect(buildJs).toContain('Syntax check failed');
  });

  it('still excludes index.html from the copy loop (Vite already emits the correct bundled one)', () => {
    expect(buildJs).toContain("'index.html'");
  });
});
