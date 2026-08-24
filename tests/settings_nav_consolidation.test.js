// Regression guard for the settings nav consolidation (2026-08-24): the
// super-admin "Draft", "SvS", and "GvG" tabs are grouped under a single
// "Settings" nav item exposing three sub-tabs.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Settings sub-tab consolidation (v3.5.2)', () => {
  it('NAV_ITEMS no longer registers standalone SvS/GvG matchup items', () => {
    const shell = read('shell.js');
    const navStart = shell.indexOf('var NAV_ITEMS = [');
    const navEnd = shell.indexOf('];', navStart);
    const nav = shell.slice(navStart, navEnd);
    expect(nav).not.toContain("id: 'svs-matchup'");
    expect(nav).not.toContain("id: 'gvg-matchup'");
    expect(nav).toContain("id: 'settings'");
  });

  it('the settings panel hosts a sub-tab bar and all three containers', () => {
    const html = read('index.html');
    expect(html).toContain('id="settings-subtabs"');
    expect(html).toContain('data-settings-tab="draft"');
    expect(html).toContain('data-settings-tab="svs"');
    expect(html).toContain('data-settings-tab="gvg"');
    expect(html).toContain('data-settings-panel="draft"');
    expect(html).toContain('data-settings-panel="svs"');
    expect(html).toContain('data-settings-panel="gvg"');
    // The old standalone panels are gone
    expect(html).not.toContain('id="tab-svs-matchup"');
    expect(html).not.toContain('id="tab-gvg-matchup"');
  });

  it('shell.js wires the sub-tabs to the draft/svs/gvg loaders', () => {
    const shell = read('shell.js');
    expect(shell).toContain('function wireSettingsSubtabs');
    expect(shell).toContain('draft: function () { if (window.GM_SETTINGS) window.GM_SETTINGS.load(); }');
    expect(shell).toContain('svs:   function () { if (window.GM_SVS_MATCHUP) window.GM_SVS_MATCHUP.load(); }');
    expect(shell).toContain('gvg:   function () { if (window.GM_GVG_MATCHUP) window.GM_GVG_MATCHUP.load(); }');
    expect(shell).toContain('wireSettingsSubtabs();');
  });
});
