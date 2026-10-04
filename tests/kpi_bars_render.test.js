/**
 * The Guild Cockpit shipped with every one of its bars invisible.
 *
 * `.gm-kpi-bar` sets `height: 100%` and `.gm-kpi-bar-track` sets `height: 12px`
 * and `flex: 1`. None of that applies to a non-replaced INLINE element, and
 * both classes were written onto `<span>` when the tab was rebuilt. The tracks
 * inherited a height from the flex row and stayed visible; the coloured fill
 * inside them had no box at all. Engagement, weekly attendance, power
 * progression, power tiers and roles all rendered as empty grey rails.
 *
 * It type-checked, every unit test passed and all 38 e2e specs were green,
 * because nothing here has layout: jsdom does not compute it and no assertion
 * looked at the element type. Only the screenshot showed it.
 *
 * Two independent guards, because either alone can be worked around by
 * accident: the CSS must not depend on the element, and the markup must not
 * depend on the CSS being forgiving.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const css = read('components.css');
const statsView = stripComments(read('src/modules/stats/views/StatsView.ts'));

/** The body of one CSS rule, comments removed. */
function ruleBody(selector) {
  const re = new RegExp('(^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'm');
  const m = re.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  return m ? m[2] : null;
}

describe('a bar that sets a height must not be left inline', () => {
  for (const selector of ['.gm-kpi-bar', '.gm-kpi-bar-track']) {
    it(`${selector} declares its own display`, () => {
      const body = ruleBody(selector);
      expect(body, `${selector} is missing from components.css`).toBeTruthy();
      // It sets height (and the track sets flex), so it cannot be inline.
      expect(body).toMatch(/height\s*:/);
      expect(body, `${selector} sets a height but never declares display, so a <span> renders nothing`).toMatch(
        /display\s*:\s*(block|flex|inline-block)/
      );
    });
  }
});

describe('the Stats bars are block elements in the markup too', () => {
  it('never puts a bar class on a span', () => {
    expect(statsView).not.toMatch(/<span class="gm-kpi-bar/);
    expect(statsView).not.toMatch(/<span class="gm-kpi-bar-track/);
  });

  it('builds them as divs, like the rest of the codebase', () => {
    expect(statsView).toContain('<div class="gm-kpi-bar-track"><div class="gm-kpi-bar"');
  });

  it('gives every bar a width, or it has nothing to show', () => {
    // The width is computed, so it goes through styleRef() (no inline style
    // attribute under the CSP): the reference must carry a width.
    const bars = statsView.match(/<div class="gm-kpi-bar" data-gm-style="' \+\s*styleRef\(([^)]*)\)/g) || [];
    expect(bars.length).toBeGreaterThan(3);
    for (const bar of bars) {
      expect(bar, `a bar with no width: ${bar}`).toMatch(/width:/);
    }
  });
});

describe('labels fit the column they are given', () => {
  it('keeps them shorter than the ellipsising .gm-kpi-label', () => {
    // .gm-kpi-label is a fixed 96px column with text-overflow: ellipsis, so
    // "Occasional (under 30%)" rendered as "Occasional (u...". The thresholds
    // belong in the card subtitle, where there is room.
    const body = ruleBody('.gm-kpi-label');
    expect(body).toMatch(/text-overflow\s*:\s*ellipsis/);

    const labels = (statsView.match(/\['(core|regular|occasional|dormant|unmeasured)', '([^']+)'/g) || []).map((m) =>
      m.split("', '")[1].replace(/'$/, '')
    );
    expect(labels.length).toBe(5);
    for (const label of labels) {
      expect(label.length, `"${label}" will be ellipsised in a 96px column`).toBeLessThanOrEqual(12);
    }
  });
});
