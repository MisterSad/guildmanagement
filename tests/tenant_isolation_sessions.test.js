// Short-term plan, phase 2: tenant isolation and session revocation
// (audit SEC-05, SEC-07, SEC-08, DB-05, DB-06, DB-07, BE-B-06, BE-B-07, BE-B-21).
//
// Verified on production before applying, in a rolled-back transaction under
// DEMO identities:
//   valid session -> caller guild DEMO, absences true, 40 sessions listed;
//   stale session -> NULL, false, 0;
//   a member's transfer -> unauthorized;
//   wiki: spoofed author replaced by the real one, rewriting the author refused
//   (42501), a spoofed super_admin comment stamped guild_admin, another guild's
//   page readable but its update and delete touching 0 rows;
//   banned UID: insert and UID change refused, an unrelated update accepted;
//   guild deletion: the server_admin kept, detached, with its server;
//   orphan identities: 0 sessions left, 204 identities kept.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');
const sql = read('supabase/migrations/20261003113839_tenant_isolation_and_sessions.sql');

describe('session revocation reaches every caller lookup (BE-B-07, DB-06)', () => {
  it('injects the session check into the inline lookups and asserts none is left', () => {
    expect(sql).toContain("'auth_user_id = auth.uid() AND (SELECT public.gm_session_is_valid())'");
    expect(sql).toContain("RAISE EXCEPTION 'a function still resolves its caller without a session check'");
    expect(sql).toContain("RAISE EXCEPTION 'a policy still resolves its caller without a session check'");
    for (const fn of [
      'gm_transfer_guild_member(text,text,text)',
      'resolve_guild_transfer(uuid,text)',
      'gm_reset_account_password(text,text)',
    ]) {
      expect(sql).toContain(`'${fn}'`);
    }
  });

  it('absences: same audience, no e-mail match, no ALPHA fallback', () => {
    const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.gm_can_admin_see_absences');
    const body = sql.slice(start, sql.indexOf('$$;', start));
    expect(body).toContain('(SELECT public.gm_session_is_valid())');
    expect(body).toContain("a.role = 'guild_admin'");
    expect(body).not.toMatch(/ALPHA|auth\.jwt/);
  });
});

describe('a member cannot move players (SEC-05)', () => {
  it('adds an officer-only gate to gm_transfer_guild_member, checked against the live md5', () => {
    expect(sql).toContain("md5(v_def) <> 'fd0994eaea64352d1d35bdb9194dfdba'");
    expect(sql).toContain("IF v_caller_role NOT IN (''super_admin'', ''server_admin'', ''guild_admin'') THEN");
  });
});

// The migration wiki block (SEC-08, DB-07) went with the Migration Hub, removed on 2026-11-06.

describe('banned players stay off the roster (BE-B-06)', () => {
  it('refuses a banned UID on insert and on a guild or UID change', () => {
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF guild, uid ON public.guild_members');
    expect(sql).toContain("RAISE EXCEPTION 'uid_banned' USING ERRCODE = 'check_violation'");
    expect(sql).toMatch(
      /AND NEW\.guild IS NOT DISTINCT FROM OLD\.guild\s+AND NEW\.uid IS NOT DISTINCT FROM OLD\.uid THEN\s+RETURN NEW;/
    );
  });
});

describe('deleting an account ends its sessions (SEC-07, BE-B-21, DB-05)', () => {
  it('revokes sessions on guild deletion and GDPR erasure, service-role only', () => {
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.gm_revoke_auth_sessions(uuid) TO service_role;');
    expect(sql).toContain('DELETE FROM auth.sessions WHERE user_id = p_auth_user_id;');
    expect(sql).toContain('DELETE FROM auth.refresh_tokens WHERE user_id = p_auth_user_id::text;');
    expect(sql).toContain("RAISE EXCEPTION 'guild deletion still deletes server_admin accounts or leaves sessions'");
    expect(sql).toContain("RAISE EXCEPTION 'GDPR erasure still leaves sessions'");
  });

  it('bumpSessionVersion ends the sessions instead of re-stamping the next token only', () => {
    const src = read('supabase/functions/_shared/registration-decision.ts');
    const fn = src.slice(
      src.indexOf('export async function bumpSessionVersion('),
      src.indexOf('export async function getTargetCtx(')
    );
    expect(fn).toContain('admin.rpc("gm_revoke_auth_sessions", { p_auth_user_id: authUserId })');
  });
});
