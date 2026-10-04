/**
 * Root Scripts Hygiene & Build Artifact Cleanliness Tests
 *
 * Validates TICKET-12 [MAINT-01]:
 * 1. Test config files (playwright.config.js, vitest.config.js) are explicitly excluded from dist/ in scripts/build.js.
 * 2. dist/ directory never contains dev/test configuration files.
 * 3. Obsolete/one-off maintenance scripts are properly archived in scripts/archive/.
 * 4. Only genuine web distribution assets are emitted to dist/.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const scriptsDir = path.join(rootDir, 'scripts');
const archiveDir = path.join(scriptsDir, 'archive');
const distDir = path.join(rootDir, 'dist');
const buildJsPath = path.join(scriptsDir, 'build.js');

describe('TICKET-12 [MAINT-01]: Root Scripts Hygiene & Build Exclusion', () => {
  it('excludes test configuration files in scripts/build.js EXCLUDED_FILES', () => {
    expect(fs.existsSync(buildJsPath)).toBe(true);
    const buildJs = fs.readFileSync(buildJsPath, 'utf8');

    expect(buildJs).toContain("'playwright.config.js'");
    expect(buildJs).toContain("'vitest.config.js'");
    expect(buildJs).not.toContain("'vitest.config.ts'");
  });

  it('ensures dist/ contains zero test configuration files', () => {
    if (fs.existsSync(distDir)) {
      const distFiles = fs.readdirSync(distDir);
      expect(distFiles).not.toContain('playwright.config.js');
      expect(distFiles).not.toContain('vitest.config.js');
      expect(distFiles).not.toContain('package.json');
      expect(distFiles).not.toContain('tsconfig.json');
    }
  });

  it('verifies that obsolete maintenance scripts are housed in scripts/archive/', () => {
    expect(fs.existsSync(archiveDir)).toBe(true);
    const archivedFiles = fs.readdirSync(archiveDir);

    expect(archivedFiles).toContain('bump_cache_busters.py');
    expect(archivedFiles).toContain('analyze_event_ids.py');
    expect(archivedFiles).toContain('migrate_event_ids.py');
    expect(archivedFiles).toContain('README.md');
  });

  it('verifies that scripts/archive/README.md documents all archived scripts', () => {
    const readmePath = path.join(archiveDir, 'README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
    const readme = fs.readFileSync(readmePath, 'utf8');

    expect(readme).toContain('bump_cache_busters.py');
    expect(readme).toContain('analyze_event_ids.py');
    expect(readme).toContain('migrate_event_ids.py');
  });

  it('verifies that only active operational scripts remain in scripts/', () => {
    const activeScripts = fs.readdirSync(scriptsDir).filter((f) => fs.statSync(path.join(scriptsDir, f)).isFile());

    // Only operational scripts remain at scripts/ root
    expect(activeScripts).toContain('build.js');
    expect(activeScripts).toContain('generate-compliance-pdf.js');
    // generate_demo_data.py went with the DEMO tenant (2026-10-04).
    expect(activeScripts).not.toContain('generate_demo_data.py');
    // register-discord-commands.mjs was DELETED on 2026-09-28, not archived: it
    // was a third command registry, run by hand, that nothing kept in step with
    // the worker and the Edge Function. The worker registers every command on
    // boot -- globally and per guild for instant availability -- so a manual
    // script could only ever drift or wipe.
    expect(activeScripts).not.toContain('register-discord-commands.mjs');

    // Archived scripts are no longer at scripts/ root
    expect(activeScripts).not.toContain('bump_cache_busters.py');
    expect(activeScripts).not.toContain('analyze_event_ids.py');
    expect(activeScripts).not.toContain('migrate_event_ids.py');
  });
});
