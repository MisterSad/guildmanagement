// Phase D3: the claim.
//
// This is the irreversible step — a successful claim destroys the password,
// its reversible copy, every passkey and every backup code, in the same
// transaction that creates the Discord link. 165 accounts will pass through
// it. Everything asserted here is either a property that keeps someone from
// being locked out, or one that keeps the endpoint from being a usable
// password-guessing oracle.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const migration = read('supabase/migrations/20260926210000_discord_claim.sql');
const claimFn = migration.slice(
  migration.indexOf('FUNCTION public.gm_claim_account_with_discord'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.gm_check_discord_throttle')
);
const discordFn = stripComments(read('supabase/functions/auth-discord/index.ts'));
const controller = stripComments(read('src/modules/app/auth/auth.controller.ts'));
const session = stripComments(read('src/core/auth/session.ts'));

describe('the claim reuses the one password check', () => {
  it('delegates to gm_verify_password instead of re-implementing it', () => {
    // D1 extracted this from gm_check_login precisely so the transition could
    // not grow a second, divergent credential check.
    expect(claimFn).toContain('FROM public.gm_verify_password(p_id, p_password)');
    // No bcrypt, no crypt(), no hand-rolled comparison anywhere in the claim.
    expect(claimFn).not.toMatch(/crypt\(|password_hash\s*=\s*crypt|digest\(/);
  });

  it('honours lockout and non-active status', () => {
    expect(claimFn).toContain('account_locked');
    expect(claimFn).toContain('pending_approval');
  });
});

describe('what a claim destroys', () => {
  it('removes the password AND its reversible copy', () => {
    // password_enc is the plaintext-recoverable column finding C0 was about.
    // A claim retires it for that account permanently.
    expect(claimFn).toMatch(/SET password_hash\s*=\s*NULL,\s*\n?\s*password_enc\s*=\s*NULL/);
  });

  it('removes passkeys, in-flight ceremonies and backup codes', () => {
    for (const t of ['account_passkeys', 'webauthn_challenges', 'account_backup_codes']) {
      expect(claimFn, `${t} must be cleared`).toContain(`DELETE FROM public.${t}`);
    }
  });

  it('bumps session_version in the same transaction', () => {
    expect(claimFn).toContain('session_version = COALESCE(session_version, 0) + 1');
  });

  it('creates the link and destroys the credentials atomically', () => {
    // One transaction, so a crash cannot leave an account with neither a
    // password nor a link — which would be an account nobody can enter.
    const insertAt = claimFn.indexOf('INSERT INTO public.discord_account_links');
    const destroyAt = claimFn.indexOf('SET password_hash');
    expect(insertAt).toBeGreaterThan(-1);
    expect(destroyAt).toBeGreaterThan(insertAt);
    // No COMMIT in between: a plpgsql function body is one transaction.
    expect(claimFn.slice(insertAt, destroyAt)).not.toMatch(/COMMIT|ROLLBACK/);
  });
});

describe('the ordering that must not be inverted', () => {
  it('bumps session_version inside the RPC, and mints the session after', () => {
    // establishShadowSession re-reads session_version fresh, so the token it
    // mints carries the new epoch and older ones die. The reverse order would
    // sign the person out at the exact moment of their claim.
    const fn = discordFn.slice(discordFn.indexOf('async function handleClaim'));
    const rpcAt = fn.indexOf('gm_claim_account_with_discord');
    const shadowAt = fn.indexOf('establishShadowSession');
    expect(rpcAt).toBeGreaterThan(-1);
    expect(shadowAt).toBeGreaterThan(rpcAt);
  });

  it('issues fresh backup codes for a super_admin, before the session', () => {
    // The claim just deleted the old set, and a super_admin has no
    // administrator above them to unlink and reissue. They must leave this
    // request holding codes.
    const fn = discordFn.slice(discordFn.indexOf('async function handleClaim'));
    expect(fn).toContain('role === "super_admin"');
    expect(fn).toContain('issueBackupCodes(admin, accountId)');
    expect(fn.indexOf('issueBackupCodes')).toBeLessThan(fn.indexOf('establishShadowSession'));
    expect(fn).toContain('backup_codes: backupCodes');
  });

  it('does not fail the claim when code issuance fails', () => {
    // The account has already been converted; refusing the session here would
    // strand it for no benefit.
    const fn = discordFn.slice(discordFn.indexOf('async function handleClaim'));
    const block = fn.slice(fn.indexOf('issueBackupCodes'));
    expect(block.slice(0, 400)).toContain('catch');
  });
});

describe('the claim is not a usable password oracle', () => {
  it('spends a ticket per attempt', () => {
    // A ticket costs a full Discord round trip, which is the dominant cost to
    // an attacker — but it is not a budget, which is why the two below exist.
    const fn = discordFn.slice(discordFn.indexOf('async function handleClaim'));
    expect(fn).toContain('consumeTicket(admin, parsed.data.ticket, logger)');
  });

  it('has a tighter per-IP budget than the other actions', () => {
    expect(discordFn).toMatch(/CLAIM_IP_LIMIT = \{ limit: 20, windowMs: 300_000 \}/);
    expect(discordFn).toMatch(/IP_LIMIT = \{ limit: 60, windowMs: 300_000 \}/);
    const fn = discordFn.slice(discordFn.indexOf('async function handleClaim'));
    expect(fn).toContain('CLAIM_IP_LIMIT');
    expect(fn).not.toContain('throttled(req, admin, logger, "claim")');
  });

  it('also budgets the Discord account, so rotating IPs buys nothing', () => {
    const fn = discordFn.slice(discordFn.indexOf('async function handleClaim'));
    expect(fn).toContain('gm_check_discord_throttle');
    expect(fn).toContain('p_discord_user_id: consumed.discordUserId');
    expect(discordFn).toMatch(/CLAIM_DISCORD_LIMIT = \{ limit: 10, windowMs: 3_600_000 \}/);
  });

  it('keeps that budget separate from screenshot recognition', () => {
    // Sharing discord_verification_throttle would let OCR scans throttle
    // sign-ins, and vice versa.
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.discord_auth_throttle');
    const throttleFn = migration.slice(migration.indexOf('FUNCTION public.gm_check_discord_throttle'), migration.indexOf('FUNCTION public.gm_claim_account_with_discord'));
    expect(throttleFn).toContain('public.discord_auth_throttle');
    expect(throttleFn).not.toContain('discord_verification_throttle');
  });

  it('checks the Discord budget before verifying the password', () => {
    const fn = discordFn.slice(discordFn.indexOf('async function handleClaim'));
    expect(fn.indexOf('gm_check_discord_throttle')).toBeLessThan(fn.indexOf('gm_claim_account_with_discord'));
  });
});

describe('bijection and idempotence', () => {
  it('refuses an account that is already linked', () => {
    expect(claimFn).toContain('already_linked');
  });

  it('refuses a Discord identity attached elsewhere', () => {
    expect(claimFn).toContain('discord_already_linked');
  });
});

describe('least privilege and retention', () => {
  it('keeps both new functions off anon and authenticated', () => {
    const esc = (x) => x.replace(/[.()]/g, '\\$&');
    for (const f of ['gm_check_discord_throttle(text, integer, bigint, timestamptz)', 'gm_claim_account_with_discord(text, text, text)']) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc(f)}\\s+FROM PUBLIC, anon, authenticated;`));
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc(f)}\\s+TO service_role;`));
    }
  });

  it('makes the throttle table deny-all and prunes it', () => {
    expect(migration).toContain('ALTER TABLE public.discord_auth_throttle ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('ALTER TABLE public.discord_auth_throttle FORCE  ROW LEVEL SECURITY;');
    expect(migration).toContain('discord-auth-throttle-retention');
  });

  it('ships a progress view that does not elevate', () => {
    // The cutover date depends on this number, so it gets one definition.
    expect(migration).toContain('CREATE OR REPLACE VIEW public.gm_discord_claim_progress');
    expect(migration).toContain('WITH (security_invoker = true)');
    expect(migration).toContain('REVOKE ALL ON public.gm_discord_claim_progress FROM anon, authenticated;');
  });
});

