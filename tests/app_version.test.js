// Regression guard for the owner-chosen release version (AGENTS.md §6):
// the user-facing app version (APP_VERSION in src/core/config/constants.ts) must
// be propagated systematically to the navigation bar (ShellView imports the
// constant; M4c removed the window bridge that used to carry it) and to the
// DISCORD_CHANGELOG.md title. A mismatch between the app version and
// the changelog version is a release blocker.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

function extractAppVersion() {
  const utils = read('src/core/config/constants.ts');
  const m = utils.match(/APP_VERSION = '([^']+)'/);
  expect(m, 'constants.ts must define APP_VERSION').not.toBeNull();
  return m[1];
}

describe('Release version propagation (v3.5.2)', () => {
  it('has one source for the version: the constant, not a bridge copy', () => {
    // M4c: src/core/gm-bridge.ts, which re-exposed APP_VERSION as
    // a global `appVersion`, is deleted. The constant is the only carrier.
    expect(fs.existsSync(path.resolve(root, 'src/core/gm-bridge.ts'))).toBe(false);
    const shell = read('src/modules/shell/views/ShellView.ts');
    expect(shell).toContain("import { APP_VERSION } from '../../../core/config/constants';");
  });

  it('ShellView renders the version above Terms & Conditions (sidebar + drawer) from the constant', () => {
    const shell = read('src/modules/shell/views/ShellView.ts');
    // Both render sites read APP_VERSION (never a hardcoded copy)
    const renders = (shell.match(/gm-app-version/g) || []).length;
    expect(renders).toBeGreaterThanOrEqual(2);
    expect(shell).toContain('escapeHTML(APP_VERSION)');
    // Order in the sidebar footer: version, then Privacy Policy, then Terms.
    const sidebarFooter = shell.slice(shell.indexOf('gm-sidebar-legal-footer'));
    const iVersion = sidebarFooter.indexOf('gm-app-version');
    const iPrivacy = sidebarFooter.indexOf('footer_privacy');
    const iTerms   = sidebarFooter.indexOf('footer_terms');
    expect(iVersion).toBeLessThan(iPrivacy);
    expect(iPrivacy).toBeLessThan(iTerms);
  });

  it('stacks the sidebar legal links instead of running them together', () => {
    // Reported from a screenshot: the sidebar read
    // "Terms & ConditionsPrivacy Policy" on one line, with nothing between the
    // two. `.gm-sidebar-legal-link` is an anchor, so it was inline, and adding
    // a second one simply put it flush against the first. Nothing in the test
    // suite could see that, which is why the rule is pinned here.
    const css = read('shell.css');
    const rule = css.slice(css.indexOf('.gm-sidebar-legal-link {'));
    const body = rule.slice(0, rule.indexOf('}'));
    // flex since M5, for a 24px hit area; a block-level box either way.
    expect(body, 'the links must not be inline: they render on one line').toMatch(/display:\s*(block|flex)/);
  });

  it('DISCORD_CHANGELOG.md title matches the app version exactly (no drift)', () => {
    const version = extractAppVersion();
    const discord = read('DISCORD_CHANGELOG.md');
    expect(discord).toContain(`CHANG_${version}`);
  });
});
