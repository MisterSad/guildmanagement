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
    const shell = read('src/modules/shell/views/ShellView.ts');
    const navStart = shell.indexOf('const NAV_ITEMS: ShellNavItem[] = [');
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

  it('shell module wires the sub-tabs to the draft/svs/gvg loaders', () => {
    const shell = read('src/modules/shell/views/ShellView.ts');
    expect(shell).toContain('wireSettingsSubtabs');
    expect(shell).toContain('draft: () => callLoad(lazyModules.settings())');
    expect(shell).toContain('svs: () => callLoad(lazyModules.svsMatchup())');
    expect(shell).toContain('gvg: () => callLoad(lazyModules.gvgMatchup())');
    expect(shell).toContain('this.wireSettingsSubtabs();');
  });
});
