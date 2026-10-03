// gm_rename_guild must move EVERY column that carries a guild tag.
//
// Columns with a foreign key to guilds(id) or to guild_members(guild, pseudo)
// follow by ON UPDATE CASCADE. Every other tag-carrying column has to be named
// in an explicit UPDATE inside the function -- and nothing reminds whoever adds
// the next `guild text` column to also add it there. A missed column would
// leave rows behind under the old tag: invisible to the renamed tenant, and
// inherited by whoever takes that tag next.
//
// This test derives the inventory from src/types/database.generated.ts (which is
// generated from the live database) and fails when a tag column is neither
// FK-covered nor updated by the function.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const typesSrc = fs.readFileSync(path.join(rootDir, 'src', 'types', 'database.generated.ts'), 'utf8');
const migrationPath = path.join(rootDir, 'supabase', 'migrations', '20261003070904_guild_rename.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

/** Columns that hold a tag but must NOT follow a rename, and why. */
const EXEMPT = new Map([
  // A creation request records the tag that was asked for, at the time.
  ['guild_creation_requests.guild_tag', 'historical request record'],
  // Frozen text by design; the row follows through its `guild` FK.
  ['guild_tag_history.old_tag', 'history'],
  ['guild_tag_history.new_tag', 'history'],
]);

const TAG_COLUMN = /^(guild|guild_id|guild_ref|source_guild|target_guild|author_guild_id|guild_tag|old_tag|new_tag)$/;

function tablesBlock() {
  const start = typesSrc.indexOf('  Tables: {');
  const end = typesSrc.indexOf('  Views: {');
  expect(start).toBeGreaterThan(-1);
  return typesSrc.slice(start, end > start ? end : undefined);
}

/** { table -> { cols: Set, fkCols: Set } } from the generated types. */
function inventory() {
  const block = tablesBlock();
  const out = new Map();
  const tableRe = /^ {6}([a-z0-9_]+): \{$/gm;
  const starts = [];
  let m;
  while ((m = tableRe.exec(block)) !== null) starts.push({ name: m[1], at: m.index });
  starts.forEach((t, i) => {
    const body = block.slice(t.at, i + 1 < starts.length ? starts[i + 1].at : undefined);
    const rowIdx = body.indexOf('Row: {');
    if (rowIdx === -1) return;
    const rowBody = body.slice(rowIdx, body.indexOf('\n        }', rowIdx));
    const cols = new Set([...rowBody.matchAll(/^ {10}([a-z0-9_]+)\??:/gm)].map((c) => c[1]));
    const fkCols = new Set();
    const relRe = /columns: \[([^\]]*)\][\s\S]*?referencedRelation: "([a-z_]+)"/g;
    let r;
    while ((r = relRe.exec(body)) !== null) {
      if (r[2] !== 'guilds' && r[2] !== 'guild_members') continue;
      for (const c of r[1].matchAll(/"([a-z0-9_]+)"/g)) fkCols.add(c[1]);
    }
    out.set(t.name, { cols, fkCols });
  });
  return out;
}

function functionBody(name) {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  expect(start, name + ' is not defined in the migration').toBeGreaterThan(-1);
  const end = migration.indexOf('$function$;', start);
  return migration.slice(start, end);
}

describe('guild rename migration', () => {
  it('updates every tag column that no foreign key carries', () => {
    const body = functionBody('gm_rename_guild');
    const missing = [];
    for (const [table, { cols, fkCols }] of inventory()) {
      for (const col of cols) {
        if (!TAG_COLUMN.test(col)) continue;
        const key = table + '.' + col;
        if (EXEMPT.has(key) || fkCols.has(col) || table === 'guilds') continue;
        const re = new RegExp('UPDATE public\\.' + table + '\\s+SET ' + col + ' = v_new\\s+WHERE ' + col + ' = v_old');
        if (!re.test(body)) missing.push(key);
      }
    }
    expect(missing, 'tag columns that a rename would leave behind').toEqual([]);
  });

  it('rewrites the guilds foreign keys from the catalogue and asserts the result', () => {
    expect(migration).toMatch(/c\.confrelid = 'public\.guilds'::regclass/);
    expect(migration).toMatch(/ON UPDATE %s ON DELETE %s DEFERRABLE INITIALLY IMMEDIATE/);
    expect(migration).toMatch(/WHEN r\.confrelid = 'public\.guilds'::regclass THEN 'CASCADE'/);
    expect(migration).toMatch(/RAISE EXCEPTION 'guild_rename: a foreign key/);
  });

  it('defers the checks only inside the rename, and re-arms them before returning', () => {
    const body = functionBody('gm_rename_guild');
    const deferred = body.indexOf('SET CONSTRAINTS ALL DEFERRED');
    const members = body.indexOf('UPDATE public.guild_members SET guild = v_new');
    const guilds = body.indexOf('UPDATE public.guilds SET id = v_new');
    const immediate = body.indexOf('SET CONSTRAINTS ALL IMMEDIATE');
    expect(deferred).toBeGreaterThan(-1);
    // guild_members before guilds: its cascade must run while the guilds FK is deferred.
    expect(members).toBeGreaterThan(deferred);
    expect(guilds).toBeGreaterThan(members);
    expect(immediate).toBeGreaterThan(guilds);
  });

  it('is gated and validated before any write', () => {
    const body = functionBody('gm_rename_guild');
    const firstWrite = body.indexOf('SET CONSTRAINTS ALL DEFERRED');
    for (const guard of ["'unauthorized'", "'invalid_tag'", "'demo_protected'", "'tag_taken'", "'tag_reserved'", "'cooldown'"]) {
      const at = body.indexOf(guard);
      expect(at, guard).toBeGreaterThan(-1);
      expect(at, guard + ' must be checked before the first write').toBeLessThan(firstWrite);
    }
    expect(body).toMatch(/v_role = 'guild_admin' AND public\.check_user_guild_write_access\(v_old\)/);
    expect(body).toMatch(/\^\[A-Z0-9_\]\{2,12\}\$/);
  });

  it('refuses a tag that still owns residual rows in non-FK tables', () => {
    const body = functionBody('gm_rename_guild');
    for (const t of ['guild_members', 'accounts', 'account_link_codes', 'banned_players', 'event_status', 'guild_config', 'player_absences', 'system_audit_logs']) {
      expect(body, t).toMatch(new RegExp('FROM public\\.' + t + '\\s+WHERE guild = v_new'));
    }
  });

  it('is SECURITY DEFINER with an empty search_path and no anon grant', () => {
    for (const fn of ['gm_rename_guild', 'gm_guild_tag_history']) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/SECURITY DEFINER/);
      expect(body, fn).toMatch(/SET search_path = ''/);
    }
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.gm_rename_guild\(text, text\) FROM PUBLIC, anon;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.gm_rename_guild\(text, text\) TO authenticated;/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.gm_guild_tag_history\(text\) FROM PUBLIC, anon;/);
  });

  it('keeps the history table deny-all', () => {
    expect(migration).toMatch(/ALTER TABLE public\.guild_tag_history ENABLE ROW LEVEL SECURITY;/);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.guild_tag_history FROM PUBLIC, anon, authenticated;/);
    expect(migration).not.toMatch(/CREATE POLICY[^;]*guild_tag_history/);
  });
});
