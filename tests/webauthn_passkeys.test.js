// Regression guard for the Passkeys/WebAuthn foundation migration
// (supabase/migrations/20260901000000_webauthn_passkeys.sql): the 3 new
// tables, their columns/constraints, and the deliberate zero-policy RLS
// (service_role-only access via the auth-passkey Edge Function).

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260901000000_webauthn_passkeys.sql');
const content = fs.readFileSync(migrationPath, 'utf-8');

describe('WebAuthn passkeys migration', () => {
  it('creates webauthn_challenges scoped to a ceremony type with a short expiry', () => {
    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.webauthn_challenges');
    expect(content).toContain('REFERENCES public.accounts(id) ON DELETE CASCADE');
    expect(content).toMatch(/ceremony_type TEXT NOT NULL CHECK \(ceremony_type IN \('registration', 'authentication'\)\)/);
    expect(content).toContain("expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes')");
  });

  it('creates account_passkeys with a unique credential_id and an editable device_label', () => {
    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.account_passkeys');
    expect(content).toContain('credential_id TEXT NOT NULL UNIQUE');
    expect(content).toContain('public_key TEXT NOT NULL');
    expect(content).toContain('sign_count BIGINT NOT NULL DEFAULT 0');
    expect(content).toContain('device_label TEXT NOT NULL');
    expect(content).toContain('CREATE INDEX IF NOT EXISTS idx_account_passkeys_account ON public.account_passkeys(account_id)');
  });

  it('creates account_backup_codes with a unique hash and a used_at redemption marker', () => {
    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.account_backup_codes');
    expect(content).toContain('code_hash TEXT NOT NULL UNIQUE');
    expect(content).toContain('used_at TIMESTAMPTZ');
    expect(content).toContain('CREATE INDEX IF NOT EXISTS idx_account_backup_codes_account ON public.account_backup_codes(account_id)');
  });

  it('enables RLS on all 3 tables with zero policies — access is service_role-only via auth-passkey', () => {
    expect(content).toContain('ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY');
    expect(content).toContain('ALTER TABLE public.account_passkeys ENABLE ROW LEVEL SECURITY');
    expect(content).toContain('ALTER TABLE public.account_backup_codes ENABLE ROW LEVEL SECURITY');
    expect(content).not.toMatch(/CREATE POLICY/);
  });

  it('reloads PostgREST schema cache at the end', () => {
    expect(content.trim().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });
});

describe('auth-passkey Edge Function — admin-reset-passkeys authorization', () => {
  const fnPath = path.resolve(__dirname, '../supabase/functions/auth-passkey/index.ts');
  const fnContent = fs.readFileSync(fnPath, 'utf-8');

  it('requires an authenticated identity before admin-reset-passkeys is reachable', () => {
    // The action must be defined after the `const identity = await getIdentity(...)`
    // gate, not among the unauthenticated login-flow actions above it.
    const identityGateIdx = fnContent.indexOf('const identity = await getIdentity(req, admin);');
    const actionIdx = fnContent.indexOf('if (action === "admin-reset-passkeys")');
    expect(identityGateIdx).toBeGreaterThan(-1);
    expect(actionIdx).toBeGreaterThan(identityGateIdx);
  });

  it('gates the reset on the same canManageAccount matrix reset-password uses, not a looser check', () => {
    expect(fnContent).toContain('import { canManageAccount, type Role } from "../_shared/admin-authz.ts"');
    const actionBody = fnContent.slice(fnContent.indexOf('if (action === "admin-reset-passkeys")'));
    expect(actionBody).toContain('canManageAccount(callerCtx, targetCtx)');
    expect(actionBody).toMatch(/if \(!canManageAccount\(callerCtx, targetCtx\)\) \{\s*[\s\S]*?return json\(\{ ok: false, error: "forbidden" \}, 403\);/);
  });

  it('revokes passkeys, backup codes, and pending challenges together, not just one table', () => {
    const actionBody = fnContent.slice(fnContent.indexOf('if (action === "admin-reset-passkeys")'));
    expect(actionBody).toContain('admin.from("account_passkeys").delete().eq("account_id", targetAcc.id)');
    expect(actionBody).toContain('admin.from("account_backup_codes").delete().eq("account_id", targetAcc.id)');
    expect(actionBody).toContain('admin.from("webauthn_challenges").delete().eq("account_id", targetAcc.id)');
  });
});
