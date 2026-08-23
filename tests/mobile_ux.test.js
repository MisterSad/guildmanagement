// Regression guard for the 2026-08-23 mobile UX remediation (v128.0):
// portal bottom nav overflow (7 items in a 4-col grid under a fixed 70px bar),
// unscrollable centered modal overlays, and per-metric matchup grids that
// could not collapse on phones.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Mobile UX regression guards (v128.0)', () => {
  it('portal bottom nav renders 4 primary tabs + More sheet, not all 7 in one bar', () => {
    const portal = read('portal.js');
    expect(portal).toContain("primaryNavIds = ['settings', 'dashboard', 'challenges', 'events']");
    expect(portal).toContain("drawerNavIds = ['absence', 'badges', 'donation']");
    expect(portal).toContain('data-portal-more');
    expect(portal).toContain('data-portal-drawer');
    // The nav bar must render exactly the primary set + More (not navItems wholesale)
    expect(portal).toMatch(/primaryNavIds\.map/);
    expect(portal).toMatch(/drawerNavIds\.map/);
  });

  it('portal content clears the bottom nav on mobile (padding includes nav height + safe area)', () => {
    const css = read('components.css');
    expect(css).toMatch(/\.portal-shell \.gm-content \{[\s\S]*?calc\(var\(--bottom-nav-h/);
    expect(css).toContain('.portal-shell .gm-bottom-nav-inner { grid-template-columns: repeat(5, 1fr); }');
  });

  it('modal overlays scroll when their card exceeds the viewport (no fixed centering trap)', () => {
    const styles = read('styles.css');
    const components = read('components.css');
    // Extract the actual rule body (between braces), stripping comments
    const ruleBody = (css, selector) => {
      const start = css.indexOf(selector);
      if (start === -1) return '';
      const open = css.indexOf('{', start);
      const close = css.indexOf('}', open);
      return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
    };
    const overlayBody = ruleBody(styles, '.confirm-overlay {');
    expect(overlayBody).toContain('overflow-y: auto');
    expect(overlayBody).not.toContain('align-items');
    const cardBody = ruleBody(styles, '.confirm-card {');
    expect(cardBody).toContain('margin: auto');
    const modalBody = ruleBody(components, '.gm-modal-overlay {');
    expect(modalBody).toContain('overflow-y: auto');
    expect(modalBody).not.toContain('align-items');
    const modalCardBody = ruleBody(components, '.gm-modal-overlay .gm-modal-card {');
    expect(modalCardBody).toContain('margin: auto');
  });

  it('svs/gvg matchup grids use the collapsible class instead of inline 2-col templates', () => {
    for (const f of ['svs-matchup.js', 'gvg-matchup.js']) {
      const src = read(f);
      expect(src, f + ' must not contain inline 2-col grid templates').not.toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\)/);
      expect(src, f + ' must use gm-matchup-2col').toContain('gm-matchup-2col');
    }
    const css = read('components.css');
    const gridBlock = css.slice(css.indexOf('.gm-matchup-2col'), css.indexOf('.gm-matchup-2col') + 400);
    expect(gridBlock).toContain('minmax(0, 1fr) minmax(0, 1fr)');
    expect(gridBlock).toMatch(/@media \(max-width: 640px\)[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('wide admin tables degrade to cards on mobile (gm-resp-table + data labels + no forced min-width)', () => {
    const css = read('components.css');
    expect(css).toMatch(/\.gm-resp-table \{ min-width: 0 !important; \}/);
    const app = read('app.js');
    expect(app).toContain('gm-table gm-resp-table');
    expect(app).toContain('data-label="Rally Score"');
    const crossRank = read('cross-rank.js');
    expect(crossRank).toContain('gm-draft-table gm-resp-table');
    const stats = read('stats.js');
    expect(stats).toContain('gm-table gm-resp-table');
    expect(stats).toContain('data-label="Score"');
  });

  it('portal charts are DPR-aware and redraw on resize', () => {
    const portal = read('portal.js');
    expect(portal).toContain('devicePixelRatio');
    expect(portal).toContain('chartRegistry');
    expect(portal).toMatch(/addEventListener\('resize'/);
  });
});
