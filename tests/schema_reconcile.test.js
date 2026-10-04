// Short-term plan, phase 4b: production and the repository describe the same
// schema again (audit DB-01, DB-04, BE-B-05).
//
// 20261003170654 adds what production was missing (the index every RLS helper
// needs, the foreign keys from the tag-carrying tables to guilds, the
// updated_at triggers) and versions what only production had. The four
// snapshot_drifted_functions files restate, from the catalogue, the 49 function
// bodies no migration contained verbatim.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'supabase', 'migrations');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf-8');
const reconcile = read('20261003170654_reconcile_schema_objects.sql');
const snapshots = fs.readdirSync(dir).filter((f) => /_snapshot_drifted_functions_\d\.sql$/.test(f)).sort();
const types = fs.readFileSync(path.join(root, 'src', 'types', 'database.generated.ts'), 'utf-8');

describe('reconcile_schema_objects', () => {
  it('builds the indexes the RLS helpers and the uid lookups rely on', () => {
    expect(reconcile).toContain('CREATE INDEX IF NOT EXISTS idx_accounts_auth_user_id ON public.accounts (auth_user_id);');
    expect(reconcile).toContain('CREATE INDEX IF NOT EXISTS idx_guild_members_uid     ON public.guild_members (uid);');
    expect(reconcile).toContain('CREATE INDEX IF NOT EXISTS idx_event_daily_scores_guild_pseudo ON public.event_daily_scores (guild, pseudo);');
  });

  it('versions the two UNIQUE indexes only production had', () => {
    expect(reconcile).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_uid ON public.accounts USING btree (uid) WHERE (uid IS NOT NULL);');
    expect(reconcile).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS guild_config_join_code_hash_unique ON public\.guild_config/);
    expect(reconcile).toContain('ADD CONSTRAINT shadowfront_squads_guild_session_pseudo_key UNIQUE (guild, session_id, pseudo)');
  });

  it('adds every tag foreign key as ON UPDATE CASCADE, ON DELETE NO ACTION, deferrable', () => {
    for (const [t, c] of [['accounts', 'guild'], ['account_link_codes', 'guild'], ['banned_players', 'guild'],
                          ['event_status', 'guild'], ['guild_config', 'guild'], ['guild_members', 'guild'],
                          ['player_absences', 'guild'], ['war_opponents', 'guild_ref']]) {
      expect(reconcile, t).toContain(`('${t}',`);
      expect(types, t + '_' + c + '_fkey in the generated types').toContain(`foreignKeyName: "${t}_${c}_fkey"`);
    }
    expect(reconcile).toContain('ON UPDATE CASCADE ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE');
    expect(reconcile).toContain("RAISE EXCEPTION 'reconcile: a foreign key to guilds is missing or has the wrong actions'");
  });

  it('keeps the audit log free of a foreign key: a log line must never fail on its tag', () => {
    expect(reconcile).not.toMatch(/\('system_audit_logs',/);
    expect(types).not.toContain('foreignKeyName: "system_audit_logs_guild_fkey"');
  });

  it('maintains updated_at in the database', () => {
    for (const t of ['guild_config', 'player_absences', 'event_status']) {
      expect(reconcile).toContain(`CREATE TRIGGER trg_${t}_updated_at\n    BEFORE UPDATE ON public.${t}`);
    }
    expect(reconcile).toContain('REVOKE ALL ON FUNCTION public.handle_updated_at() FROM PUBLIC, anon, authenticated;');
  });

  it('drops the dead gm_session_id_base', () => {
    expect(reconcile).toContain('DROP FUNCTION IF EXISTS public.gm_session_id_base(text);');
    expect(types).not.toContain('gm_session_id_base');
  });
});

describe('snapshot_drifted_functions', () => {
  it('restates 49 functions in four parts, each proving body and grants against production', () => {
    expect(snapshots).toHaveLength(4);
    let fns = 0;
    for (const f of snapshots) {
      const sql = read(f);
      const created = sql.match(/^CREATE OR REPLACE FUNCTION public\./gm) || [];
      const checked = sql.match(/^ {4}\('public\.[a-z_]+\(.*\)', '[0-9a-f]{32}', '[a-z_,]+'\)/gm) || [];
      expect(checked.length, f).toBe(created.length);
      expect(sql, f).toContain("RAISE EXCEPTION 'snapshot: % does not have production''s body', r.sig;");
      expect(sql, f).toContain("pg_get_function_identity_arguments(p.oid) || ')' = r.sig");
      fns += created.length;
    }
    expect(fns).toBe(49);
  });

  it('resets every grant before restating it, so a replay cannot keep a wider one', () => {
    for (const f of snapshots) {
      const sql = read(f);
      const created = (sql.match(/^CREATE OR REPLACE FUNCTION public\./gm) || []).length;
      const revoked = (sql.match(/^REVOKE ALL ON FUNCTION public\.[a-z_]+\(.*\) FROM PUBLIC, anon, authenticated, service_role;$/gm) || []).length;
      expect(revoked, f).toBe(created);
      expect(sql, f).not.toMatch(/TO PUBLIC;/);
    }
  });

  it('grants anon nothing except the client error reporter', () => {
    const anon = snapshots.flatMap((f) => read(f).match(/^GRANT EXECUTE ON FUNCTION public\.([a-z_]+)\(.*\) TO anon;$/gm) || []);
    expect(anon.map((l) => l.match(/public\.([a-z_]+)\(/)[1])).toEqual(['gm_report_client_error']);
  });
});
