import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Canonical Migration Chain Replay & Reconciliation (GAP 1)', () => {
  const migrationsDir = path.resolve(__dirname, '../supabase/migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  it('verifies all 13 archive-only RPCs exist in canonical migrations', () => {
    const requiredRPCs = [
      'gm_register_player',
      'gm_set_join_code',
      'gm_get_join_code',
      'gm_approve_player_account',
      'gm_reject_player_account',
      'gm_get_shadow',
      'gm_attach_shadow',
      'gm_get_player_absences',
      'gm_upsert_player_absence',
      'gm_delete_player_absence',
      'gm_update_player_timezone',
      'gm_get_push_prefs',
      'gm_set_push_prefs',
    ];

    const allMigrationContent = files.map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf-8')).join('\n');

    for (const rpc of requiredRPCs) {
      const regex = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${rpc}\\b`, 'i');
      expect(regex.test(allMigrationContent), `Missing canonical definition for ${rpc}`).toBe(true);
    }
  });

  it('verifies tenant-isolated partial unique indexes exist on event_participants', () => {
    const allMigrationContent = files.map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf-8')).join('\n');

    expect(allMigrationContent).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_ep_tenant_session_unique[\s\S]*?WHERE\s+session_id\s+IS\s+NOT\s+NULL/i
    );
    expect(allMigrationContent).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_ep_tenant_no_session_unique[\s\S]*?WHERE\s+session_id\s+IS\s+NULL/i
    );
  });

  it('verifies case-insensitive accounts index idx_accounts_lower_id exists', () => {
    const allMigrationContent = files.map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf-8')).join('\n');

    expect(allMigrationContent).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_accounts_lower_id[\s\S]*?ON\s+public\.accounts\s*\(\s*LOWER\(id\)\s*\)/i
    );
  });

  it('verifies every migration file in supabase/migrations/*.sql ends with NOTIFY pgrst reload', () => {
    // Restored byte for byte from supabase_migrations.schema_migrations, where
    // they were applied without a file (audit DB-02). Adding the NOTIFY would
    // make the file differ from what production actually ran.
    const restoredVerbatim = new Set(['20260926223728_gdpr_erase_player_via_cascade.sql']);
    for (const file of files) {
      if (restoredVerbatim.has(file)) continue;
      const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      // Normalize comments and find last non-empty SQL statement
      const withoutBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
      const lines = withoutBlockComments
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('--'));

      const cleanSql = lines.join(' ');
      expect(cleanSql.toLowerCase()).toContain("notify pgrst, 'reload schema'");
    }
  });

  it('verifies replay prelude exists outside migrations directory', () => {
    const preludePath = path.resolve(__dirname, '../supabase/replay/prelude.sql');
    expect(fs.existsSync(preludePath)).toBe(true);
    const content = fs.readFileSync(preludePath, 'utf-8');
    expect(content).toContain('CREATE SCHEMA IF NOT EXISTS auth');
    expect(content).toContain('CREATE SCHEMA IF NOT EXISTS vault');
  });
});
