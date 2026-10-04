/**
 * tests/csp_strict.test.js
 *
 * The CSP allows no inline style (2026-10-04). A style="..." attribute, a
 * <style> element or setAttribute('style', ...) would be refused by the
 * browser -- silently: the element renders unstyled. These guard the absence
 * across everything the site serves; e2e/fixtures.js fails any e2e test on a
 * violation the browser actually reports, under the real headers.
 *
 * Static styles are u-* classes (utilities.css, legal.css for the legal pages);
 * computed ones go through styleRef() (src/core/dom/style-refs.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (d, ext, out = []) => {
  for (const e of fs.readdirSync(path.join(root, d))) {
    const p = path.join(d, e);
    if (fs.statSync(path.join(root, p)).isDirectory()) walk(p, ext, out);
    else if (ext.test(p)) out.push(p);
  }
  return out;
};
const stripJsComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripHtmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '');

describe('the Content-Security-Policy', () => {
  const csp = JSON.parse(read('vercel.json'))
    .headers.flatMap((r) => r.headers)
    .find((h) => h.key === 'Content-Security-Policy').value;
  const directive = (name) =>
    csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith(name + ' ')) || '';

  it('allows no inline style or script, and no eval', () => {
    expect(directive('style-src')).toBe("style-src 'self'");
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });
});

describe('nothing the site serves carries an inline style', () => {
  const html = ['index.html', 'terms.html', 'privacy.html', ...walk('src', /\.html$/)];
  const code = walk('src', /\.(ts|js)$/).filter((f) => !f.endsWith(path.join('core', 'dom', 'style-refs.ts')));

  it('has no style attribute or <style> element in any page or fragment', () => {
    const offenders = html.filter((f) => /\sstyle\s*=|<style[\s>]/i.test(stripHtmlComments(read(f))));
    expect(html.length).toBeGreaterThan(4);
    expect(offenders).toEqual([]);
  });

  it('builds no markup with a style attribute, and sets none', () => {
    const offenders = code.filter((f) => {
      const t = stripJsComments(read(f));
      return (
        /(?<![\w-])style=\\?["'`]/.test(t) ||
        /setAttribute\(\s*['"`]style['"`]/.test(t) ||
        /createElement\(\s*['"`]style['"`]/.test(t)
      );
    });
    expect(code.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it('starts the style-reference observer before the app renders', () => {
    const main = read('src/main.ts');
    expect(main).toContain("import { startStyleRefs } from './core/dom/style-refs';");
    expect(main.indexOf('startStyleRefs();')).toBeLessThan(
      main.indexOf("document.addEventListener('DOMContentLoaded'")
    );
  });
});
