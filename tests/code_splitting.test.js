/**
 * tests/code_splitting.test.js
 *
 * The lazy chunks stay lazy (M5). Rollup gives a module its own chunk only if
 * nothing imports it statically; one stray `import { x } from '.../XView'`
 * folds that view -- and everything it imports -- back into what every visitor
 * downloads. This walks the static import graph from src/main.ts, the way the
 * bundler does, and fails on any lazy module it reaches. (The byte budget
 * itself is enforced by scripts/build.js, which fails the build over 450 KB.)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src');

const LAZY = [
  'src/modules/events/views/EventsView.ts',
  'src/modules/shadowfront/views/ShadowfrontView.ts',
  'src/modules/armsrace/views/ArmsRaceView.ts',
  'src/modules/overview/views/OverviewView.ts',
  'src/modules/portal/views/PortalView.ts',
  'src/modules/stats/views/StatsView.ts',
  'src/modules/history/views/HistoryView.ts',
  'src/modules/glory/views/GloryView.ts',
  'src/modules/tickets/views/TicketsView.ts',
  'src/modules/sanctions/views/SanctionsView.ts',
  'src/modules/migration/views/MigrationHubView.ts',
  // The admin chunk: the shell chrome, the router and the admin controllers.
  'src/modules/app/admin-shell.ts',
  'src/modules/app/router.ts',
  'src/modules/shell/views/ShellView.ts',
  'src/modules/app/admin/accounts.controller.ts',
  'src/modules/app/members/members.controller.ts',
  'src/modules/app/ocr/ocr.controller.ts',
];

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Static, value-level specifiers of a module: `import type` and `import()` are not edges. */
function staticImports(file) {
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    if (!m[1]) out.push(m[2]);
  }
  return out;
}

function resolve(from, spec) {
  if (!spec.startsWith('.')) return null; // a package
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function staticClosure(entry) {
  const seen = new Map(); // file -> the file that first imported it
  const queue = [entry];
  seen.set(entry, null);
  while (queue.length) {
    const file = queue.shift();
    if (!/\.(ts|js)$/.test(file)) continue;
    for (const spec of staticImports(file)) {
      const target = resolve(file, spec);
      if (target && !seen.has(target)) {
        seen.set(target, file);
        queue.push(target);
      }
    }
  }
  return seen;
}

const rel = (p) => path.relative(root, p);

describe('code splitting', () => {
  const closure = staticClosure(path.join(src, 'main.ts'));

  it('walks a real graph (the walker is not vacuous)', () => {
    expect(closure.has(path.join(src, 'core/state/app-state.ts'))).toBe(true);
    expect(closure.has(path.join(src, 'modules/app/lazy-views.ts'))).toBe(true);
    expect(closure.has(path.join(src, 'modules/app/admin-loader.ts'))).toBe(true);
    expect(closure.size).toBeGreaterThan(30);
  });

  it.each(LAZY)('the entry never imports %s statically', (lazy) => {
    const abs = path.join(root, lazy);
    expect(fs.existsSync(abs), `${lazy} moved; update this list`).toBe(true);
    if (closure.has(abs)) {
      const chain = [];
      for (let f = abs; f; f = closure.get(f)) chain.unshift(rel(f));
      throw new Error(`${lazy} is in the entry chunk via: ${chain.join(' -> ')}`);
    }
  });

  it('reaches the lazy views only through lazy-views.ts and the admin through admin-loader.ts', () => {
    const lazyViews = fs.readFileSync(path.join(src, 'modules/app/lazy-views.ts'), 'utf8');
    for (const view of LAZY.slice(0, 11)) {
      const spec = '../' + view.replace(/^src\/modules\//, '').replace(/\.ts$/, '');
      expect(lazyViews).toContain(`import('${spec}')`);
    }
    expect(fs.readFileSync(path.join(src, 'modules/app/admin-loader.ts'), 'utf8')).toContain("import('./admin-shell')");
  });
});
