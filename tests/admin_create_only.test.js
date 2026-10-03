// Regression guard for audit finding SEC-01 (2026-10-03): account takeover
// through account creation.
//
// gm_admin_upsert ended in `ON CONFLICT (id) DO UPDATE` and was executable by
// `authenticated`; admin-accounts `create` called it after re-keying the
// existing shadow user. Any guild_admin could "create" the super_admin's id and
// receive a working password for it. Creation is now create-only, the account
// row is claimed before the shadow user is touched, and browsers cannot call
// the RPC at all.

import { describe, it, expect } from 'vitest';
import { edgeSource, edgeFunctionBody } from './helpers/edge-source.js';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

const MIGRATION = 'supabase/migrations/20261003090434_admin_create_only_and_demo_credentials.sql';

function fnBody(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('$$;', start);
  return sql.slice(start, end);
}

describe('gm_admin_upsert is create-only', () => {
  const sql = read(MIGRATION);
  const body = fnBody(sql, 'gm_admin_upsert');

  it('can no longer overwrite an existing account', () => {
    expect(body).not.toMatch(/ON CONFLICT/i);
    expect(body).not.toMatch(/\bUPDATE\b/i);
  });

  it('refuses a taken id case-insensitively, with the unique_violation SQLSTATE', () => {
    expect(body).toMatch(/lower\(a\.id\) = lower\(v_id\)/);
    expect(body).toMatch(/RAISE EXCEPTION 'account_exists' USING ERRCODE = 'unique_violation'/);
  });

  it('always requires a password', () => {
    expect(body).toMatch(/RAISE EXCEPTION 'password_required'/);
  });

  it('is executable by the service role only, and asserts it', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.gm_admin_upsert\(text, text, text, text\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.gm_admin_upsert\(text, text, text, text\) TO service_role;/);
    expect(sql).toMatch(/has_function_privilege\('authenticated', 'public\.gm_admin_upsert/);
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

describe('admin-accounts claims the id before touching the shadow user', () => {
  const src = edgeSource('admin-accounts');
  const helper = edgeFunctionBody('admin-accounts', 'provisionNewAccount');
  const helperStart = src.indexOf(helper);
  const helperEnd = helperStart + helper.length;

  it('creates the account row first, then the shadow user, then attaches it', () => {
    expect(helperStart).toBeGreaterThan(-1);
    const rpc = helper.indexOf('admin.rpc("gm_admin_upsert"');
    const createUser = helper.indexOf('admin.auth.admin.createUser(');
    const reKey = helper.indexOf('admin.auth.admin.updateUserById(');
    const attach = helper.indexOf('admin.rpc("gm_attach_shadow"');
    expect(rpc).toBeGreaterThan(-1);
    expect(createUser).toBeGreaterThan(rpc);
    expect(reKey).toBeGreaterThan(rpc);
    expect(attach).toBeGreaterThan(createUser);
  });

  it('stops on a taken id before any GoTrue call', () => {
    const rpc = helper.indexOf('admin.rpc("gm_admin_upsert"');
    const createUser = helper.indexOf('admin.auth.admin.createUser(');
    const guard = helper.slice(rpc, createUser);
    expect(guard).toMatch(/uErr\.code === "23505"/);
    expect(guard).toMatch(/return \{ ok: false, error: "account_exists"/);
  });

  it('is the only place that provisions an account', () => {
    const outside = src.slice(0, helperStart) + src.slice(helperEnd);
    expect(outside).not.toContain('admin.rpc("gm_admin_upsert"');
    // create and approve-guild-request both go through it.
    expect(outside.match(/provisionNewAccount\(admin, logger,/g)).toHaveLength(2);
  });
});

describe('the admin UI explains a refused duplicate', () => {
  it('maps account_exists to the duplicate-identifier toast', () => {
    const ctrl = read('src/modules/app/admin/accounts.controller.ts');
    expect(ctrl).toMatch(/code === 'account_exists'\) return t\('toast_duplicate_account'\)/);
    expect(ctrl.match(/throw new Error\(createErrorMessage\(res\.error\)\)/g)).toHaveLength(2);
  });
});
