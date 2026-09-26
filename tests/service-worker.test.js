/**
 * Service Worker retirement tests.
 *
 * The PWA was removed entirely. `src/sw/service-worker.ts` is now a
 * self-destructing tombstone whose only job is to unregister itself, so that
 * workers already installed on members' devices actually go away -- deleting the
 * file would have left them running forever.
 *
 * These tests lock in the two properties that make the kill switch work:
 *   1. it unregisters (and does not grow any new behaviour);
 *   2. nothing in the app registers a service worker any more.
 *
 * The previous suite tested `src/sw/push-payload.ts` and the push /
 * notificationclick handlers. Both are deleted; asserting they exist would keep
 * the dead pipeline alive.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');

function stripComments(raw) {
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function readSrcFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // `*.generated.ts` is a build artifact of the live database schema, not
      // authored code, so it is not scanned here. The drop migration HAS since
      // been applied and the types regenerated -- verified against production --
      // and `tests/phase2_pwa_retirement.test.js` asserts that directly rather
      // than leaving it to a scan that skips the file.
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts')) {
        out.push([full, fs.readFileSync(full, 'utf8')]);
      }
    }
  };
  walk(path.join(rootDir, 'src'));
  return out;
}

describe('service-worker.ts is a self-destructing tombstone', () => {
  const sourcePath = path.join(rootDir, 'src/sw/service-worker.ts');
  const code = stripComments(fs.readFileSync(sourcePath, 'utf8'));

  it('unregisters itself on activate', () => {
    expect(code).toContain("addEventListener('activate'");
    expect(code).toMatch(/registration\.unregister\(\)/);
  });

  it('claims control immediately so it does not wait for old tabs to close', () => {
    expect(code).toContain("addEventListener('install'");
    expect(code).toMatch(/skipWaiting\(\)/);
  });

  it('carries no push pipeline any more', () => {
    expect(code).not.toContain("addEventListener('push'");
    expect(code).not.toContain("addEventListener('notificationclick'");
    expect(code).not.toMatch(/showNotification/);
    expect(code).not.toMatch(/push-payload/);
  });

  it('registers no fetch handler', () => {
    expect(code).not.toContain("addEventListener('fetch'");
  });

  it('purges Cache Storage but never populates it', () => {
    // The tombstone deliberately *deletes* caches (defensive: a stale cached
    // index.html must not outlive the worker) but must never create one.
    expect(code).toMatch(/caches/);
    expect(code).toMatch(/\.delete\(/);
    expect(code).not.toMatch(/caches\.open/);
    expect(code).not.toMatch(/\.addAll\(/);
    expect(code).not.toMatch(/\.put\(/);
  });
});

describe('nothing registers a service worker any more', () => {
  const files = readSrcFiles();

  it('has no serviceWorker.register call anywhere in src/', () => {
    const offenders = files
      .filter(([, raw]) => /serviceWorker\s*\.\s*register\s*\(/.test(stripComments(raw)))
      .map(([file]) => path.relative(rootDir, file));
    expect(offenders).toEqual([]);
  });

  it('has no PWA install prompt or App Badge plumbing left', () => {
    const offenders = files
      .filter(([, raw]) => {
        const code = stripComments(raw);
        return /beforeinstallprompt|setAppBadge|clearAppBadge|promptPWAInstall/.test(code);
      })
      .map(([file]) => path.relative(rootDir, file));
    expect(offenders).toEqual([]);
  });

  it('has no push subscribe path or GM_PUSH bridge left', () => {
    const offenders = files
      .filter(([, raw]) => {
        const code = stripComments(raw);
        return /pushManager|GM_PUSH|save_push_subscription/.test(code);
      })
      .map(([file]) => path.relative(rootDir, file));
    expect(offenders).toEqual([]);
  });
});

describe('the PWA manifest and its icons are gone', () => {
  it('ships no manifest file', () => {
    expect(fs.existsSync(path.join(rootDir, 'manifest.webmanifest'))).toBe(false);
  });

  it('is not referenced by any HTML entrypoint', () => {
    for (const page of ['index.html', 'terms.html']) {
      const html = fs.readFileSync(path.join(rootDir, page), 'utf8');
      expect(html, `${page} must not link a manifest`).not.toMatch(/rel="manifest"/);
      expect(html, `${page} must not link an apple-touch-icon`).not.toMatch(/apple-touch-icon/);
    }
  });

  it('ships none of the install-only PNG icons', () => {
    // 612 KB of PNGs that only the manifest and the iOS install flow consumed.
    for (const icon of [
      'icon-192.png',
      'icon-512.png',
      'icon-192-maskable.png',
      'icon-512-maskable.png',
      'apple-touch-icon.png',
    ]) {
      expect(fs.existsSync(path.join(rootDir, icon)), `${icon} must be deleted`).toBe(false);
    }
  });

  it('keeps the plain favicons, which are not PWA assets', () => {
    expect(fs.existsSync(path.join(rootDir, 'favicon.ico'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'favicon.png'))).toBe(true);
  });
});
