// Short-term plan, phase 6: erasure that the operator can actually run, no new
// reversible password copies, no fallback to a real tenant, and a privacy
// policy that says what the system does.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dir = path.join(root, 'supabase/migrations');
const file = fs.readdirSync(dir).find((f) => f.endsWith('_privacy_erasure_and_credentials.sql'));
const sql = read(`supabase/migrations/${file}`);

function body(name) {
  const s = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(s, name).toBeGreaterThan(-1);
  return sql.slice(s, sql.indexOf('$function$;', s));
}

describe('GDPR erasure', () => {
  it('gm_erase_player runs for the operator, without a session (BE-B-12)', () => {
    const b = body('gm_erase_player');
    expect(b).toContain('IF auth.uid() IS NOT NULL AND NOT public.check_user_guild_write_access(p_guild) THEN');
    expect(b).not.toMatch(/IF NOT public\.check_user_guild_write_access\(p_guild\) THEN/);
  });

  it('gm_erase_player also clears the game identifier from the claiming account', () => {
    expect(body('gm_erase_player')).toMatch(/UPDATE public\.accounts\s+SET uid = NULL\s+WHERE uid = p_uid AND guild = p_guild;/);
  });

  it('gm_erase_account strips the account identifier from the kept sign-in record', () => {
    const b = body('gm_erase_account');
    expect(b).toContain("raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) - 'account_id' - 'app_role'");
    // auth.users is never deleted (owner decision): sessions are revoked instead.
    expect(b).not.toMatch(/DELETE FROM auth\.users/);
    expect(b).toContain('PERFORM public.gm_revoke_auth_sessions(v_auth);');
  });

  it('neither erasure is executable by anon', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.gm_erase_player(text, text) FROM PUBLIC, anon;');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.gm_erase_account(text) FROM PUBLIC, anon;');
  });
});

describe('no reversible password copy is written any more (C0)', () => {
  it('the three writers store the bcrypt hash only', () => {
    for (const fn of ['gm_admin_upsert', 'gm_register_player', 'gm_reset_account_password']) {
      expect(body(fn), fn).not.toContain('pgp_sym_encrypt');
      expect(body(fn), fn).toContain("extensions.crypt(p_password, extensions.gen_salt('bf', 10))");
    }
    expect(body('gm_reset_account_password')).toContain('SET password_enc = NULL,');
  });

  it('a successful sign-in drops the copy', () => {
    expect(body('gm_verify_password')).toMatch(/last_login_at = now\(\),\s+password_enc = NULL/);
  });

  it('existing copies go only where the hash verifies the same password', () => {
    expect(sql).toContain('extensions.crypt(extensions.pgp_sym_decrypt(v_row.password_enc, v_key), v_row.password_hash)');
    expect(sql).toContain('= v_row.password_hash;');
    expect(sql).toContain("RAISE EXCEPTION 'a function still writes a reversible password copy'");
  });
});

describe('no fallback to a real tenant (AGENTS.md)', () => {
  it('gm_list_event_sessions lists nothing when the guild is unresolved', () => {
    const b = body('gm_list_event_sessions');
    expect(b).not.toContain("'ALPHA'),");
    expect(b).not.toMatch(/COALESCE\([^)]*'ALPHA'\)/);
    expect(b).toMatch(/IF v_target_guild IS NULL OR v_target_guild = '' THEN\s+RETURN;/);
  });

  it('the end-state check refuses any ALPHA fallback left in the three functions', () => {
    expect(sql).toContain("RAISE EXCEPTION 'a function still falls back to the ALPHA tenant'");
  });
});

describe('privacy.html says what the system does', () => {
  const policy = read('privacy.html');

  it('discloses the transient storage of screen recordings and Google\'s 48-hour limit', () => {
    expect(policy).toContain('3.2. Screenshots and screen recordings.');
    expect(policy).toContain('automatically within 48 hours');
    expect(policy).not.toContain('no disk persistence and no object storage');
  });

  it('describes partitioning for all three administrative roles', () => {
    expect(policy).toContain('a server administrator, the guilds of their game server');
  });

  it('describes account erasure exactly, including the kept sign-in record', () => {
    expect(policy).toContain('every open session is ended');
    expect(policy).toContain('computed one-way from the former account identifier');
    expect(policy).not.toContain('all associated authentication material are deleted');
  });

  it('no longer claims passwords may be stored encrypted, except the legacy copies it names', () => {
    expect(policy).toContain('authentication material hashed at rest;');
    expect(policy).toContain('remains only for accounts that have not signed in since 3 October 2026');
  });
});
