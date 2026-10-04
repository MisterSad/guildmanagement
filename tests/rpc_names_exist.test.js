/**
 * Every RPC the client calls must exist in a migration.
 *
 * `StatsView.ts` called `list_event_weeks` for months after migration
 * 20260926070155 dropped it. Nothing caught it, for two compounding reasons:
 * supabase-js answers a missing function with `{ data: null, error }` instead
 * of throwing, and the unit tests mocked `list_event_weeks` themselves — so the
 * suite was green against a function that did not exist anywhere but in the
 * mock. The week dropdown silently showed one option and every period filter
 * silently became 1w.
 *
 * That migration's own header claims "every RPC name is a string literal, so a
 * grep for callers is conclusive". It was right about the technique and only
 * ran it over `supabase/`. This is that grep, run over `src/`, over
 * `supabase/functions/`, over `discord-verification-worker/` and over the
 * mocks, in CI, every time.
 *
 * The worker was added on 2026-09-28, and it was not an academic gap: it had
 * been calling `gm_submit_event_score` since `/update-stats` shipped -- a
 * function that exists in no migration and in no database. supabase-js answered
 * `{ data: null, error }`, the worker logged the error to the console and told
 * the player "✅ Stats Updated" anyway. Every Glory submitted through Discord
 * was discarded. This directory is not "not the client": it is a live process
 * holding the service-role key.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, filter, out);
    } else if (filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Function names any migration in the repository creates. */
function definedFunctionNames() {
  const names = new Set();
  const files = walk(path.join(rootDir, 'supabase', 'migrations'), (f) => f.endsWith('.sql'));
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z0-9_]+)"?/gi;
    let m;
    while ((m = re.exec(sql)) !== null) names.add(m[1].toLowerCase());
  }
  return names;
}

/** Function names any migration drops, with the file that did it. */
function droppedFunctionNames() {
  const dropped = new Map();
  const files = walk(path.join(rootDir, 'supabase', 'migrations'), (f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(file, 'utf8');
    const re = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi;
    let m;
    while ((m = re.exec(sql)) !== null) dropped.set(m[1].toLowerCase(), path.basename(file));
  }
  return dropped;
}

/** `.rpc('name'` call sites, and the mock keys that stand in for them. */
function referencedRpcNames(dirs, patterns) {
  const found = new Map();
  for (const dir of dirs) {
    const abs = path.join(rootDir, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs, (f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
          const name = m[1].toLowerCase();
          if (!found.has(name)) found.set(name, []);
          found.get(name).push(path.relative(rootDir, file));
        }
      }
    }
  }
  return found;
}

const defined = definedFunctionNames();
const dropped = droppedFunctionNames();

describe('every RPC the client calls is a function that exists', () => {
  it('has migrations for every `.rpc("name")` in src/', () => {
    const called = referencedRpcNames(['src'], [/\.rpc\(\s*['"]([a-z0-9_]+)['"]/gi]);
    const missing = [];
    for (const [name, sites] of called) {
      if (defined.has(name)) continue;
      const why = dropped.has(name) ? ` (dropped by ${dropped.get(name)})` : ' (never defined)';
      missing.push(`${name}${why} <- ${sites.join(', ')}`);
    }
    expect(missing, 'RPCs called from src/ with no CREATE FUNCTION in supabase/migrations/').toEqual([]);
  });

  it('has migrations for every `.rpc("name")` in the Discord worker', () => {
    const called = referencedRpcNames(['discord-verification-worker'], [/\.rpc\(\s*['"]([a-z0-9_]+)['"]/gi]);
    // Wired-to-real-data guard: the worker DOES call RPCs, so an empty result
    // means the path or the regex is wrong, not that the worker is clean.
    expect(called.size, 'no .rpc() calls found in discord-verification-worker/ -- check the path').toBeGreaterThan(0);
    const missing = [];
    for (const [name, sites] of called) {
      if (defined.has(name)) continue;
      const why = dropped.has(name) ? ` (dropped by ${dropped.get(name)})` : ' (never defined)';
      missing.push(`${name}${why} <- ${sites.join(', ')}`);
    }
    expect(missing, 'RPCs called from the Discord worker with no CREATE FUNCTION in supabase/migrations/').toEqual([]);
  });

  it('has migrations for every RPC the unit tests mock', () => {
    // A mock is a claim about the backend. If no migration creates the
    // function, the mock is the only place it exists and the suite is testing
    // a fiction -- which is exactly how list_event_weeks survived its own
    // removal.
    const mocked = referencedRpcNames(
      ['tests'],
      [/^\s*([a-z][a-z0-9_]{3,}):\s*(?:\([^)]*\)|async\s*\([^)]*\))\s*=>\s*\(?\{\s*data:/gim]
    );
    const missing = [];
    for (const [name, sites] of mocked) {
      // Only judge names that look like this project's RPCs; a mock helper
      // called `data:` something else is not our business.
      if (!name.startsWith('gm_') && !dropped.has(name)) continue;
      if (defined.has(name)) continue;
      const why = dropped.has(name) ? ` (dropped by ${dropped.get(name)})` : ' (never defined)';
      missing.push(`${name}${why} <- ${[...new Set(sites)].join(', ')}`);
    }
    expect(missing, 'RPCs mocked in tests/ with no CREATE FUNCTION in supabase/migrations/').toEqual([]);
  });

  it('does not call anything a migration dropped without recreating it', () => {
    const called = referencedRpcNames(
      ['src', 'supabase/functions', 'discord-verification-worker'],
      [/\.rpc\(\s*['"]([a-z0-9_]+)['"]/gi]
    );
    const zombies = [];
    for (const [name, sites] of called) {
      if (!dropped.has(name)) continue;
      if (defined.has(name)) continue; // dropped, then recreated later: fine
      zombies.push(`${name} dropped by ${dropped.get(name)} but still called from ${sites.join(', ')}`);
    }
    expect(zombies).toEqual([]);
  });
});

describe('the detector is wired to real data', () => {
  it('reads a non-trivial number of migrations and finds known functions', () => {
    // Guards against the regexes silently matching nothing, which would make
    // every assertion above pass for the wrong reason.
    expect(defined.size).toBeGreaterThan(50);
    expect(defined.has('gm_stats_data')).toBe(true);
    expect(defined.has('gm_stats_weeks')).toBe(true);
    expect(dropped.has('list_event_weeks')).toBe(true);
    expect(defined.has('list_event_weeks')).toBe(false);
  });
});
