// Regression guard for the owner-chosen release version (AGENTS.md §6):
// the user-facing app version (APP_VERSION in gm-utils.js) must be propagated
// systematically to the navigation bar (read dynamically via window.GM.appVersion)
// and to the DISCORD_CHANGELOG.md title. A mismatch between the app version and
// the changelog version is a release blocker.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

function extractAppVersion() {
  const utils = read('gm-utils.js');
  const m = utils.match(/var APP_VERSION = '([^']+)'/);
  expect(m, 'gm-utils.js must define var APP_VERSION').not.toBeNull();
  return m[1];
}

describe('Release version propagation (v3.5.2)', () => {
  it('gm-utils.js exposes the version through the GM bridge', () => {
    const utils = read('gm-utils.js');
    expect(utils).toContain('appVersion: APP_VERSION');
  });

  it('ShellView renders the version above Terms & Conditions (sidebar + drawer) via the dynamic bridge value', () => {
    const shell = read('src/modules/shell/views/ShellView.ts');
    // Both render sites read window.GM.appVersion dynamically (never a hardcoded copy)
    const renders = (shell.match(/gm-app-version/g) || []).length;
    expect(renders).toBeGreaterThanOrEqual(2);
    expect(shell).toContain('g.appVersion');
    // The version element sits above the Terms & Conditions link in the sidebar
    const sidebarFooter = shell.slice(shell.indexOf('gm-sidebar-legal-footer'));
    expect(sidebarFooter.indexOf('gm-app-version')).toBeLessThan(sidebarFooter.indexOf('footer_terms'));
  });

  it('DISCORD_CHANGELOG.md title matches the app version exactly (no drift)', () => {
    const version = extractAppVersion();
    const discord = read('DISCORD_CHANGELOG.md');
    expect(discord).toContain(`CHANG_${version}`);
  });
});
