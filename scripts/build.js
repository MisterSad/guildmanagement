import { execSync } from 'child_process';
import { build as esbuildBuild, transform } from 'esbuild';
import fs from 'fs';
import path from 'path';

console.log('Running Vite build...');
execSync('npx vite build', { stdio: 'inherit' });

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

// Service worker: the PWA is retired, and this now compiles a SELF-DESTRUCTING
// TOMBSTONE (src/sw/service-worker.ts) whose only job is to call
// registration.unregister(). It must keep being emitted at the root of dist/ so
// the path stays `/sw.js`: a worker already installed on a member's device only
// goes away when the browser can fetch a NEW /sw.js from that exact URL and see
// it unregister itself. Dropping this block would 404 the path and leave every
// existing installation running the old push worker forever.
//
// Remove it (and src/sw/, and the dev plugin in vite.config.ts) only after a
// full release cycle has given returning devices time to pick the tombstone up.
{
  const swEntry = path.join(rootDir, 'src/sw/service-worker.ts');
  await esbuildBuild({
    entryPoints: [swEntry],
    outfile: path.join(distDir, 'sw.js'),
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    logLevel: 'warning',
  });
  console.log('Compiled service worker: src/sw/service-worker.ts -> dist/sw.js.');
}

const files = fs.readdirSync(rootDir);
// index.html is deliberately excluded: `vite build` already emitted a
// correct dist/index.html above, with /src/main.ts replaced by its bundled
// <script type="module" src="/assets/index-*.js"> tag (hoisted into <head>)
// and every legacy <script src="foo.js"> left untouched. Copying the raw
// source index.html over it here used to silently put the unbundled
// /src/main.ts reference back — the browser can't execute raw .ts syntax,
// so every /src module (including this one) has been dead code in
// production: it 404s/fails to parse and never runs a single line.
const EXCLUDED_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vercel.json',
  'vitest.config.js',
  'playwright.config.js',
  'index.html',
  'tokens.css',
  'theme.css',
  'styles.css',
  'components.css',
  'shell.css',
];

// The legacy root-level .js/.css files are served as-is (no bundler touches
// them — they're plain <script>/<link> tags relying on load order and
// shared globals, not ES modules, so they can't be safely run through a
// bundler). They were shipped byte-for-byte unminified until now, even
// though esbuild is already a project dependency — this applies
// that same, already-proven step to every other root .js/.css file.
// `transform()` (not `build()`) minifies one file's source in place without
// bundling/resolving imports, which is exactly what a non-module script
// needs.
async function minifyToDist(file, loader) {
  const srcPath = path.join(rootDir, file);
  const destPath = path.join(distDir, file);
  const source = fs.readFileSync(srcPath, 'utf8');
  const result = await transform(source, { minify: true, loader, target: 'es2020' });
  fs.writeFileSync(destPath, result.code);
}

let minifiedCount = 0;
let originalBytes = 0;
let minifiedBytes = 0;

for (const file of files) {
  if (file === 'node_modules' || file === 'dist' || file.startsWith('.') || EXCLUDED_FILES.includes(file)) continue;
  const ext = path.extname(file).toLowerCase();
  if (!['.js', '.css', '.webmanifest', '.png', '.json', '.html', '.ico'].includes(ext)) continue;

  const srcPath = path.join(rootDir, file);
  const destPath = path.join(distDir, file);

  try {
    if (!fs.statSync(srcPath).isFile()) continue;

    if (ext === '.js') {
      try {
        execSync(`node --check "${srcPath}"`, { stdio: 'pipe' });
      } catch (syntaxErr) {
        console.error(`\n❌ BUILD FAILED: SyntaxError in ${file}`);
        throw new Error(`Syntax check failed for ${file}: ${syntaxErr.message}`);
      }
      const before = fs.statSync(srcPath).size;
      await minifyToDist(file, 'js');
      originalBytes += before;
      minifiedBytes += fs.statSync(destPath).size;
      minifiedCount++;
    } else if (ext === '.css') {
      const before = fs.statSync(srcPath).size;
      await minifyToDist(file, 'css');
      originalBytes += before;
      minifiedBytes += fs.statSync(destPath).size;
      minifiedCount++;
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  } catch (e) {
    if (e.message && e.message.startsWith('Syntax check failed')) {
      throw e;
    }
    console.warn(`Could not process ${file}:`, e.message);
  }
}

if (minifiedCount > 0) {
  const savedPct = Math.round((1 - minifiedBytes / originalBytes) * 100);
  console.log(`Minified ${minifiedCount} JS/CSS files: ${originalBytes} -> ${minifiedBytes} bytes (-${savedPct}%).`);
}

// version.json: a tiny, unminified marker the client polls (see app.js
// checkForNewVersion()) to detect a stale long-lived tab -- a full reload
// re-fetches this deploy's actual app.js, so a stale tab never silently keeps
// running old code (and missing bugfixes) indefinitely. Generated from the
// typed APP_VERSION in src/core/config/constants.ts so there is exactly one
// source of truth; this file is never hand-edited.
{
  const versionSrc = fs.readFileSync(path.join(rootDir, 'src/core/config/constants.ts'), 'utf8');
  const m = versionSrc.match(/APP_VERSION = '([^']+)'/);
  if (!m) {
    throw new Error('build.js: could not find APP_VERSION in src/core/config/constants.ts -- version.json would be stale.');
  }
  fs.writeFileSync(
    path.join(distDir, 'version.json'),
    JSON.stringify({ version: m[1], builtAt: new Date().toISOString() })
  );
  console.log(`Wrote version.json (${m[1]}).`);
}

console.log('Build complete! All root scripts & assets copied to dist/.');
