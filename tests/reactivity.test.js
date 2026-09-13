// Regression guard for Phase C of the UX audit roadmap: parallelized
// independent queries, batched per-row Supabase calls (OCR commit, bulk
// approve), a TTL freshness cache on the Stats/History tab loads (with
// explicit invalidation after mutations), and JS/CSS minification in the
// build pipeline.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import '../gm-utils.js';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('window.GM.debounce / runInChunks / cache (gm-utils.js)', () => {
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

describe('StatsView / history.js TTL freshness gating', () => {
  // Stats migrated from root stats.js to /src (Strangler cutover): the TTL
  // gate now lives in StatsView.ts behind the typed legacy cache adapter.
  const statsJs = read('src/modules/stats/views/StatsView.ts');
  const historyJs = read('history.js');

  it('initAndLoad() checks the cache freshness before re-fetching, keyed per guild', () => {
    expect(statsJs).toContain("const cacheKey = 'stats:'");
    expect(statsJs).toContain('legacy.cacheIsFresh(cacheKey, STATS_CACHE_TTL_MS)');
    expect(statsJs).toContain('legacy.cacheMarkFresh(cacheKey)');
  });

  it('loadHistory() has the same freshness gate plus a re-entrancy guard (previously had neither)', () => {
    expect(historyJs).toContain("var cacheKey = 'history:'");
    expect(historyJs).toContain('window.GM.cache.isFresh(cacheKey, HISTORY_CACHE_TTL_MS)');
    expect(historyJs).toContain('historyLoading');
  });
});

describe('app.js invalidates the cache after every mutation the Stats/History pages depend on', () => {
  const appJs = read('app.js');

  it('invalidates after member delete, add, and edit', () => {
    // Loose structural check: each of these functions contains an
    // invalidate() call somewhere after its success toast, without pinning
    // exact line numbers (all three are reused, deep in a large function).
    const deleteFn = appJs.slice(appJs.indexOf('async function deleteGuildMember'), appJs.indexOf('async function deleteGuildMember') + 1500);
    expect(deleteFn).toContain('window.GM.cache.invalidate()');

    const addStart = appJs.indexOf('async function handleAddMember');
    const addNextFn = appJs.indexOf('\n    async function ', addStart + 100);
    const addFn = appJs.slice(addStart, addNextFn);
    expect(addFn).toContain('window.GM.cache.invalidate()');

    expect(appJs).toContain("showToast(t('toast_member_updated'), 'success');\n            if (window.GM && window.GM.cache) window.GM.cache.invalidate();");
  });

  it('invalidates after both OCR commit branches (event participation + roster metrics)', () => {
    const occurrences = (appJs.match(/window\.GM\.cache\.invalidate\(\)/g) || []).length;
    // 6 known sites: delete, add, edit, 2 OCR branches, instant transfer,
    // plus resolveTransfer — at least 6, allowing headroom for the exact count.
    expect(occurrences).toBeGreaterThanOrEqual(6);
  });

  it('invalidates after both transfer paths (instant transfer and the approve/reject queue)', () => {
    const resolveStart = appJs.indexOf('window.GM.resolveTransfer = async function');
    const resolveFn = appJs.slice(resolveStart, resolveStart + 1500);
    expect(resolveFn).toContain('window.GM.cache.invalidate()');
    expect(appJs).toContain("transferred to ' + targetGuild + ' on Server #' + targetServer + '!', 'success');\n                if (window.GM && window.GM.cache) window.GM.cache.invalidate();");
  });
});

describe('Batched per-row Supabase calls (previously sequential for-loops)', () => {
  const appJs = read('app.js');
  const eventsJs = read('events.js');

  it('commitOcrUpdates() batches all 5 known loops (Shadowfront, Arms Race, generic event, existing-member updates, new-member inserts) via runInChunks', () => {
    const ocrFnStart = appJs.indexOf('async function commitOcrUpdates');
    const nextFnStart = appJs.indexOf('\n    async function ', ocrFnStart + 100);
    const ocrFn = appJs.slice(ocrFnStart, nextFnStart);
    const runInChunksCalls = (ocrFn.match(/window\.GM\.runInChunks\(/g) || []).length;
    expect(runInChunksCalls).toBeGreaterThanOrEqual(5);
    // No leftover sequential per-row for-loops in this function.
    expect(ocrFn).not.toMatch(/for \(var i = 0; i < selected(Players|Existing)\.length; i\+\+\)/);
  });

  it('events.js batches the "Approve All" loop via runInChunks', () => {
    expect(eventsJs).toContain('window.GM.runInChunks(pendingPseudos, 10');
    expect(eventsJs).not.toMatch(/for \(var pi = 0; pi < pendingPseudos\.length; pi\+\+\)/);
  });
});

describe('showTransferMemberDialog fires its two independent queries in parallel', () => {
  const appJs = read('app.js');

  it('kicks off both promises before awaiting either', () => {
    const fnStart = appJs.indexOf('async function showTransferMemberDialog');
    const fn = appJs.slice(fnStart, fnStart + 2500);
    const eligIdx = fn.indexOf('var eligPromise = supabase.rpc');
    const curIdx = fn.indexOf('var curPromise = supabase.from');
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
