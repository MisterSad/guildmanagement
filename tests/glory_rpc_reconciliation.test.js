// Regression guard for the 2026-08-23 v128.2 Glory outage:
// the live event_participants table had drifted from the canonical master DDL
// (missing created_at column AND missing the non-partial
// UNIQUE (guild, event_name, session_id, pseudo) constraint), so every writer
// using plain ON CONFLICT on those columns — notably gm_upsert_player_glory,
// the Glory tab manual input and the Glory OCR commit path — failed at runtime
// on the live database while succeeding on a fresh canonical replay.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('event_participants live reconciliation (v128.2)', () => {
  it('the reconciliation migration adds both missing artifacts idempotently', () => {
    const migration = read('supabase/migrations/20260823213000_add_event_participants_created_at.sql');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS created_at');
    // Postgres has no ADD CONSTRAINT IF NOT EXISTS: the guard must be a DO block
    expect(migration).toMatch(/DO \$\$/);
    expect(migration).toContain("conname = 'event_participants_guild_event_session_pseudo_key'");
    expect(migration).toMatch(/ADD CONSTRAINT event_participants_guild_event_session_pseudo_key\s+UNIQUE \(guild, event_name, session_id, pseudo\)/);
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'");
    expect(migration).toMatch(/ROLLBACK SQL/);
  });

  it('the canonical master DDL still declares both artifacts (replay parity)', () => {
    const ddl = read('supabase/migrations/20260812000001_schema_tables_and_indexes.sql');
    const tableStart = ddl.indexOf('CREATE TABLE IF NOT EXISTS public.event_participants');
    const tableDef = ddl.slice(tableStart, tableStart + 1200);
    expect(tableDef).toContain('created_at TIMESTAMPTZ DEFAULT now()');
    expect(tableDef).toContain('event_participants_guild_event_session_pseudo_key UNIQUE (guild, event_name, session_id, pseudo)');
  });

  it('saveGlory surfaces logical RPC failures, not only transport errors', () => {
    const glory = read('src/modules/glory/views/GloryView.ts');
    expect(glory).toContain("db.rpc('gm_upsert_player_glory'");
    expect(glory).toMatch(/if \(!row \|\| !row\.ok\) throw/);
    expect(glory).toMatch(/' Glory' \+ \(err && err\.message/);
  });
});
