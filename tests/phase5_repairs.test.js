// Phase 5 — repairs, and single sources of truth.
//
// Several of the audit's phase-5 findings turned out not to be defects. Those
// are asserted here too, with the evidence, so the next reader does not "fix"
// working code to match a misreading.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_EVENT_COEFFS,
  EVENT_COEFF_CONFIG_KEYS,
  defaultCoeffConfigEntries,
} from '../src/core/config/event-coeffs.ts';
import { LOCAL_CONFIG_FALLBACK } from '../src/core/config/guild-config.ts';
import { categoriseHistory, SHADOWFRONT_COMMANDERS_MAX } from '../src/modules/shadowfront/shadowfront.service.ts';
import { EN } from '../src/core/i18n/i18n.dictionary.ts';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');

// Absence assertions must look at the code, not at the prose explaining it.
// Both the HTML comment and the CSS comment added by this phase name the very
// things being asserted absent -- `<script>` and the removed model slugs.
const stripComments = (s) =>
  s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('H3 — terms.html is a self-contained legal page again', () => {
  const terms = read('terms.html');

  it('requests no stylesheet the build never ships', () => {
    // styles.css, tokens.css, components.css and shell.css are excluded from
    // dist/ on purpose (Vite bundles them through main.ts), so on the deployed
    // site these resolved to a non-CSS response and the browser refused them
    // for a text/plain MIME type -- four console errors per load.
    for (const css of ['styles.css', 'tokens.css', 'components.css', 'shell.css']) {
      expect(terms, `${css} must not be linked`).not.toMatch(new RegExp(`<link[^>]+href="${css.replace('.', '\\.')}`));
    }
  });

  it('is styled without the application CSS bundle, from its own stylesheet', () => {
    // The audit concluded the page was unstyled. It was not -- and that matters,
    // because the proposed fix (a second Vite entry point) would have injected
    // the whole application CSS bundle into a standalone legal page.
    //
    // Phase 8 moved those rules out of an inline <style> block and into
    // `legal.css`, because privacy.html needs exactly the same ones and 270
    // duplicated lines would have drifted. The property being asserted is
    // unchanged: the page is fully styled by something that is NOT the app
    // bundle, and that build.js actually copies into dist/.
    expect(terms).toMatch(/<link[^>]+href="legal\.css/);
    const css = read('legal.css');
    expect(css.split('\n').length).toBeGreaterThan(200);
    expect(css).toContain('.terms-doc-title');
    // Still not a Vite entry point.
    expect(terms).not.toContain('/src/main.ts');
  });

  it('loads no script at all, so the CSP cannot block one', () => {
    // `script-src 'self'` blocked the unpkg Phosphor <script>, so in production
    // every icon on this page simply did not render.
    const code = stripComments(terms);
    expect(code).not.toContain('unpkg.com');
    expect(code.match(/<script[\s>]/g) || []).toEqual([]);
  });

  it('draws its icons inline, from the real Phosphor glyphs', () => {
    // Count is a floor, not an exact number: the Terms were rewritten on
    // 2026-09-27 and the section count changed with them. Pinning an exact
    // figure only ever measures how recently someone edited the page.
    const icons = terms.match(/class="terms-icon"/g) || [];
    expect(icons.length).toBeGreaterThanOrEqual(15);
    expect(terms).toContain('viewBox="0 0 1024 1024"');
    // 1em square + currentColor is what reproduces the icon-font behaviour, so
    // no other rule in the page had to change.
    const css = read('legal.css');
    expect(css).toMatch(/\.terms-icon\s*\{[^}]*width:\s*1em/);
    expect(css).toMatch(/\.terms-icon\s*\{[^}]*fill:\s*currentColor/);
  });

  it('loads only its own two stylesheets: the self-hosted fonts, and legal.css', () => {
    // The CSP permits `style-src 'self'` only since the fonts are self-hosted
    // (audit FE-21): any third link is either a CSP violation or the app bundle
    // creeping back in.
    const links = terms.match(/<link[^>]+rel="stylesheet"[^>]*>/g) || [];
    expect(links.length).toBe(2);
    expect(
      links.some((l) => l.includes('href="fonts.css"')),
      'the font stylesheet'
    ).toBe(true);
    expect(
      links.some((l) => l.includes('legal.css')),
      'the legal stylesheet'
    ).toBe(true);
    expect(read('vercel.json')).not.toContain('fonts.googleapis.com');
  });
});

describe('B1 — one AI model list for the whole backend (ADR-024)', () => {
  const shared = read('supabase/functions/_shared/openrouter.ts');
  const callers = [
    ['ocr-guild-members', read('supabase/functions/ocr-guild-members/index.ts')],
    ['ai-vision', read('supabase/functions/_shared/ai-vision.ts')],
  ];

  it("names the owner's model first and its fallback second", () => {
    const list = shared.slice(shared.indexOf('OPENROUTER_MODELS'));
    const models = [...list.slice(0, 200).matchAll(/"(google\/[a-z0-9.-]+)"/g)].map((m) => m[1]);
    expect(models).toEqual(['google/gemini-3.8-flash', 'google/gemini-3.7-flash']);
  });

  it('leaves no caller with its own model or its own provider', () => {
    for (const [name, src] of callers) {
      expect(src, `${name} must call the shared client`).toContain('callOpenRouter');
      expect(stripComments(src), `${name} must not hardcode a model`).not.toMatch(/"google\/gemini-[a-z0-9.-]+"/);
      expect(src, `${name} must not call Google directly`).not.toContain('generativelanguage.googleapis.com');
    }
  });
});

describe('B1 — the event coefficients are declared once', () => {
  it('shapes the guild_config fallback from the typed record', () => {
    // The same five numbers used to be written twice, in two shapes. They
    // agreed, which is precisely why a divergence would have gone unnoticed.
    const entries = defaultCoeffConfigEntries();
    for (const [bucket, key] of Object.entries(EVENT_COEFF_CONFIG_KEYS)) {
      expect(entries[key], key).toBe(String(DEFAULT_EVENT_COEFFS[bucket]));
      expect(LOCAL_CONFIG_FALLBACK[key], `${key} must come from the shared source`).toBe(
        String(DEFAULT_EVENT_COEFFS[bucket])
      );
    }
  });

  it('matches what guilds actually choose, which the audit missed', () => {
    // Measured across the 15 guilds that have configured coefficients, these are
    // the majority value for every bucket: SvS 5 (14/15), GvG 5 (11/15),
    // Shadowfront 3 (14/15), DTR 2 (12/15), Arms Race 1 (13/15). The audit read
    // the DEMO seed (GvG 3, SF 2, DTR 1) as a competing specification; DEMO is
    // simply a tenant with its own settings, like BABE (GvG 3) or CLAW (GvG 4).
    expect(DEFAULT_EVENT_COEFFS).toEqual({
      SvS: 5,
      GvG: 5,
      Shadowfront: 3,
      DTR: 2,
      'Arms Race': 1,
    });
  });

  it('declares them in core, so the stats module depends on core and not the reverse', () => {
    const stats = read('src/modules/stats/stats.service.ts');
    expect(stats).toContain("from '../../core/config/event-coeffs'");
    expect(stats).not.toMatch(/export const DEFAULT_EVENT_COEFFS[^=]*=\s*\{/);
  });
});

describe('B1 — the squad limits read the same way', () => {
  it('names the commander cap instead of inlining 3', () => {
    expect(SHADOWFRONT_COMMANDERS_MAX).toBe(3);
    const view = read('src/modules/shadowfront/views/ShadowfrontView.ts');
    expect(view).toContain('currentCommanders.length >= SHADOWFRONT_COMMANDERS_MAX');
  });

  it('translates the refusal, like its two sibling limits already did', () => {
    const view = read('src/modules/shadowfront/views/ShadowfrontView.ts');
    expect(view).not.toContain('You can only have up to 3 commanders per squad!');
    expect(view).toContain("t('sf_commanders_full', { n: SHADOWFRONT_COMMANDERS_MAX })");
    expect(EN.sf_commanders_full).toContain('{n}');
  });

  it('passes replacements to t(), which the old view shim used to drop', () => {
    // M4c: the view calls the typed i18n t() directly; there is no shim left
    // to drop the replacements.
    const view = read('src/modules/shadowfront/views/ShadowfrontView.ts');
    expect(view).toMatch(/import \{[^}]*\bt\b[^}]*\} from '\.\.\/\.\.\/\.\.\/core\/i18n\/i18n'/);
    expect(view).not.toMatch(/function gm\(|const legacy = \{/);
  });

  it('NOT A DEFECT: the participant and reserve caps are enforced, not just shown', () => {
    // The audit reported these as declared-but-unenforced. ShadowfrontView
    // refuses the assignment outright, with a translated message.
    const view = read('src/modules/shadowfront/views/ShadowfrontView.ts');
    expect(view).toContain('if (existing.length >= max)');
    expect(view).toContain("t('sf_squad_full')");
  });
});

describe('B1 — NOT A DEFECT: the participation bands match their labels', () => {
  // The audit called this an off-by-one, reading "exactly 80% falls in Good" as
  // a bug. The label promises exactly that: Good is "50% - 80%".
  const band = (participated, assigned) =>
    categoriseHistory({ assigned, participated, excused_count: 0, late_count: 0, sub_present_count: 0 });

  it('puts 80% in Good and anything above it in Excellent', () => {
    expect(band(80, 100)).toBe('good');
    expect(band(81, 100)).toBe('excellent');
    expect(EN.sf_filter_good).toBe('50% - 80% (Good)');
    expect(EN.sf_filter_excellent).toBe('> 80% (Excellent)');
  });

  it('agrees with its labels at every other boundary too', () => {
    expect(band(50, 100)).toBe('good');
    expect(band(49, 100)).toBe('average');
    expect(band(20, 100)).toBe('average');
    expect(band(19, 100)).toBe('poor');
    expect(EN.sf_filter_average).toBe('20% - 50% (Average)');
    expect(EN.sf_filter_poor).toBe('< 20% (Poor)');
  });

  it('reports an unassigned player as unknown rather than poor', () => {
    expect(band(0, 0)).toBe('none');
  });
});

describe('B1 — MAX_NUMERIC is declared once', () => {
  it('no longer has a second, importer-less copy in constants.ts', () => {
    // Every consumer -- main.ts, gm-bridge.ts -- takes it from core/utils/text,
    // which is also where the only code that clamps against it lives.
    const constants = read('src/core/config/constants.ts');
    expect(constants).not.toMatch(/export const MAX_NUMERIC/);
    expect(read('src/core/utils/text.ts')).toContain('export const MAX_NUMERIC = 9999999999;');
  });
});

describe('H1 — the OCR cache the ADR promised is deployed', () => {
  it('still carries the read and write halves the deploy was missing', () => {
    // ocr_cache was empty and its indexes unused because the function was last
    // deployed ~2 days BEFORE the cache migration. Redeploying it in phase 4
    // closed this; the deployed bundle is now byte-identical to the repo.
    const ocr = read('supabase/functions/ocr-guild-members/index.ts');
    expect(ocr).toContain('OCR cache hit');
    expect(ocr).toContain('OCR result cached successfully');
    expect(ocr).toContain('computeOcrPayloadHash');
  });
});
