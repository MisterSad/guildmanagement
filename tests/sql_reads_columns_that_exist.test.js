// A migration may only read columns the database actually has.
//
// `guilds.name` is declared at line 13 of
// 20260812000001_schema_tables_and_indexes.sql, inside
// `CREATE TABLE IF NOT EXISTS public.guilds`. The table already existed when that
// migration first ran, so the statement was a no-op and the column was never
// created. `src/types/database.generated.ts`, generated FROM production, lists
// `guilds` as id / server_number / empty_since / created_at / updated_at -- no
// `name`. Production and the generated types agree; only the canonical DDL
// disagrees.
//
// Two functions and one command believed the DDL:
//
//   * `gm_list_opponent_candidates` -> 42703, surfaced as HTTP 400 eleven times
//     between 2026-09-26 23:26 and 2026-09-27 19:37 in the project's own edge
//     logs. The guild opponent picker had never worked in production.
//   * `gm_upsert_war_session` -> the same, on the branch that saves a guild
//     opponent. Unreachable through the UI only because the picker failed first.
//   * `/setup-server` in the Discord worker -> `guildRow` was null for EVERY
//     guild, and the code then invented server number "1000".
//
// Nothing caught any of it: `tests/rpc_names_exist.test.js` checks that called
// FUNCTIONS exist, not that the columns inside them do, and no test compares SQL
// against the generated types. This one does, for the columns of the tables the
// generated types describe.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const typesPath = path.join(rootDir, 'src', 'types', 'database.generated.ts');

/**
 * Column names per table, read out of the generated types -- which are generated
 * from the live database, so they are the closest thing this repository has to
 * ground truth about the schema.
 */
