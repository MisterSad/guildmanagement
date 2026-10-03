// Short-term plan, phase 5 (audit DB-03): the migration chain replays on an
// empty PostgreSQL 17, and the result is production's schema.
//
// The replay itself runs in CI (`migrations-replay`). These checks keep its
// moving parts honest without a database.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));

describe('the replay', () => {
  it('stops at the first error, one transaction per migration, with gm.replay set', () => {
    const sh = read('scripts/replay-migrations.sh');
    expect(sh).toContain('-v ON_ERROR_STOP=1');
    expect(sh).toContain('"${PSQL[@]}" -1 -f "$f"');
    expect(sh).toContain('-c gm.replay=on');
    expect(sh).toContain('supabase/replay/prelude.sql');
  });

  it('starts from Supabase\'s default privileges, which the least-privilege migrations revoke from', () => {
    const prelude = read('supabase/replay/prelude.sql');
    for (const kind of ['TABLES', 'SEQUENCES', 'FUNCTIONS']) {
      expect(prelude).toContain(`IN SCHEMA public GRANT ALL ON ${kind}`);
    }
  });

  it('has a production fingerprint to compare against', () => {
    const fp = read('tests/fixtures/schema_fingerprint.txt').trim().split('\n');
    expect(fp.length).toBeGreaterThan(1000);
    for (const line of fp) expect(line).toMatch(/^(column|column_grant|constraint|function|index|policy|table|trigger|view)\|[^|]+\|[0-9a-f]{32}$/);
    // Never a credential column readable by the browser.
    expect(read('supabase/replay/schema-fingerprint.sql')).toContain("g.grantee IN ('anon', 'authenticated')");
  });
});

describe('guards that pin production only step aside on a replay', () => {
  // A guard keyed on gm.replay must never weaken production: it may only
  // relax a check of production's own bodies or data volumes.
  const users = migrations.filter((f) => read(`supabase/migrations/${f}`).includes("current_setting('gm.replay', true)"));

  it('is confined to the migrations reviewed for it', () => {
    expect(users.sort()).toEqual([
      '20261003080433_guild_delete_removes_everything.sql',
      '20261003105039_event_rpcs_tenant_checks.sql',
      '20261003112152_truncation_fixes_and_log_retention.sql',
      '20261003113839_tenant_isolation_and_sessions.sql',
      '20261003165501_remove_passkeys.sql',
    ]);
  });

  it('never skips a grant or policy check', () => {
    const sql = read('supabase/migrations/20261003113839_tenant_isolation_and_sessions.sql');
    const check = sql.slice(sql.indexOf('DO $check$'));
    for (const c of ["'a policy still resolves its caller without a session check'",
                     "'unexpected UPDATE grants on migration_wiki_pages'",
                     "'gm_revoke_auth_sessions is callable by browsers'"]) {
      const at = check.indexOf(c);
      expect(at, c).toBeGreaterThan(-1);
      const cond = check.slice(check.lastIndexOf('  IF ', at), at);
      expect(cond, c).not.toContain('v_bodies');
    }
  });

  it('lands on production\'s bodies anyway: every snapshot asserts them by md5', () => {
    for (const f of migrations.filter((m) => /_snapshot_drifted_functions_\d\.sql$/.test(m))) {
      expect(read(`supabase/migrations/${f}`)).toContain("RAISE EXCEPTION 'snapshot: % does not have production''s body', r.sig;");
    }
  });
});

describe('reconcile_replay_to_production', () => {
  const sql = read('supabase/migrations/20261003174320_reconcile_replay_to_production.sql');

  it('gives accounts production\'s grants: 8 readable columns, no write (C0)', () => {
    expect(sql).toContain('REVOKE ALL ON TABLE public.accounts FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('GRANT SELECT (id, role, guild, uid, status, server_number, auth_user_id, created_at)\n  ON public.accounts TO authenticated;');
    expect(sql).toContain("RAISE EXCEPTION 'reconcile: public.accounts is wider than production (C0)'");
  });

  it('takes the authorisation helpers away from anon', () => {
    for (const fn of ['check_user_guild_write_access', 'gm_can_read_guild_data', 'gm_can_admin_see_absences']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(text\\)\\s+FROM PUBLIC, anon;`));
    }
  });

  it('removes the direct cascading keys that would bypass gm_purge_guild_data', () => {
    expect(sql).toContain("RAISE EXCEPTION 'reconcile: a direct cascading key to guilds bypasses gm_purge_guild_data'");
  });
});
