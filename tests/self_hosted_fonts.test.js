// Phase 6 (audit FE-21, SEC-10): no page asks Google for a font. Every view used
// to send the visitor's IP address to fonts.googleapis.com and fonts.gstatic.com,
// which the privacy policy did not disclose and the CSP had to allow.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('self-hosted fonts', () => {
  it('no page links Google Fonts, every page links fonts.css', () => {
    for (const page of ['index.html', 'privacy.html', 'terms.html']) {
      const html = read(page);
      expect(html, page).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
      expect(html, page).toContain('<link rel="stylesheet" href="fonts.css">');
    }
  });

  it('the CSP no longer allows Google Fonts', () => {
    const csp = read('vercel.json');
    expect(csp).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(csp).toContain("font-src 'self' data:;");
    expect(csp).toContain("style-src 'self' 'unsafe-inline';");
  });

  it('every face in fonts.css points at a woff2 that exists, under the OFL', () => {
    const css = read('fonts.css');
    const urls = [...css.matchAll(/url\('(fonts\/[^']+\.woff2)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBe(6);
    for (const u of urls) expect(fs.existsSync(path.join(root, u)), u).toBe(true);
    for (const fam of ['Inter', 'Plus Jakarta Sans', 'JetBrains Mono']) {
      expect(css).toContain(`font-family: '${fam}';`);
    }
    expect(read('fonts/OFL.txt')).toContain('SIL Open Font License');
  });

  it('the build ships fonts/ next to the legal pages', () => {
    expect(read('scripts/build.js')).toContain("const fontsDst = path.join(distDir, 'fonts');");
  });
});
