// Passkeys are removed entirely (owner decision, restated 2026-10-03). Sign-in
// is Discord, with ID + password kept during the transition. The super_admin's
// recovery codes belong to the Discord flow and stay.
//
// The UI went on 2026-09-27, but auth-passkey stayed deployed, so the accounts
// holding a passkey could still sign in with it through the API. These checks
// keep every layer from growing one back.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');
const exists = (p) => fs.existsSync(path.resolve(root, p));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : (/\.(ts|js)$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

describe('no passkey code in the app', () => {
  it('deletes the WebAuthn service and the passkey panel', () => {
    expect(exists('src/core/auth/webauthn.service.ts')).toBe(false);
    expect(exists('src/modules/auth/PasskeysPanel.ts')).toBe(false);
  });

  it('calls no WebAuthn API and no passkey helper anywhere in src/', () => {
    const offenders = [];
    for (const f of walk(path.join(root, 'src'))) {
      if (f.endsWith('database.generated.ts')) continue;
      const src = fs.readFileSync(f, 'utf-8');
      if (/navigator\.credentials|PublicKeyCredential|GM\.webauthn|\.webauthn\b|auth-passkey|loginWithPasskey|ConditionalPasskey|wirePasskeyLoginButton|adminResetPasskeys|maybeShowSecureAccountPrompt/.test(src)) {
        offenders.push(path.relative(root, f));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no longer asks the browser for passkey autofill on the sign-in form', () => {
    expect(read('index.html')).not.toMatch(/autocomplete="[^"]*webauthn/);
  });

  it('keeps the Discord recovery codes for the super_admin', () => {
    const session = read('src/core/auth/session.ts');
    expect(session).toContain('export async function loginWithBackupCodeDiscord(');
  });
});

describe('no passkey path on the server', () => {
  it('auth-passkey is deleted, from the platform (2026-10-03) and from the repository', () => {
    expect(exists('supabase/functions/auth-passkey')).toBe(false);
    expect(read('supabase/config.toml')).not.toContain('[functions.auth-passkey]');
  });

  it('auth-login no longer reads or reports passkeys', () => {
    const src = read('supabase/functions/auth-login/index.ts');
    expect(src).not.toMatch(/account_passkeys|has_passkey/);
  });

  it('the migration drops both tables after repairing their dependents, and keeps backup codes', () => {
    const sql = read('supabase/migrations/20261003165501_remove_passkeys.sql');
    expect(sql).toContain('DROP TABLE IF EXISTS public.webauthn_challenges;');
    expect(sql).toContain('DROP TABLE IF EXISTS public.account_passkeys;');
    expect(sql.indexOf('CREATE OR REPLACE FUNCTION public.gm_purge_discord_ephemera()'))
      .toBeLessThan(sql.indexOf('DROP TABLE IF EXISTS public.account_passkeys;'));
    expect(sql).toContain("RAISE EXCEPTION 'a function still names a dropped passkey table'");
    expect(sql).toContain("RAISE EXCEPTION 'the super_admin recovery codes must survive'");
  });
});
