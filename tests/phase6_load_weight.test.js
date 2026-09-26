// Phase 6 — load weight and performance.
//
// Most of the audit's phase-6 list was already done by earlier work, and
// measurement contradicted two of the remaining items. What this file pins is
// the work that was actually needed, plus the findings that turned out to be
// wrong, so neither gets re-litigated.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) =>
  s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

describe('the icon weights the app never loads are not used', () => {
  it('has no markup on an unimported Phosphor weight', () => {
    // Phosphor scopes every glyph as `.ph.ph-name:before`, so an element with
    // `class="ph-fill ph-warning"` matched NO rule: computed content `none`,
    // rendered width 0. Only `@phosphor-icons/web/regular` is imported, so the
    // fill/bold families never existed either way. 42 usages across 10 files --
    // toasts, confirm dialogs, UID warnings, Arms Race chips -- drew nothing.
    const offenders = [];
    for (const f of walk('src')) {
      if (!f.endsWith('.ts')) continue;
      if (/\bph-(fill|bold|thin|light|duotone)\b/.test(stripComments(read(f)))) offenders.push(f);
    }
    expect(offenders, `unimported weights: ${offenders.join(', ')}`).toEqual([]);
  });

  it('imports exactly one Phosphor weight', () => {
    const main = read('src/main.ts');
    expect(main).toContain("import '@phosphor-icons/web/regular'");
    expect(stripComments(main)).not.toMatch(/@phosphor-icons\/web\/(fill|bold|thin|light|duotone)/);
  });

  it('keeps the CSS rules that styled the dead class pointed at the live one', () => {
    // `.gm-ui-dialog-heading > i.ph-fill` and `.gm-tab-pill.gm-active .ph-fill`
    // targeted ONLY the dead weight, so changing the markup without them would
    // have silently dropped their colour and size.
    expect(read('styles.css')).toContain('.gm-ui-dialog-heading > i.ph {');
    expect(read('components.css')).toContain('.gm-tab-pill.gm-active .ph {');
  });
});

describe('the icon font ships only the glyphs the app draws', () => {
  const build = read('scripts/build.js');

  it('subsets at build time from a scan of the source', () => {
    expect(build).toContain('subset-font');
    expect(build).toContain('codepointByName');
  });

  it('refuses to subset down to nothing, or to no-op silently', () => {
    // Both failure modes are silent otherwise: an empty scan would ship a font
    // with no icons, and a missing asset would leave the full font in place
    // while the log claimed success.
    expect(build).toContain('refusing to subset the font down to nothing');
    expect(build).toContain('the icon font step would silently do nothing');
  });

  it('re-hashes the subset so the URL changes when the glyph set does', () => {
    // Vite hashes the asset from the FULL font, so overwriting in place kept one
    // URL forever: adding an icon and deploying would leave returning visitors
    // on their cached copy with the new icon drawn as a blank box.
    expect(build).toContain("crypto.createHash('sha256').update(subset)");
    expect(build).toContain('the subset font would be unreachable');
  });

  it('states where the no-missing-glyph guarantee is actually enforced', () => {
    // Reading the cmap back here would only prove the subsetter did as told.
    expect(build).toContain('e2e/icons.spec.js');
    expect(fs.existsSync(path.join(rootDir, 'e2e/icons.spec.js'))).toBe(true);
  });

  it('detects a missing glyph by rasterising, not by measuring width', () => {
    // A glyph absent from a font renders as .notdef, which has a perfectly
    // normal advance -- a width check passed against a font with a glyph
    // deliberately removed, so it proved nothing.
    const spec = read('e2e/icons.spec.js');
    expect(spec).toContain('toDataURL');
    expect(spec).toContain('0xeb9a');
    expect(spec).toContain('renders as the font');
  });
});

describe('fonts are not requested in weights nothing uses', () => {
  it('no longer asks Google for Inter 300', () => {
    for (const f of ['index.html', 'terms.html']) {
      expect(read(f), f).toContain('family=Inter:wght@400;500;600;700');
      expect(read(f), f).not.toContain('family=Inter:wght@300');
    }
  });

  it('never declares font-weight 300 anywhere', () => {
    const offenders = [];
    for (const f of [...walk('src'), 'index.html', 'styles.css', 'components.css', 'shell.css', 'tokens.css', 'theme.css']) {
      if (!/\.(ts|css|html)$/.test(f)) continue;
      if (/font-weight:\s*300/.test(read(f))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('a member row comes back from the database, not from the browser', () => {
  it('selects the inserted row instead of inventing created_at', () => {
    const ctrl = read('src/modules/app/members/members.controller.ts');
    expect(ctrl).toContain(".insert([newMemberRow]).select()");
    expect(stripComments(ctrl)).not.toContain('newMemberRow.created_at = new Date().toISOString()');
    expect(ctrl).toContain('pushGuildMember(storedRow || newMemberRow)');
  });
});

describe('phase-6 findings that measurement contradicted', () => {
  it('NOT A DEFECT: the four font formats are already trimmed to woff2', () => {
    // The audit projected ~7.17 MB of woff/ttf/svg in dist. A Vite plugin has
    // been rewriting the @font-face to woff2 alone, and flipping font-display
    // from `block` to `swap`, for some time.
    const vite = read('vite.config.ts');
    expect(vite).toContain('phosphorFontTrimPlugin');
    expect(vite).toContain("format(\"woff2\")");
    expect(vite).toContain('font-display: swap;');
  });

  it('NOT A DEFECT: the duotone and Material Symbols icon sets are already gone', () => {
    // ~120 icon replacements the plan budgeted for had already been made.
    const all = [...walk('src'), 'index.html'].filter((f) => /\.(ts|html)$/.test(f));
    const offenders = all.filter((f) => /material-symbols|material-icons|ph-duotone/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('NOT A DEFECT: views are torn down on tab switch', () => {
    // Reported as "seven views define destroy(), zero call sites". The router
    // has a teardown map, guards alias switches, and documents the two views
    // deliberately excluded.
    const router = read('src/modules/app/router.ts');
    expect(router).toContain('TEARDOWN_BY_TAB');
    expect(router).toContain('ns.destroy()');
  });

  it('NOT A DEFECT: writes invalidate the derived views centrally', () => {
    // Reported as "47 mutation sites, none invalidate". Invalidation moved into
    // the write guard, which cannot be bypassed, rather than into each site.
    const guard = read('src/core/api/db-guard.ts');
    const cache = read('src/core/cache/cache.ts');
    expect(guard).toContain('invalidateGuildViews(currentG)');
    expect(cache).toContain("['stats:' + guild, 'history:' + guild]");
  });

  it('NOT A DEFECT: the OCR validation loop is already batched', () => {
    const ocr = read('src/modules/app/ocr/ocr.controller.ts');
    expect(ocr).toContain("from('banned_players').select('uid').in('uid', targetUids)");
    expect(ocr).toContain('runInChunks(targetUids, 10');
  });
});
