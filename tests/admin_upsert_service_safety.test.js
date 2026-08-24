// Regression guard for the 2026-08-24 account-creation outage: the v124.1 RPC
// lockdown gave gm_admin_upsert an unconditional caller gate, but its only
// production caller (admin-accounts Edge Function) invokes it with the service
// role where auth.uid() is NULL -> the gate raised 'Access denied' and every
// admin account creation returned "server_error" on live.
//
// The service-safe pattern (enforce the gate only when auth.uid() IS NOT NULL)
// was already used by gm_upsert_player_metrics and gm_reset_account_password
// in the same lockdown migration; gm_admin_upsert was the inconsistent one.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('Service-role safety of edge-called RPCs (v128.3)', () => {
  it('gm_admin_upsert guards its authorization gate behind auth.uid() IS NOT NULL', () => {
    const migration = read('supabase/migrations/20260824090000_guard_gm_admin_upsert_service_calls.sql');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.gm_admin_upsert');
    // The gate must only apply to authenticated (browser) calls
    expect(migration).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN[\s\S]*?IF NOT public\.is_super_admin\(\) THEN/);
    // Browser protections preserved: role ceiling + guild write access
    expect(migration).toMatch(/IF p_role IN \('super_admin', 'server_admin'\) THEN/);
    expect(migration).toContain('check_user_guild_write_access(p_guild)');
    // Grants hygiene + PostgREST reload
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.gm_admin_upsert/);
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('every W6-gated RPC called by edge functions with the service role is service-safe', () => {
    const lockdown = read('supabase/migrations/20260823060000_security_rpc_lockdown.sql');
    const edgeCalledGated = ['gm_upsert_player_metrics', 'gm_get_player_metrics_history', 'gm_personal_kpis', 'request_guild_transfer'];
    for (const fn of edgeCalledGated) {
      const start = lockdown.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
      expect(start, `${fn} must exist in the lockdown migration`).toBeGreaterThan(-1);
      const next = lockdown.indexOf('CREATE OR REPLACE FUNCTION', start + 10);
      const body = lockdown.slice(start, next === -1 ? undefined : next);
      expect(body, `${fn} must guard its gate with auth.uid() IS NOT NULL`).toContain('IF auth.uid() IS NOT NULL');
    }
    // gm_reset_account_password: same guard, verified against the lockdown file
    const rpStart = lockdown.indexOf('CREATE OR REPLACE FUNCTION public.gm_reset_account_password(');
    const rpNext = lockdown.indexOf('CREATE OR REPLACE FUNCTION', rpStart + 10);
    const rpBody = lockdown.slice(rpStart, rpNext === -1 ? undefined : rpNext);
    expect(rpBody).toContain('IF auth.uid() IS NOT NULL');
  });

  it('transfer_guild_member keeps its unconditional caller resolution (browser-only caller)', () => {
    const lockdown = read('supabase/migrations/20260823060000_security_rpc_lockdown.sql');
    const start = lockdown.indexOf('CREATE OR REPLACE FUNCTION public.gm_transfer_guild_member(');
    const next = lockdown.indexOf('CREATE OR REPLACE FUNCTION', start + 10);
    const body = lockdown.slice(start, next === -1 ? undefined : next);
    // Browser-only RPC: resolves the caller inline from auth.uid() with NO
    // service-role bypass (a service call would resolve no caller and fail
    // with a structured error instead of performing the transfer).
    expect(body).toContain('WHERE a.auth_user_id = auth.uid() AND a.status');
    expect(body).not.toContain('IF auth.uid() IS NOT NULL');
  });
});
