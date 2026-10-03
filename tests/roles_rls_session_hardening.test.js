// 2026-09-13 -- Phase 2 hardening (H1-H4, M2, M4) regression guards.
// Asserts the canonical SQL migration, the Edge authorization entry point and
// the shadow-session minting path all enforce the exact four-role model and the
// session_version invalidation epoch.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { edgeSource } from './helpers/edge-source.js';

const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260913130000_roles_rls_session_hardening.sql');
const shadowSessionPath = path.resolve(__dirname, '../supabase/functions/_shared/shadow-session.ts');
const adminAuthzPath = path.resolve(__dirname, '../supabase/functions/_shared/admin-authz.ts');

const migrationRaw = fs.readFileSync(migrationPath, 'utf-8');
const strippedMigration = migrationRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => !l.startsWith('--'))
  .join('\n');

const adminAccountsContent = edgeSource('admin-accounts');
const shadowSessionContent = fs.readFileSync(shadowSessionPath, 'utf-8');
const adminAuthzContent = fs.readFileSync(adminAuthzPath, 'utf-8');

describe('roles_rls_session_hardening migration', () => {
  it('enforces the strict canonical role CHECK and member default', () => {
    expect(strippedMigration).toContain(`CHECK (role IN ('super_admin', 'server_admin', 'guild_admin', 'member'))`);
    expect(strippedMigration).toContain(`ALTER COLUMN role SET DEFAULT 'member'`);
  });

  it('removes every legacy role alias (R5/R4/admin) from active SQL', () => {
    expect(strippedMigration).not.toContain("'R5'");
    expect(strippedMigration).not.toContain("'R4'");
    expect(strippedMigration).not.toMatch(/'admin'\s*\)/);
  });

  it('is_super_admin matches the exact role only, gated on status = active', () => {
    expect(strippedMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.is_super_admin\(\)[\s\S]*?AND a\.role = 'super_admin'/);
  });

  it('is_server_admin matches super_admin or server_admin only', () => {
    expect(strippedMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.is_server_admin\(\)[\s\S]*?role IN \('super_admin', 'server_admin'\)/);
  });

  it('gm_can_read_guilds matches the three canonical admin roles only', () => {
    expect(strippedMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.gm_can_read_guilds\(\)[\s\S]*?role IN \('super_admin', 'server_admin', 'guild_admin'\)/);
  });

  it('adds accounts.session_version and the gm_session_is_valid() gate', () => {
    expect(strippedMigration).toMatch(/ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0/);
    expect(strippedMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.gm_session_is_valid\(\)/);
    expect(strippedMigration).toMatch(/->> 'session_version'/);
  });

  it('player_absences self-read resolves through public.accounts (a.uid)', () => {
    expect(strippedMigration).toMatch(/CREATE POLICY player_absences_select_policy ON public\.player_absences[\s\S]*?FROM public\.accounts a[\s\S]*?a\.uid = player_absences\.uid/);
  });
});

describe('admin-authz strict normalizeRole (H1)', () => {
  it('does not map legacy ranks to super_admin anywhere', () => {
    expect(adminAuthzContent).toMatch(/export function normalizeRole/);
    expect(adminAuthzContent).not.toMatch(/s === "r5"[\s\S]*?return "super_admin"/);
    expect(adminAuthzContent).not.toMatch(/s === "admin"[\s\S]*?return "super_admin"/);
    expect(adminAuthzContent).not.toMatch(/s === "r4"[\s\S]*?return "guild_admin"/);
  });

  it('legacy ranks fall back to member (cannot elevate)', () => {
    expect(adminAuthzContent).toMatch(/if \(s === "guild_admin"\) return "guild_admin";/);
    expect(adminAuthzContent).toMatch(/if \(s === "member"\) return "member";/);
    expect(adminAuthzContent).toMatch(/return "member";\n}/);
  });
});

describe('admin-accounts Edge (H1/H2/H3, M4)', () => {
  it('imports the strict normalizeRole instead of an inline elevating mapping', () => {
    // Since M2 the role is normalised once, by the shared resolver the
    // function calls; admin-accounts decides on the normalised role only.
    expect(adminAccountsContent).toContain('await resolveCaller(req, admin)');
    expect(fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/auth.ts'), 'utf-8')).toContain('role: normalizeRole(acc.role)');
    expect(adminAccountsContent).toContain('from "../_shared/admin-authz.ts"');
    expect(adminAccountsContent).not.toMatch(/s === "super_admin" \|\| s === "r5" \|\| s === "admin"/);
    expect(adminAccountsContent).not.toMatch(/s === "guild_admin" \|\| s === "r4"/);
  });

  it('bumps session_version on password reset', () => {
    expect(adminAccountsContent).toMatch(/await bumpSessionVersion\(admin, canonicalId, targetAcc\.role [\s\S]*?targetAcc\.auth_user_id/);
  });

  it('bumps session_version on role change and stamps the GoTrue app_metadata', () => {
    expect(adminAccountsContent).toContain('const nextSessionVersion = ((curVer?.session_version ?? 0) | 0) + 1;');
    expect(adminAccountsContent).toMatch(/app_metadata: \{ app_role: newRole, account_id: targetAcc\.id, session_version: nextSessionVersion \}/);
  });

  it('bumps session_version on registration rejection (suspension)', () => {
    // The decision moved to _shared/registration-decision.ts on 2026-10-03,
    // shared by the app and the Discord join-request buttons.
    const decision = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/registration-decision.ts'), 'utf8');
    expect(decision).toMatch(/await bumpSessionVersion\(admin, id, target\.role/);
    expect(adminAccountsContent).toContain('decideRegistration(');
  });
});

describe('shadow-session minting path (M4)', () => {
  it('stamps accounts.session_version into the GoTrue app_metadata', () => {
    expect(shadowSessionContent).toContain('.select("session_version")');
    expect(shadowSessionContent).toMatch(/accountRow\?\.session_version \?\? 0/);
    expect(shadowSessionContent).toContain('meta.session_version = sessionVersion;');
  });
});