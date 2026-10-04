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
    expect(statsJs).toContain('isCacheFresh(cacheKey, STATS_CACHE_TTL_MS)');
    expect(statsJs).toContain('markCacheFresh(cacheKey)');
  });

  it('loadHistory() has the same freshness gate plus a re-entrancy guard (previously had neither)', () => {
    expect(historyJs).toContain("const cacheKey = 'history:'");
    expect(historyJs).toContain('isFresh(cacheKey, HISTORY_CACHE_TTL_MS)');
    expect(historyJs).toContain('markFresh(cacheKey)');
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

    expect(membersCtrl).toMatch(/showToast\(t\('toast_member_updated'\), 'success'\);\s*cache\.invalidate\(\);/);
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
    // M4a: the per-row write loops became one transactional call each
    // (gm_record_event_attendance, gm_commit_ocr_roster); only the UID
    // pre-check probes still fan out, through runInChunks.
    expect((ocrFn.match(/runInChunks\(/g) || []).length).toBeGreaterThanOrEqual(1);
    expect((ocrFn.match(/await recordEventAttendance\(/g) || []).length).toBe(3);
    expect(ocrFn).toContain('await commitOcrRoster(');
    expect(ocrFn).not.toMatch(/for \(var i = 0; i < selected(Players|Existing)\.length; i\+\+\)/);
  });

  it('the UID pre-check no longer makes three serial round trips per player', () => {
    // It was a sequential `for (const targetUid of ...)` doing a collision
    // probe, a player lookup and a ban check per UID: 200-300 serialised
    // requests for a 100-player import, ~16-24s of frozen UI.
    expect(ocrJs).not.toMatch(/for \(const targetUid of Array\.from\(newUidSeen\)\)/);
    // The ban check is now one query for the whole batch...
    expect(ocrJs).toContain('await findBannedUids(client, targetUids)');
    expect(read('src/modules/ocr/ocr.service.ts')).toMatch(/from\('banned_players'\)\.select\('uid'\)\.in\('uid', uids\)/);
    // ...and the collision probes run 10 at a time.
    expect(ocrJs).toContain('runInChunks(targetUids, 10');
    // A single UID failing must still not fail the whole commit.
    const probe = ocrJs.slice(ocrJs.indexOf('runInChunks(targetUids, 10'));
    expect(probe).toContain('catch (_)');
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
    const eligIdx = fn.indexOf('const eligPromise = listTransferEligibleGuilds(client');
    const curIdx = fn.indexOf('const curPromise = fetchGuildServerNumber(client');
    const firstAwaitIdx = fn.indexOf('await eligPromise');
    expect(eligIdx).toBeGreaterThan(-1);
    expect(curIdx).toBeGreaterThan(-1);
    expect(firstAwaitIdx).toBeGreaterThan(curIdx); // both created before either is awaited
  });
});

describe('Build pipeline: the root copy loop', () => {
  const buildJs = read('scripts/build.js');

  // PHASE 3. This block used to assert that the loop minified root JS and CSS.
  // Measured against the actual repository, BOTH branches were unreachable: the
  // five root stylesheets are excluded because Vite bundles them through
  // main.ts, and the only root `.js` files are playwright.config.js and
  // vitest.config.js, excluded for the same reason. `minifiedCount` was always
  // 0, so the "Minified N JS/CSS files" summary never printed either. The
  // assertions passed by reading source text for code that never executed.
  //
  // Removing those branches was verified the only way that means anything:
  // dist/ came out with the same 11 files at identical byte sizes.

  it('copies exactly the root assets Vite does not emit', () => {
    expect(buildJs).toContain('fs.copyFileSync(srcPath, destPath)');
    // favicon.ico, favicon.png and terms.html -- nothing else qualifies.
    expect(buildJs).toMatch(/\['\.js', '\.css', '\.webmanifest', '\.png', '\.json', '\.html', '\.ico'\]/);
  });

  it('keeps excluding what Vite already bundles', () => {
    for (const f of ['index.html', 'tokens.css', 'theme.css', 'styles.css', 'components.css', 'shell.css']) {
      expect(buildJs, `${f} must stay excluded`).toContain(`'${f}'`);
    }
  });

  it('no longer claims to minify anything', () => {
    expect(buildJs).not.toContain('minifyToDist');
    expect(buildJs).not.toContain('Minified ');
  });

  it('still syntax-checks root scripts, in the suite that always runs', () => {
    // The `node --check` gate the removed branch carried is not lost: this one
    // runs over every root script whether or not a build happens.
    const rootSyntax = read('tests/root_syntax.test.js');
    expect(rootSyntax).toContain('node --check');
  });
});
