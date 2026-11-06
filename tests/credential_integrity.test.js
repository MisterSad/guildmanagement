// Phase D1 of the Discord-authentication migration: credential integrity.
//
// Three defects, all confirmed against the live production database before the
// migration was written:
//
//  1. `gm_reset_account_password` and `gm_admin_upsert` wrote only
//     `password_enc`, never `password_hash` -- while the login checks
//     `password_hash` FIRST. So after an admin reset, the OLD password kept
//     working indefinitely, alongside the new one.
//
//  2. Fixing (1) naively is worse than the bug. `src/core/auth/session.ts` calls
//     `gm_admin_upsert` with an EMPTY password as a role-sync fallback. Writing
//     `crypt('', gen_salt(...))` there would make the empty string a valid
//     password for that account, because `crypt('', hash) = hash`.
//
//  3. `member-portal`'s getIdentity read `player_uid` from `gm_get_shadow`,
//     which does not return that column -- so the value was always undefined
//     and the code always fell through to `acc.uid || accountId`, after paying
//     for one round trip and one pgp_sym_decrypt of the shadow secret per
//     request.
//
// These guards exist so the fixes cannot silently regress while the password
// path is still load-bearing: the account-claim flow reuses it as a one-time
// proof of ownership.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { edgeSource } from './helpers/edge-source.js';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

const migration = read('supabase/migrations/20260926101947_credential_integrity.sql');

/** Slice one CREATE OR REPLACE FUNCTION body out of a migration. */
function fnBody(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} must be defined in the migration`).toBeGreaterThan(-1);
  const next = sql.indexOf('CREATE OR REPLACE FUNCTION', start + 10);
  return sql.slice(start, next === -1 ? undefined : next);
}

describe('gm_verify_password is the single password implementation', () => {
  const body = fnBody(migration, 'gm_verify_password');

  it('keeps the dual-read, the lazy bcrypt upgrade and the lockout', () => {
    expect(body).toContain('extensions.crypt(p_password, v_acc.password_hash)');
    expect(body).toContain('extensions.pgp_sym_decrypt(v_acc.password_enc, v_key)');
    expect(body).toMatch(/SET password_hash = extensions\.crypt\(p_password, extensions\.gen_salt\('bf', 10\)\)/);
    // Atomic increment, never derived from the stale snapshot.
    expect(body).toContain('failed_login_count = public.accounts.failed_login_count + 1');
    expect(body).toContain("interval '15 minutes'");
  });

  it('preserves the hardened function settings', () => {
    expect(body).toContain("SET search_path TO ''");
    expect(body).toContain("SET lock_timeout TO '2s'");
    expect(body).toContain("SET statement_timeout TO '5s'");
    expect(body).toContain('SECURITY DEFINER');
  });

  it('refuses an account whose credentials were destroyed by a Discord claim', () => {
    // Both columns NULL must fail closed rather than fall through to a
    // comparison. This is what makes the claim flow's password destruction safe.
    expect(body).toMatch(/password_hash IS NULL OR v_acc\.password_hash = ''\)[\s\S]*?password_enc IS NULL/);
  });

  it('is reachable only by service_role', () => {
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.gm_verify_password\(text, text\) FROM PUBLIC, anon, authenticated/
    );
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.gm_verify_password\(text, text\) TO service_role/);
  });

  it('gm_check_login delegates to it instead of holding a second copy', () => {
    const login = fnBody(migration, 'gm_check_login');
    expect(login).toContain('SELECT * FROM public.gm_verify_password(p_id, p_password)');
    // The duplicated logic must be gone from the login wrapper.
    expect(login).not.toContain('pgp_sym_decrypt');
    expect(login).not.toContain('failed_login_count = public.accounts.failed_login_count + 1');
  });
});

describe('gm_reset_account_password writes both credential columns', () => {
  const body = fnBody(migration, 'gm_reset_account_password');

  it('updates password_hash as well as password_enc', () => {
    // Without this, the stale bcrypt hash kept the OLD password valid.
    expect(body).toContain('password_hash = extensions.crypt(p_password, extensions.gen_salt');
    expect(body).toContain('password_enc = extensions.pgp_sym_encrypt(');
  });

  it('clears the lockout counters, since a reset means "let them back in"', () => {
    expect(body).toContain('failed_login_count = 0');
    expect(body).toContain('locked_until = NULL');
  });

  it('keeps its service-role safety guard and its authorization matrix', () => {
    expect(body).toContain('IF auth.uid() IS NOT NULL THEN');
    expect(body).toContain('length(p_password) < 6');
    expect(body).toMatch(/v_target_role = 'super_admin'/);
  });
});

describe('gm_admin_upsert never writes a bcrypt hash of an empty password', () => {
  const body = fnBody(migration, 'gm_admin_upsert');

  it('detects whether a real password was supplied', () => {
    expect(body).toContain('v_has_password := (p_password IS NOT NULL AND length(TRIM(p_password)) > 0)');
  });

  it('leaves BOTH credential columns untouched on an empty-password update', () => {
    // src/core/auth/session.ts calls this with p_password: '' for role syncs.
    // Writing crypt('', ...) there would make the empty string a valid password.
    expect(body).toMatch(
      /password_enc\s*=\s*CASE WHEN v_has_password THEN EXCLUDED\.password_enc\s*ELSE public\.accounts\.password_enc\s*END/
    );
    expect(body).toMatch(
      /password_hash\s*=\s*CASE WHEN v_has_password THEN EXCLUDED\.password_hash\s*ELSE public\.accounts\.password_hash\s*END/
    );
  });

  it('refuses to create a brand-new account with no credential at all', () => {
    expect(body).toContain("RAISE EXCEPTION 'password_required'");
    expect(body).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.accounts a WHERE a\.id = TRIM\(p_id\)\)/);
  });

  it('writes password_hash alongside password_enc when a password IS supplied', () => {
    expect(body).toContain('CASE WHEN v_has_password THEN extensions.crypt(p_password, extensions.gen_salt');
    expect(body).toContain('CASE WHEN v_has_password THEN extensions.pgp_sym_encrypt(p_password, v_key)');
  });

  it('keeps the service-role safety guard from the 2026-08-24 outage fix', () => {
    expect(body).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN[\s\S]*?IF NOT public\.is_super_admin\(\) THEN/);
    expect(body).toContain('check_user_guild_write_access(p_guild)');
  });
});

describe('member-portal no longer decrypts the shadow secret on every request', () => {
  const portal = edgeSource('member-portal');
  const start = portal.indexOf('async function getIdentity(');
  const body = portal.slice(start, portal.indexOf('\n}', start));
  // Comments are stripped before asserting absence: the function documents WHY
  // the gm_get_shadow call was removed, and naming it in prose must not fail
  // the very assertion that proves it is gone.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('resolves the player UID from the caller resolved by _shared/auth.ts', () => {
    expect(code).toContain('const caller = await resolveCaller(req, admin);');
    // The player is the UID the account claimed, never its account id: that
    // fallback let an account named after another guild's player act as them
    // (SEC2-01). member-portal/index.test.ts runs the refusal.
    expect(code).toContain('uid: caller.uid ?? null,');
    expect(code).not.toMatch(/caller\.uid\s*\|\|\s*caller\.accountId/);
  });

  it('makes no gm_get_shadow call and reads no player_uid field', () => {
    expect(code).not.toContain('gm_get_shadow');
    expect(code).not.toMatch(/row\?\.player_uid/);
  });
});
