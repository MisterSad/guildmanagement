// Phase 2 — the PWA and Web Push are retired. What is left is the ONE step the
// plan deliberately ordered last, and the dependencies that make it work.
//
// The state of the world, measured rather than assumed (2026-09-27):
//   - repo: manifest, PushService, pwa.ts, the five install-only PNGs, the push
//     payload module and its tests are all gone; `src/sw/service-worker.ts` is a
//     456-byte tombstone whose only job is to unregister itself.
//   - database: push_subscriptions, player_push_prefs, save_push_subscription,
//     gm_get_push_prefs and gm_set_push_prefs are all dropped, no surviving
//     function body or cron command names them, and the generated types are
//     regenerated. That closes finding C2 (anonymous cross-tenant push writes
//     with a COALESCE(..., 'ALPHA') fallback) completely.
//   - production: still serving the OLD push worker. Checked directly --
//       curl -sS https://guildmanagement.vercel.app/sw.js | grep -c unregister  →  0
//     and it still installs `push` and `notificationclick` handlers.
//
// So `src/sw/` MUST NOT be deleted yet. Deleting a service worker's source does
// not uninstall it: a worker already installed on a member's device runs forever,
// independently of the page that registered it. It goes away only when the
// browser can fetch a NEW /sw.js from that exact URL and watch it unregister.
// Release n ships the tombstone; only after a full cycle may release n+1 delete
// the source.
//
// `tests/service-worker.test.js` already pins what the tombstone DOES. This file
// pins the three things that make it reach anybody, none of which were checked:
//
//   1. the tombstone trio is all-or-nothing -- source, build step and dev plugin;
//   2. /sw.js must be served revalidating, or the browser keeps the old worker;
//   3. the offline copy must not promise a sync that does not exist (H6).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(rootDir, p));
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');

const SW_SOURCE = 'src/sw/service-worker.ts';

