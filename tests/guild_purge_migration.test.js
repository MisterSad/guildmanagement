// Deleting a guild must remove every row that carries its tag.
//
// Tables with a foreign key to guilds(id) or guild_members(guild, pseudo)
// follow by ON DELETE CASCADE. Every other tag-carrying column has to be named
// in gm_purge_guild_data. Before 20261003090000 the deleters used two hand-kept
// lists that missed four tables: the deleted CLAW still owned 6 bans, 12
// absences and 59 audit lines, which gm_rename_guild then had to refuse to
// hand to whoever took the tag next (ADR-022).
//
// Same inventory as tests/guild_rename_migration.test.js: read from the
// generated types, so a new column fails here until it is handled.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const types = fs.readFileSync(path.join(root, 'src', 'types', 'database.generated.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', fs.readdirSync(path.join(root, 'supabase', 'migrations')).find((f) => f.endsWith('_guild_delete_removes_everything.sql'))),
  'utf8'
);

const TAG_COLUMN = /^(guild|guild_id|guild_ref|source_guild|target_guild|author_guild_id)$/;
// Tag-carrying columns that cascade from a parent and need no explicit handling.
const EXEMPT = new Set([
  'guild_creation_requests.guild_tag', // historical request record
]);

function inventory() {
  const start = types.indexOf('  Tables: {');
  const block = types.slice(start, types.indexOf('  Views: {'));
  const starts = [...block.matchAll(/^ {6}([a-z0-9_]+): \{$/gm)].map((m) => ({ name: m[1], at: m.index }));
  return starts.map((t, i) => {
    const body = block.slice(t.at, i + 1 < starts.length ? starts[i + 1].at : undefined);
    const rowIdx = body.indexOf('Row: {');
    const rowBody = body.slice(rowIdx, body.indexOf('\n        }', rowIdx));
    const cols = [...rowBody.matchAll(/^ {10}([a-z0-9_]+)\??:/gm)].map((c) => c[1]);
    const fk = new Set();
    for (const r of body.matchAll(/columns: \[([^\]]*)\][\s\S]*?referencedRelation: "([a-z_]+)"/g)) {
      if (r[2] === 'guilds' || r[2] === 'guild_members') for (const c of r[1].matchAll(/"([a-z0-9_]+)"/g)) fk.add(c[1]);
    }
    return { table: t.name, cols, fk };
  });
}

function body(name) {
  const s = migration.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
  expect(s, name).toBeGreaterThan(-1);
  return migration.slice(s, migration.indexOf('$function$;', s));
}

describe('guild deletion removes everything', () => {
  it('gm_purge_guild_data handles every tag column no cascading foreign key covers', () => {
    const purge = body('gm_purge_guild_data');
    const missing = [];
    for (const { table, cols, fk } of inventory()) {
      for (const col of cols) {
        if (!TAG_COLUMN.test(col) || table === 'guilds' || EXEMPT.has(table + '.' + col) || fk.has(col)) continue;
        const del = new RegExp('DELETE FROM public\\.' + table + ' WHERE ' + col + ' = v_guild');
        const nul = new RegExp('UPDATE public\\.' + table + ' SET ' + col + ' = NULL WHERE ' + col + ' = v_guild');
        if (!del.test(purge) && !nul.test(purge)) missing.push(table + '.' + col);
      }
    }
    expect(missing, 'tag columns a guild deletion would leave behind').toEqual([]);
  });

  it('detaches wiki comments, whose foreign key to guilds would otherwise block the delete', () => {
    expect(body('gm_purge_guild_data')).toMatch(/UPDATE public\.migration_wiki_comments SET author_guild_id = NULL WHERE author_guild_id = v_guild/);
  });

  it('deletes the roster before the guild, and the guild last', () => {
    const purge = body('gm_purge_guild_data');
    const roster = purge.indexOf('DELETE FROM public.guild_members');
    const guild = purge.indexOf('DELETE FROM public.guilds');
    expect(roster).toBeGreaterThan(-1);
    expect(guild).toBeGreaterThan(roster);
    for (const m of purge.matchAll(/(DELETE FROM|UPDATE) public\.(\w+)/g)) {
      if (m[2] !== 'guilds') expect(m.index, m[2]).toBeLessThan(guild);
    }
  });

  it('both deleters go through the purge, and record the deletion without owning the tag', () => {
    for (const fn of ['gm_delete_guild', 'gm_expire_empty_guilds']) {
      const b = body(fn);
      expect(b, fn).toMatch(/public\.gm_purge_guild_data\(/);
      expect(b, fn).not.toMatch(/DELETE FROM public\.guilds/);
      expect(b, fn).toMatch(/'deleted_guild'/);
    }
    expect(body('gm_delete_guild')).toMatch(/INSERT INTO public\.system_audit_logs \(level, service, action_type, user_identifier, message, metadata\)/);
    expect(body('gm_expire_empty_guilds')).toMatch(/'guild_expired', NULL,/);
  });

  it('keeps the purge off the API and the deleters gated', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.gm_purge_guild_data\(text\) FROM PUBLIC, anon, authenticated;/);
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.gm_purge_guild_data/);
    expect(body('gm_delete_guild')).toMatch(/IF NOT public\.is_super_admin\(\) THEN/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.gm_expire_empty_guilds\(\) FROM PUBLIC, anon, authenticated;/);
  });

  it('the one-off cleanup aborts unless production matches what was reviewed', () => {
    expect(migration).toMatch(/v_bans <> 6 OR v_abs <> 12 OR v_logs <> 59 OR v_cfg <> 1/);
  });
});
