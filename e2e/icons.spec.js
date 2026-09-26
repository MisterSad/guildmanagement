import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Phosphor icon font is SUBSET at build time (scripts/build.js): the package
// ships 1,530 glyphs and this app draws 171, so 128 kB of woff2 used to be
// downloaded by every first-time visitor to render nothing.
//
// Subsetting is only safe while the build's static scan sees every icon the app
// can draw. This spec is the guarantee: it rebuilds nothing and invents nothing,
// it renders every icon name found in the source against the REAL bundle and
// fails if any measures zero width -- which is exactly how a missing glyph
// presents. A `'ph-' + variable` added anywhere, or an icon name served from the
// database, would break subsetting silently and be caught here.

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function usedIconNames() {
  const css = fs.readFileSync(
    path.join(rootDir, 'node_modules/@phosphor-icons/web/src/regular/style.css'),
    'utf8'
  );
  const known = new Set();
  for (const m of css.matchAll(/\.ph\.(ph-[a-z0-9-]+):before/g)) known.add(m[1]);

  const roots = ['src', 'index.html', 'components.css', 'styles.css', 'shell.css'];
  const used = new Set();
  for (const r of roots) {
    const abs = path.join(rootDir, r);
    if (!fs.existsSync(abs)) continue;
    const files = fs.statSync(abs).isDirectory() ? walk(abs) : [abs];
    for (const f of files) {
      if (!/\.(ts|js|html|css)$/.test(f)) continue;
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bph-[a-z0-9-]+/g)) {
        if (known.has(m[0])) used.add(m[0]);
      }
    }
  }
  return [...used].sort();
}

test('every icon the app can draw survives the font subset', async ({ page }) => {
  const names = usedIconNames();
  expect(names.length, 'the scan must find icons at all').toBeGreaterThan(100);

  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);

  const result = await page.evaluate(async (iconNames) => {
    await document.fonts.ready;

    // A glyph that is NOT in the font does not render as zero width -- it
    // renders as the font's .notdef box, which has a perfectly normal advance.
    // Measuring width therefore proves nothing (it passed against a font with a
    // glyph deliberately removed). Rasterising does: every missing codepoint
    // draws the same .notdef, so comparing against a codepoint known to be
    // absent identifies them exactly.
    const raster = (ch) => {
      const c = document.createElement('canvas');
      c.width = c.height = 48;
      const x = c.getContext('2d');
      x.font = '32px Phosphor';
      x.textBaseline = 'top';
      x.fillText(ch, 4, 4);
      return c.toDataURL();
    };

    const charFor = (name) => {
      const i = document.createElement('i');
      i.className = 'ph ' + name;
      document.body.appendChild(i);
      const content = getComputedStyle(i, '::before').content;
      i.remove();
      const m = content.match(/"(.*)"/);
      return m ? m[1] : null;
    };

    // `ph-acorn` (U+EB9A) is in the package but this app never draws it, so it
    // is never subset in -- the reference for "what a missing glyph looks like".
    const notdef = raster(String.fromCodePoint(0xeb9a));
    const blank = [];
    const noContent = [];

    for (const n of iconNames) {
      const ch = charFor(n);
      if (!ch) { noContent.push(n); continue; }
      if (raster(ch) === notdef) blank.push(n);
    }
    return { blank, noContent, notdefIsDistinct: notdef !== raster('\u0041') };
  }, names);

  expect(result.noContent, `icons with no CSS content rule: ${result.noContent.join(', ')}`).toEqual([]);

  expect(result.blank, `icons missing from the subset font: ${result.blank.join(', ')}`).toEqual([]);
});

test('the unshipped Phosphor weights are not used in markup', async () => {
  // `.ph.ph-warning:before` requires BOTH classes, and only the regular weight
  // is imported -- so `class="ph-fill ph-warning"` matched no glyph rule at all
  // and rendered nothing. 42 such usages existed across 10 files, in toasts,
  // confirm dialogs, UID warnings and Arms Race chips.
  const offenders = [];
  for (const f of walk(path.join(rootDir, 'src'))) {
    if (!/\.ts$/.test(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (/\bph-(fill|bold|thin|light|duotone)\b/.test(src)) {
      offenders.push(path.relative(rootDir, f));
    }
  }
  expect(offenders, `weights that are never loaded: ${offenders.join(', ')}`).toEqual([]);
});
