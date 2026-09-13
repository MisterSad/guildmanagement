// Regression guard for Phase D of the UX audit roadmap: the Leader Hall
// breakpoint aligned to the shell's 900px mobile cutoff, the nav reorganization
// (Leader Hall -> play, Donate -> footer), and legacy button/modal class
// unification.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Leader Hall mobile breakpoint aligned to the shell (900px, was 768px)', () => {
  const stylesCss = read('styles.css');
  const leaderHallJs = read('gm-leader-hall.js');

  it('the .gm-leader-hall-layout and .gm-chat-back-btn media queries use 900px', () => {
    const layoutIdx = stylesCss.indexOf('.gm-leader-hall-layout {\n        display: flex !important;');
    expect(layoutIdx).toBeGreaterThan(-1);
    expect(stylesCss.slice(Math.max(0, layoutIdx - 200), layoutIdx)).toContain('@media (max-width: 900px)');

    const backBtnIdx = stylesCss.indexOf('.gm-chat-back-btn {\n        display: inline-flex !important;');
    expect(backBtnIdx).toBeGreaterThan(-1);
    expect(stylesCss.slice(Math.max(0, backBtnIdx - 200), backBtnIdx)).toContain('@media (max-width: 900px)');
  });

  it('the other 4 unrelated 768px blocks in styles.css were left untouched', () => {
    const count = (stylesCss.match(/@media \(max-width: 768px\)/g) || []).length;
    expect(count).toBe(4);
  });

  it('gm-leader-hall.js mobile-detection checks use 900px, matching shell.js BREAKPOINT_MOBILE', () => {
    expect(leaderHallJs).not.toContain('window.innerWidth <= 768');
    expect((leaderHallJs.match(/window\.innerWidth <= 900/g) || []).length).toBe(2);
  });
});

describe('Nav reorganization: Leader Hall -> play, Donate -> footer', () => {
  const shellJs = read('src/modules/shell/views/ShellView.ts');

  it('leader-hall item is in the play section', () => {
    const idx = shellJs.indexOf("id: 'leader-hall'");
    const itemLine = shellJs.slice(idx, shellJs.indexOf('\n', idx));
    expect(itemLine).toContain("section: 'play'");
  });

  it('subscription (donate) item is in its own footer section, not admin', () => {
    const idx = shellJs.indexOf("id: 'subscription'");
    const itemLine = shellJs.slice(idx, shellJs.indexOf('\n', idx));
    expect(itemLine).toContain("section: 'footer'");
    expect(itemLine).not.toContain("section: 'admin'");
  });

  it('renderSidebar renders footer-section items as a lightweight link near the legal footer', () => {
    expect(shellJs).toContain("const footerItems = visible.filter((i) => i.section === 'footer');");
    expect(shellJs).toContain('footerItems.map((item) =>');
  });
});

describe('Legacy button/modal classes unified to the gm-btn / gm-modal-* system', () => {
  const files = ['app.js', 'gm-utils.js', 'history.js', 'overview.js', 'index.html'];

  it('no file constructs a .confirm-overlay or .confirm-card element anymore', () => {
    files.forEach((f) => {
      const content = read(f);
      expect(content).not.toMatch(/className\s*=\s*['"]confirm-overlay['"]/);
      expect(content).not.toMatch(/class=["']confirm-overlay/);
      expect(content).not.toMatch(/class=["']confirm-card/);
    });
  });

  it('no file uses the legacy .primary-btn/.btn-ghost/.btn-danger button classes anymore', () => {
    files.forEach((f) => {
      const content = read(f);
      expect(content).not.toMatch(/class=["']primary-btn["']/);
      expect(content).not.toMatch(/class=["']btn-ghost["']/);
      expect(content).not.toMatch(/class=["']btn-danger["']/);
    });
  });

  it('the OCR modal (index.html, previously mismatched confirm-overlay wrapping a gm-modal-card) now uses gm-modal-overlay throughout', () => {
    const html = read('index.html');
    expect(html).toContain('id="ocr-modal-overlay" class="gm-modal-overlay"');
  });
});

describe('CSS dead-code removal: unreachable light theme + superseded leaderboard-table styles', () => {
  it('tokens.css no longer defines [data-theme="light"] (confirmed unreachable: no JS ever sets data-theme)', () => {
    const tokens = read('tokens.css');
    expect(tokens).not.toContain('[data-theme="light"]');
  });

  it('styles.css no longer defines the old .leaderboard-table family, superseded by gm-table/gm-resp-table', () => {
    const styles = read('styles.css');
    ['.leaderboard-table', '.leaderboard-wrap', '.rank-cell', '.week-cell', '.score-badge', '.profile-btn']
      .forEach((sel) => expect(styles).not.toContain(sel));
  });
});
