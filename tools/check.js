#!/usr/bin/env node
/**
 * check.js: project validator for this no-build static site.
 * Run before every push and in CI (see .github/workflows/ci.yml).
 *
 *   node tools/check.js
 *
 * Checks, each fatal on failure:
 *   1. JS syntax of every app/*.js, app/locales/*.js and tools/*.js
 *   2. i18n coverage and usage (delegates to tools/i18n-check.js)
 *   3. Every local asset referenced by the HTML pages resolves on disk
 *      (catches a renamed/moved file whose ?v= reference was not updated)
 *   4. Every manifest icon file exists
 *   5. JSON validity of manifest + locale registry shape
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
let errors = 0;
const fail = (m) => { console.error('FAIL: ' + m); errors++; };
const ok = (m) => console.log('OK  : ' + m);

// 1. JS syntax
function jsFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}
let syntaxBad = 0;
for (const f of [...jsFiles(path.join(ROOT, 'app')), ...jsFiles(path.join(ROOT, 'tools'))]) {
  try {
    cp.execSync(`node --check ${JSON.stringify(f)}`, { stdio: 'pipe' });
  } catch (e) {
    fail('JS syntax: ' + path.relative(ROOT, f) + '\n' + (e.stderr || e.stdout || '').toString().split('\n').slice(0, 3).join('\n'));
    syntaxBad++;
  }
}
if (!syntaxBad) ok(`JS syntax (${[...jsFiles(path.join(ROOT, 'app')), ...jsFiles(path.join(ROOT, 'tools'))].length} files)`);

// 2. i18n
try {
  cp.execSync(`node ${JSON.stringify(path.join(ROOT, 'tools', 'i18n-check.js'))}`, { stdio: 'pipe' });
  ok('i18n coverage');
} catch (e) {
  fail('i18n-check:\n' + (e.stdout || e.stderr || '').toString());
}

// 3. Local asset references resolve
function checkHtmlAssets(htmlRelPath) {
  const htmlPath = path.join(ROOT, htmlRelPath);
  if (!fs.existsSync(htmlPath)) { fail('missing HTML: ' + htmlRelPath); return; }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const htmlDir = path.dirname(htmlPath);
  const refs = new Set();
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]+)"/g)) refs.add(m[1]);
  let bad = 0;
  for (let ref of refs) {
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('mailto:') || ref.startsWith('#')) continue;
    const clean = ref.split('?')[0].split('#')[0];
    if (!clean) continue;
    const resolved = clean.startsWith('/') ? path.join(ROOT, clean) : path.join(htmlDir, clean);
    if (!fs.existsSync(resolved)) { fail(`${htmlRelPath}: dead asset reference "${ref}"`); bad++; }
  }
  if (!bad) ok(`asset references in ${htmlRelPath} (${refs.size} refs)`);
}
checkHtmlAssets('app/index.html');
checkHtmlAssets('index.html');
checkHtmlAssets('fr/index.html');
checkHtmlAssets('legal/terms.html');
checkHtmlAssets('legal/privacy.html');

// 4. Manifest icons + JSON validity
try {
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'manifest.webmanifest'), 'utf8'));
  let bad = 0;
  for (const icon of mf.icons || []) {
    const p = icon.src.startsWith('/') ? path.join(ROOT, icon.src) : path.join(ROOT, 'app', icon.src);
    if (!fs.existsSync(p)) { fail('manifest icon missing: ' + icon.src); bad++; }
  }
  if (!bad) ok(`manifest icons (${(mf.icons || []).length})`);
} catch (e) {
  fail('manifest.webmanifest invalid JSON: ' + e.message);
}

// 5. Locale registry shape
try {
  const w = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'app', 'locales', 'index.js'), 'utf8'))(w);
  const reg = w.GMT_LANGUAGES || [];
  if (!Array.isArray(reg) || !reg.length) fail('locale registry empty');
  else if (!reg.every((l) => l.code && l.intl)) fail('locale registry entry missing code/intl');
  else ok(`locale registry (${reg.map((l) => l.code).join(', ')})`);
} catch (e) {
  fail('locale registry load: ' + e.message);
}

console.log(`\n${errors} error(s).`);
process.exit(errors ? 1 : 0);
