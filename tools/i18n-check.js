#!/usr/bin/env node
/**
 * i18n-check. Validates locale files against the English reference and
 * against actual key usage in the app (saas_strategy.md §7.3).
 *
 * Usage: node tools/i18n-check.js
 *
 * Errors (exit 1):
 *   - a key used in app/index.html or via t('…') has no English entry
 *   - a locale declared in locales/index.js has no locale file
 * Warnings (exit 0):
 *   - keys missing in a non-English locale (they fall back to English)
 *   - English keys that appear unused (heuristic: literal usages only)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app');
const LOCALES_DIR = path.join(APP, 'locales');

function loadBrowserScript(file, windowStub) {
  const src = fs.readFileSync(file, 'utf8');
  const fn = new Function('window', 'navigator', 'document', 'localStorage', src);
  fn(windowStub,
     { languages: ['en'], language: 'en' },
     { documentElement: {}, querySelectorAll: () => [], addEventListener: () => {}, head: { appendChild: () => {} }, readyState: 'complete', createElement: () => ({}) , dispatchEvent: () => {} },
     { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  return windowStub;
}

const w = { };
loadBrowserScript(path.join(LOCALES_DIR, 'index.js'), w);
const registry = w.GMT_LANGUAGES || [];
if (!registry.length) { console.error('ERROR: empty language registry'); process.exit(1); }

let errors = 0, warnings = 0;

// Load every declared locale.
for (const lang of registry) {
  const file = path.join(LOCALES_DIR, lang.code + '.js');
  if (!fs.existsSync(file)) { console.error(`ERROR: locale file missing for "${lang.code}" (${file})`); errors++; continue; }
  loadBrowserScript(file, w);
}
const locales = w.GMT_LOCALES || {};
const en = locales.en;
if (!en) { console.error('ERROR: English reference locale failed to load'); process.exit(1); }
const enKeys = new Set(Object.keys(en));
console.log(`Reference locale: en (${enKeys.size} keys)`);

// Locale coverage vs en.
for (const lang of registry) {
  if (lang.code === 'en' || !locales[lang.code]) continue;
  const keys = new Set(Object.keys(locales[lang.code]));
  const missing = [...enKeys].filter(k => !keys.has(k));
  const extra = [...keys].filter(k => !enKeys.has(k));
  if (missing.length) { console.warn(`WARN [${lang.code}]: ${missing.length} untranslated key(s) (fallback to en): ${missing.join(', ')}`); warnings++; }
  if (extra.length)   { console.warn(`WARN [${lang.code}]: ${extra.length} key(s) absent from en (dead?): ${extra.join(', ')}`); warnings++; }
  if (!missing.length && !extra.length) console.log(`OK   [${lang.code}]: full coverage (${keys.size} keys)`);
}

// Keys used in HTML.
const usedKeys = new Set();
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
for (const m of html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)) usedKeys.add(m[1]);

// Literal t('…') / tn('…') usages in JS modules.
for (const f of fs.readdirSync(APP).filter(f => f.endsWith('.js') && f !== 'i18n.js')) {
  const src = fs.readFileSync(path.join(APP, f), 'utf8');
  for (const m of src.matchAll(/\bt(?:n)?\(\s*'([a-z0-9_]+)'/g)) usedKeys.add(m[1]);
}

const undefinedKeys = [...usedKeys].filter(k => !enKeys.has(k));
if (undefinedKeys.length) {
  console.error(`ERROR: ${undefinedKeys.length} used key(s) missing from en: ${undefinedKeys.join(', ')}`);
  errors++;
}

const unused = [...enKeys].filter(k => !usedKeys.has(k));
if (unused.length) { console.warn(`WARN: ${unused.length} en key(s) not detected in literal usage (dynamic keys are invisible to this check): ${unused.slice(0, 20).join(', ')}${unused.length > 20 ? '…' : ''}`); warnings++; }

console.log(`\n${errors} error(s), ${warnings} warning(s).`);
process.exit(errors ? 1 : 0);
