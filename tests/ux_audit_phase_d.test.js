// Regression guard for Phase D of the UX audit roadmap: responsive matchup
// tables, the Leader Hall breakpoint aligned to the shell's 900px mobile
// cutoff, the nav reorganization (Leader Hall -> play, Donate -> footer),
// legacy button/modal class unification, and — most importantly — the
// /src main.ts bug this phase surfaced: window.GM_SVS_MATCHUP/GM_GVG_MATCHUP
// were being silently overwritten by non-functional 50-line stubs the
// moment the build-pipeline fix (2026-08-30) let /src/main.ts actually run
// in production, completely hiding the real, working matchup tool.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('SvS/GvG matchup tables are responsive (gm-resp-table + data-label)', () => {
  const svsJs = read('svs-matchup.js');
  const gvgJs = read('gvg-matchup.js');

  it('all 3 svs-matchup.js tables (2 side-by-side + 1 combined) use gm-resp-table', () => {
    const count = (svsJs.match(/class="gm-table gm-resp-table"/g) || []).length;
    expect(count).toBe(3);
  });

  it('all 3 gvg-matchup.js tables use gm-resp-table', () => {
    const count = (gvgJs.match(/class="gm-table gm-resp-table"/g) || []).length;
    expect(count).toBe(3);
  });

  it('renderRosterRows/renderPlayerRows and renderCombinedRows tag every non-rank cell with data-label', () => {
    ['svs-matchup.js', 'gvg-matchup.js'].forEach((file) => {
      const content = read(file);
      expect(content).toContain('data-label="Member"');
      expect(content).toContain('data-label="Power"');
      expect(content).toContain('data-label="Guild"');
    });
  });
});

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
  const shellJs = read('shell.js');

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
    expect(shellJs).toContain("var footerItems = visible.filter(function (i) { return i.section === 'footer'; });");
    expect(shellJs).toContain('footerItems.map(function (item)');
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

describe('CRITICAL: src/main.ts no longer shadows the real SvS/GvG matchup tool with non-functional stubs', () => {
  const mainTs = read('src/main.ts');

  it('does not bridge window.GM_SVS_MATCHUP / GM_GVG_MATCHUP to the incomplete /src stubs', () => {
    // Found during Phase D live verification: as of the 2026-08-30 build-pipeline
    // fix, src/main.ts actually executes in production for the first time, and
    // was silently overwriting the legacy svs-matchup.js/gvg-matchup.js's
    // window.GM_SVS_MATCHUP/GM_GVG_MATCHUP (728/697-line complete
    // implementations) with svs-matchup.ts/gvg-matchup.ts — 50-line stubs that
    // call a hardcoded RPC (fixed server numbers '1001'/'1002') and never
    // render an actual table, even on success. Both write into the same
    // #svs-matchup-container / #gvg-matchup-container, so whichever ran last
    // won — and since /src is a deferred module, that was always the stub.
    expect(mainTs).not.toContain('(window as any).GM_SVS_MATCHUP = SvSMatchupView;');
    expect(mainTs).not.toContain('(window as any).GM_GVG_MATCHUP = GvGMatchupView;');
  });

  it('still bridges GM_CROSSRANK (a substantially complete 431-line port, unaffected by this bug)', () => {
    expect(mainTs).toContain('(window as any).GM_CROSSRANK = CrossRankView;');
  });

  it('the stub files were removed entirely (tech-debt cleanup) rather than kept unfinished', () => {
    // Sitting unbridged "for future use" for multiple sessions without ever
    // being finished was itself the risk this locks in: an accidental future
    // re-bridge (e.g. a careless refactor restoring the old
    // window.GM_SVS_MATCHUP = SvSMatchupView; line) would silently
    // reintroduce the exact regression the first assertion guards against.
    // Removing the source is a stronger guarantee than "don't bridge it".
    expect(mainTs).not.toContain('SvSMatchupView');
    expect(mainTs).not.toContain('GvGMatchupView');
    expect(fs.existsSync(path.resolve(root, 'src/modules/matchup/svs-matchup.ts'))).toBe(false);
    expect(fs.existsSync(path.resolve(root, 'src/modules/matchup/gvg-matchup.ts'))).toBe(false);
  });
});
