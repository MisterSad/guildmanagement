// Regression guard for audit findings SEC-04 / BE-B-02 / BE-B-03 (2026-10-03):
// event-roster RPCs that wrote into other guilds.
//
// Verified on production before applying, in a rolled-back transaction: a
// guild_admin of DEMO could populate and enrol in DEMO, was refused for another
// guild, a JWT with no account was refused, a missing guild was refused, and
// the service role still worked.

import { describe, it, expect } from 'vitest';
import { sqlFunctionBody } from './helpers/sql-function.js';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

const sql = read('supabase/migrations/20261003105039_event_rpcs_tenant_checks.sql');
const types = read('src/types/database.generated.ts');

function body(name) {
  const start = sql.search(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${name}\\(`));
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
}

describe('dead, unguarded event RPCs are gone', () => {
  for (const name of ['gm_populate_event_participants_v2', 'gm_remove_member_from_active_events', 'gm_event_session_id']) {
    it(`${name} is dropped and absent from the generated types`, () => {
      expect(sql).toMatch(new RegExp(`DROP FUNCTION IF EXISTS public\\.${name}\\(`));
      expect(types).not.toContain(`${name}:`);
    });
  }
});

describe('the two live event RPCs check the tenant', () => {
  for (const name of ['gm_add_member_to_active_events', 'gm_populate_event_participants']) {
    it(`${name} gates browser callers on check_user_guild_write_access`, () => {
      const b = body(name);
      expect(b).toMatch(/IF auth\.uid\(\) IS NOT NULL AND NOT public\.check_user_guild_write_access\(v_target_guild\) THEN/);
      expect(b).toMatch(/RAISE EXCEPTION 'not_authorized' USING ERRCODE = 'insufficient_privilege'/);
      // The old role-only checks are gone: no reading the JWT e-mail or sub.
      expect(b).not.toMatch(/auth\.jwt\(\)/);
      expect(b).not.toMatch(/v_caller_role/);
    });
  }

  it('gm_populate_event_participants has no fallback tenant', () => {
    const b = body('gm_populate_event_participants');
    expect(b).not.toContain("'ALPHA'");
    expect(b).toMatch(/RAISE EXCEPTION 'guild_required'/);
  });

  it('keeps the parameter names the client sends', () => {
    expect(sql).toContain('CREATE FUNCTION public.gm_add_member_to_active_events(p_pseudo text, p_guild text)');
    expect(sql).toMatch(/gm_populate_event_participants\(\s*p_event_name text, p_session_id text, p_week_start date, p_guild text\s*\)/);
    // M4a: adding a member enrols it inside the same transaction.
    expect(sqlFunctionBody('gm_add_member')).toContain('public.gm_add_member_to_active_events(v_pseudo, v_guild)');
    const armsrace = read('src/modules/armsrace/armsrace.service.ts');
    for (const p of ['p_event_name', 'p_session_id', 'p_week_start', 'p_guild']) expect(armsrace).toContain(p);
  });

  it('is executable by signed-in users and the service role, not anon, and asserts it', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.gm_add_member_to_active_events\(text, text\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.gm_populate_event_participants\(text, text, date, text\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/has_function_privilege\('anon', 'public\.gm_add_member_to_active_events/);
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('refuses to overwrite a production body that drifted since it was read', () => {
    expect(sql).toContain("md5(v_def) <> 'fd86ca9512a4b9710a7f6fa24b7c74df'");
    expect(sql).toContain("md5(v_def) <> '407d41e4a110ae48e8a11bfe195de6e3'");
  });
});