describe('the tombstone trio is all-or-nothing', () => {
  // Three things must travel together: the source, the esbuild step that emits
  // it to dist/sw.js, and the dev plugin that serves it at /sw.js locally.
  // Half-deleting them is the dangerous state, and it is SILENT: /sw.js starts
  // 404ing, no test notices, and every installed push worker lives forever
  // because the browser can no longer fetch a replacement.
  // Comments must be stripped first, and this is not pedantry: both files
  // explain the tombstone in prose that NAMES `src/sw/service-worker.ts`, so a
  // bare path search stays true after the code is deleted. The first version of
  // this test did exactly that and passed its own sabotage. What is asserted is
  // the live call site -- the esbuild entry point, and the dev plugin's route.
  const hasSource = exists(SW_SOURCE);
  //
  // A path search is still not enough after stripping comments, because
  // `build.js` also prints the path in a console.log STRING -- so the second
  // version of this test passed its sabotage too. What has to be asserted is the
  // entry point's own assignment, plus the esbuild call that consumes it.
  const buildJs = stripComments(read('scripts/build.js'));
  const hasBuildStep =
    /swEntry\s*=\s*path\.join\([^)]*['"]src\/sw\/service-worker\.ts['"]/.test(buildJs) &&
    /entryPoints:\s*\[\s*swEntry/.test(buildJs);
  const hasDevPlugin = /src\/sw\/service-worker\.ts/.test(stripComments(read('vite.config.ts')));

  it('has the source, the build step and the dev plugin in lockstep', () => {
    expect(
      { hasSource, hasBuildStep, hasDevPlugin },
      'these three must be all present (release n, tombstone shipping) or all ' +
        'absent (release n+1, after a full cycle). A mixed state 404s /sw.js.'
    ).toEqual({ hasSource: hasBuildStep, hasBuildStep, hasDevPlugin: hasBuildStep });
  });

  it('emits it at the ROOT of dist, because the path must stay /sw.js exactly', () => {
    // A service worker can only be replaced from the URL it was registered
    // from. Emitting it to dist/assets/ with a hashed name -- the natural thing
    // for every other asset -- would leave the old worker unreachable forever.
    const build = read('scripts/build.js');
    expect(build).toMatch(/outfile:\s*path\.join\(distDir,\s*['"]sw\.js['"]\)/);
  });

  it('records the deployment gate in the source, not just in a plan document', () => {
    // The next person to open this file is the one who might delete it early.
    const raw = read(SW_SOURCE);
    expect(raw).toMatch(/TOMBSTONE/);
    expect(raw).toMatch(/release cycle/i);
  });
});

describe('/sw.js is served so the browser actually sees the replacement', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const headersFor = (source) => {
    const rule = vercel.headers.find((h) => h.source === source);
    const out = {};
    for (const { key, value } of rule ? rule.headers : []) out[key.toLowerCase()] = value;
    return out;
  };

  it('revalidates /sw.js rather than caching it', () => {
    // This is the dependency nobody had pinned. The tombstone only runs if the
    // browser re-fetches /sw.js and sees different bytes. Serve it with a long
    // max-age or `immutable` and the CDN or the HTTP cache keeps handing back
    // the OLD worker -- the kill switch never arrives, and nothing fails
    // loudly enough to notice.
    const cc = headersFor('/sw.js')['cache-control'];
    expect(cc, '/sw.js needs an explicit Cache-Control rule').toBeTruthy();
    expect(cc).toMatch(/no-cache|no-store|max-age=0/);
    expect(cc).not.toMatch(/immutable/);
  });

  it('still caches the hashed assets immutably, which is the whole point of hashing', () => {
    expect(headersFor('/assets/(.*)')['cache-control']).toMatch(/immutable/);
  });

  it('revalidates index.html and version.json, since no worker manages freshness now', () => {
    // With the service worker gone, freshness rests entirely on the CDN. These
    // rules are what replaced it; they were previously undeclared and relied on
    // Vercel's undocumented defaults.
    expect(headersFor('/')['cache-control']).toMatch(/no-cache|no-store|max-age=0/);
    expect(headersFor('/version.json')['cache-control']).toMatch(/no-cache|no-store|max-age=0/);
  });
});

describe('the offline message states what actually happens', () => {
  // H6. The old copy read "Working offline. Local changes will sync when
  // online." There is no write queue and no background sync anywhere in this
  // app, so every offline write is lost -- the message actively encouraged
  // users to keep working and lose it.
  const src = read('src/core/net/network-status.ts');
  const code = stripComments(src);

  it('does not promise a sync, a queue or a re-sync', () => {
    expect(code).not.toMatch(/sync/i);
    expect(code).not.toMatch(/queue/i);
  });

  it('says plainly that changes will not be saved', () => {
    expect(code).toMatch(/will not be saved/);
  });

  it('is backed by nothing that could implement a sync, anywhere in src/', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.ts') && rel !== `src/${SW_SOURCE.slice(4)}`) {
          const code2 = stripComments(read(rel));
          if (/indexedDB|caches\.open|backgroundSync|periodicSync|addEventListener\(['"]sync['"]/.test(code2)) {
            offenders.push(rel);
          }
        }
      }
    };
    walk('src');
    expect(offenders, `offline-persistence machinery found in: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('phase-2 residue that measurement says is already gone', () => {
  it('no Edge Function reads a VAPID key from the environment any more', () => {
    // The distinction matters, and my first version of this test got it wrong by
    // grepping for the string: `_shared/logger.ts` names `vapid_private_key` in
    // its redaction DENYLIST, which is the opposite of residue. Only an actual
    // env read is dead weight.
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.ts$/.test(e.name)) {
          const code = stripComments(read(rel));
          if (/env\s*\.\s*get\s*\(\s*['"]VAPID/i.test(code) || /webpush|web-push/i.test(code)) {
            offenders.push(rel);
          }
        }
      }
    };
    walk('supabase/functions');
    expect(offenders, `VAPID env read or web-push library in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('KEEPS vapid_private_key in the log scrubber, deliberately', () => {
    // A stale entry in a redaction denylist is free and can only ever help: if
    // such a value somehow reaches a log payload it gets masked. Pruning these
    // alongside the feature is a "cleanup" whose only possible effect is to make
    // logs less safe, so it is pinned here as intentional rather than missed.
    const logger = read('supabase/functions/_shared/logger.ts');
    expect(logger).toContain('vapid_private_key');
  });

  it('has a drop migration for the push tables and their RPCs', () => {
    const drop = read('supabase/migrations/20260926120000_drop_web_push.sql');
    for (const obj of [
      'push_subscriptions',
      'player_push_prefs',
      'save_push_subscription',
      'gm_get_push_prefs',
      'gm_set_push_prefs'
    ]) {
      expect(drop, `${obj} must be dropped by the migration`).toContain(obj);
    }
  });

  it('no longer names the dropped tables in the generated database types', () => {
    // Regenerating these is the step that is easy to forget: the types are the
    // only place a dropped table can keep looking callable to `tsc`.
    const types = read('src/types/database.generated.ts');
    for (const obj of ['push_subscriptions', 'player_push_prefs', 'save_push_subscription']) {
      expect(types, `${obj} is still in the generated types: regenerate them`).not.toContain(obj);
    }
  });
});