function liveColumnsByTable() {
  const src = fs.readFileSync(typesPath, 'utf8');
  const tablesIdx = src.indexOf('  Tables: {');
  const viewsIdx = src.indexOf('  Views: {');
  expect(tablesIdx, 'could not find the Tables block in the generated types').toBeGreaterThan(-1);
  const block = src.slice(tablesIdx, viewsIdx > tablesIdx ? viewsIdx : undefined);

  const byTable = new Map();
  // `      <table>: {` then its `Row: { ... }` object.
  const tableRe = /^ {6}([a-z0-9_]+): \{$/gm;
  let m;
  while ((m = tableRe.exec(block)) !== null) {
    const table = m[1];
    const rowIdx = block.indexOf('Row: {', m.index);
    if (rowIdx === -1) continue;
    const rowEnd = block.indexOf('\n        }', rowIdx);
    const rowBlock = block.slice(rowIdx, rowEnd);
    const cols = new Set();
    for (const c of rowBlock.matchAll(/^ {10}([a-z0-9_]+)\??:/gm)) cols.add(c[1]);
    if (cols.size > 0) byTable.set(table, cols);
  }
  return byTable;
}

const live = liveColumnsByTable();

describe('the generated types were parsed', () => {
  it('found a realistic number of tables and their columns', () => {
    expect(live.size).toBeGreaterThan(20);
    expect(live.get('guilds')).toBeDefined();
    expect([...live.get('guilds')].sort()).toContain('server_number');
  });

  it('confirms guilds has no `name` column, which is the whole point of this file', () => {
    expect(live.get('guilds').has('name')).toBe(false);
  });
});

describe('no SQL in the repository reads guilds.name', () => {
  function sqlFiles() {
    const dir = path.join(rootDir, 'supabase', 'migrations');
    return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => path.join(dir, f));
  }

  // An alias-qualified read: `g.name`, `gu.name`, `guilds.name`. Deliberately
  // NOT a bare `name`, which is a legitimate column on other tables
  // (war_opponents.name, accounts, ...).
  const readRe = /(?<![a-z0-9_])(?:guilds|g|gu)\.name(?![a-z0-9_])/i;

  // The two migrations that INTRODUCED the read are applied history and must not
  // be edited (ADR-008); 20260928110000 supersedes both. Any OTHER migration
  // reading the column is a regression, and so is a new one.
  const SUPERSEDED = new Set([
    '20260914090000_war_daily_scores_and_chest_tiers.sql',
    '20260915130000_fix_war_session_day_results_clear.sql',
  ]);
  const FIX = '20260928110000_war_opponents_stop_reading_guilds_name.sql';

  it('has no migration reading it outside the superseded history', () => {
    const offenders = [];
    for (const file of sqlFiles()) {
      const base = path.basename(file);
      if (SUPERSEDED.has(base)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*--/.test(line)) continue;          // prose
        if (/RAISE\s+(EXCEPTION|NOTICE)/i.test(line)) continue; // an error message naming the bug
        if (readRe.test(line)) offenders.push(`${base}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is fixed by a migration that comes after the two that broke it', () => {
    const names = sqlFiles().map((f) => path.basename(f)).sort();
    expect(names, 'the fix migration is missing').toContain(FIX);
    for (const superseded of SUPERSEDED) {
      expect(names).toContain(superseded);
      expect(FIX > superseded, `${FIX} must sort after ${superseded}`).toBe(true);
    }
  });

  it('redefines both broken functions, and neither new body reads the column', () => {
    const fix = fs.readFileSync(path.join(rootDir, 'supabase', 'migrations', FIX), 'utf8');
    for (const fn of ['gm_list_opponent_candidates', 'gm_upsert_war_session']) {
      expect(fix, `${FIX} must redefine ${fn}`).toContain(`CREATE OR REPLACE FUNCTION public.${fn}`);
    }
    // Every function body this migration stores, checked the way Postgres will
    // see it -- comments included, since pg_get_functiondef keeps them.
    const bodies = fix.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$(?:function)?\$;/g) || [];
    expect(bodies.length).toBe(2);
    for (const body of bodies) {
      const lines = body.split('\n').filter((l) => !/^\s*--/.test(l));
      expect(lines.filter((l) => readRe.test(l))).toEqual([]);
    }
  });

  it('has no TypeScript or worker code selecting it', () => {
    const dirs = ['src', 'supabase/functions', 'discord-verification-worker'];
    const offenders = [];
    for (const d of dirs) {
      const abs = path.join(rootDir, d);
      if (!fs.existsSync(abs)) continue;
      const stack = [abs];
      while (stack.length) {
        const cur = stack.pop();
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
          const full = path.join(cur, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            stack.push(full);
            continue;
          }
          if (!/\.(ts|js)$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
          if (full === typesPath) continue;
          const src = fs.readFileSync(full, 'utf8');
          // A PostgREST select list naming `name` alongside guild columns is the
          // shape that broke /setup-server: .from("guilds").select("id, name, ...")
          for (const call of src.matchAll(/from\(\s*['"]guilds['"]\s*\)\s*\n?\s*\.select\(\s*['"]([^'"]*)['"]/g)) {
            const cols = call[1].split(',').map((c) => c.trim());
            if (cols.includes('name')) offenders.push(`${path.relative(rootDir, full)}: selects name from guilds`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the canonical DDL still declares the column, and that is recorded', () => {
  // Not an error to fix by editing an applied migration (ADR-008 forbids that),
  // but it must not be forgotten either: a clean replay of the chain produces a
  // `guilds.name` that production does not have. If a later migration drops it,
  // this test is what tells the next reader why.
  it('is a known divergence between a clean replay and production', () => {
    const canonical = fs.readFileSync(
      path.join(rootDir, 'supabase', 'migrations', '20260812000001_schema_tables_and_indexes.sql'),
      'utf8'
    );
    const guildsIdx = canonical.indexOf('CREATE TABLE IF NOT EXISTS public.guilds');
    expect(guildsIdx).toBeGreaterThan(-1);
    const decl = canonical.slice(guildsIdx, canonical.indexOf(');', guildsIdx));
    const declaresName = /^\s*name\s+TEXT/mi.test(decl);
    const liveHasName = live.get('guilds').has('name');

    // Exactly one of two states is acceptable: the divergence as it stands today
    // (declared, absent live), or both sides agreeing after someone reconciles
    // them. What must never happen is code reading the column while it is
    // missing -- which the two tests above enforce.
    expect(declaresName || !liveHasName).toBe(true);
    if (declaresName && !liveHasName) {
      expect(declaresName, 'documented divergence: see 20260928110000').toBe(true);
    }
  });
});
