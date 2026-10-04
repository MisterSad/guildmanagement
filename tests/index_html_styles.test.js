/**
 * tests/index_html_styles.test.js
 *
 * index.html carries no inline styles (M5): its 403 style= attributes became
 * the u-* classes of utilities.css. These guard the absence and keep the two
 * files in step -- a u-* class with no rule renders unstyled, silently. That
 * the move changed nothing on screen was proven once, by a computed-style and
 * layout diff of all 1,380 elements in Chromium; the e2e suite runs the page.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
const css = read('utilities.css');

const used = new Set([...html.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c.startsWith('u-')));
const defined = new Set([...css.matchAll(/^(?::where\()?\.(u-[A-Za-z0-9_-]+)\)?\s*\{/gm)].map((m) => m[1]));

describe('index.html styles', () => {
  it('has no inline style attribute', () => {
    expect(html.match(/\sstyle\s*=/g)).toBeNull();
  });

  it('uses only utilities that utilities.css defines', () => {
    expect(used.size).toBeGreaterThan(100);
    expect([...used].filter((c) => !defined.has(c))).toEqual([]);
  });

  it('loads utilities.css after every other stylesheet, so its rules win ties', () => {
    const main = read('src/main.ts');
    const imports = [...main.matchAll(/^import '([^']+\.css|@phosphor-icons[^']*)';/gm)].map((m) => m[1]);
    expect(imports[imports.length - 1]).toBe('../utilities.css');
  });

  it('marks important only the properties the code never writes through element.style', () => {
    // An inline write (el.style.display = 'flex') must keep beating the class,
    // as it beat the attribute the class replaced.
    for (const prop of ['display', 'color', 'background', 'border-color', 'position', 'z-index', 'top', 'left', 'height', 'transition']) {
      expect(css, prop).not.toMatch(new RegExp(`\\{ ${prop}: [^;]*!important`));
    }
  });
});
