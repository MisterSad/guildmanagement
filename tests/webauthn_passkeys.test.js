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
