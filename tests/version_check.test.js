import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Regression: stale long-lived tabs must be detected against version.json', () => {
    // Reported live: a user saw two different app versions depending on
    // which guild tab they had open -- one tab had simply never reloaded
    // since before the latest deploy (long-lived tab / PWA install), so it
    // kept silently running old code, missing every fix shipped since.
    // app.js polls /version.json (network-fresh, cache: 'no-store') and
    // prompts a reload when it disagrees with the version already running.
    const appSrc = fs.readFileSync(path.resolve(__dirname, '../app.js'), 'utf-8');
    const buildSrc = fs.readFileSync(path.resolve(__dirname, '../scripts/build.js'), 'utf-8');
    const utilsSrc = fs.readFileSync(path.resolve(__dirname, '../gm-utils.js'), 'utf-8');

    it('app.js fetches version.json with cache: no-store, not a cacheable request', () => {
        expect(appSrc).toMatch(/fetch\(['"]\/version\.json['"],\s*\{\s*cache:\s*['"]no-store['"]\s*\}\)/);
    });

    it('app.js compares the fetched version against the currently-running APP_VERSION before prompting', () => {
        expect(appSrc).toContain('data.version !== CURRENT_APP_VERSION');
        expect(appSrc).toContain('window.GM && window.GM.appVersion');
    });

    it('checks on tab visibility regain, not just a blind interval', () => {
        expect(appSrc).toMatch(/visibilitychange/);
        expect(appSrc).toContain("document.visibilityState === 'visible'");
    });

    it('build.js writes version.json from gm-utils.js\'s real APP_VERSION -- single source of truth', () => {
        expect(buildSrc).toContain("readFileSync(path.join(rootDir, 'gm-utils.js')");
        expect(buildSrc).toContain("writeFileSync");
        expect(buildSrc).toContain("'version.json'");

        // Same extraction pattern app_version.test.js already uses for the
        // Discord changelog check -- cross-checked here against gm-utils.js
        // for real, so build.js's own regex can't silently drift and start
        // writing an empty/wrong version.json without a test catching it.
        const m = utilsSrc.match(/var APP_VERSION = '([^']+)'/);
        expect(m, 'gm-utils.js must define var APP_VERSION').not.toBeNull();
        expect(m[1]).toMatch(/^V\d+\.\d+/);
    });
});