describe('the dialog offers both ways in, and warns before the irreversible one', () => {
  const dialog = controller.slice(controller.indexOf('export function openLinkAccountDialog'), controller.indexOf('function linkErrorMessage'));

  it('offers the claim alongside the other three ways in', () => {
    // Phase D4 turned this into a four-path chooser: claim, code, join a
    // guild, create a guild. Four genuinely different people arrive here.
    expect(dialog).toContain('claimWithDiscord(ticket, id, password)');
    expect(dialog).toContain('redeemLinkCode(ticket, code)');
    expect(dialog).toContain("onboardWithDiscord(ticket, 'join'");
    expect(dialog).toContain("onboardWithDiscord(ticket, 'create'");
    expect(dialog).toContain('I already have an account');
    expect(dialog).toContain('I have a code');
  });

  it('says plainly that the password will be removed', () => {
    expect(dialog).toContain('Discord becomes the only way in');
    expect(dialog).toContain('Your password and any passkeys are removed');
  });

  it('shows a super_admin their new backup codes once', () => {
    expect(dialog).toContain('showBackupCodesOnce(resp.backupCodes)');
    const shower = controller.slice(controller.indexOf('function showBackupCodesOnce'));
    expect(shower).toContain('shown once');
    expect(shower).toContain('navigator.clipboard');
  });

  it('both paths spend the continuation ticket', () => {
    // Neither a password nor a code is enough on its own.
    expect(session).toMatch(/claimWithDiscord\(ticket: string, id: string, password: string\)/);
    expect(session).toContain("action: 'claim', ticket: ticket");
    expect(session).toContain("action: 'redeem-code', ticket: ticket");
  });
});
