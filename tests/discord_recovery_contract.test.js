// Phase D6: unlink and recovery.
//
// This phase exists so that D3 can be irreversible safely. Once Discord is the
// only way in, an account whose link is lost, wrong, or never made has no route
// back unless one was built first. Everything asserted here is a property that,
// if it silently drifted, would strand a real person out of their account — or
// hand someone else a way into it.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const migration = read('supabase/migrations/20260926200000_account_link_codes.sql');
const adminFn = stripComments(read('supabase/functions/admin-accounts/index.ts'));
const discordFn = stripComments(read('supabase/functions/auth-discord/index.ts'));
const passkeyFn = stripComments(read('supabase/functions/auth-passkey/index.ts'));
const shared = stripComments(read('supabase/functions/_shared/backup-codes.ts'));

describe('an unlink can never strand an account', () => {
  it('detaches the link and issues the code in ONE transaction', () => {
    // A bare deletion with no code to follow is not recovery, it is a way to
    // lock a colleague out. The RPC cannot do only the first half.
    const fn = migration.slice(migration.indexOf('FUNCTION public.gm_discord_unlink'), migration.indexOf('FUNCTION public.gm_redeem_relink_code'));
    expect(fn).toMatch(/DELETE FROM public\.discord_account_links/);
    expect(fn).toMatch(/INSERT INTO public\.account_link_codes/);
    expect(fn).toMatch(/kind, account_id, issued_by, expires_at/);
  });

  it('succeeds on an account that was never linked', () => {
    // This is the escape hatch D3 needs for the 99 accounts that have never
    // logged in and will not remember a password they never used: an admin can
    // hand them a relink code even though there is nothing to detach.
    const fn = migration.slice(migration.indexOf('FUNCTION public.gm_discord_unlink'), migration.indexOf('FUNCTION public.gm_redeem_relink_code'));
    // The only early return is a missing ACCOUNT, never a missing link.
    const earlyReturns = fn.match(/RETURN QUERY SELECT false[^;]*;/g) || [];
    expect(earlyReturns).toHaveLength(1);
    expect(earlyReturns[0]).toContain('account_not_found');
  });

  it('retires sessions on both unlink and relink', () => {
    // Whoever held the old link may still hold a live token.
    const bumps = migration.match(/SET session_version = COALESCE\(session_version, 0\) \+ 1/g) || [];
    expect(bumps.length, 'both gm_discord_unlink and gm_redeem_relink_code must bump').toBe(2);
  });

  it('never lets the server see the plaintext code', () => {
    const block = adminFn.slice(adminFn.indexOf('if (action === "discord-unlink")'));
    expect(block).toContain('p_code_hash: await sha256Hex(relinkCode)');
    // The RPC takes a hash, and the column is named for one.
    expect(migration).toContain('p_code_hash  text');
    expect(migration).toContain('code_hash               text        NOT NULL UNIQUE');
    // Assert on the column list, not the prose: the table COMMENT cites
    // `join_code_plain` on purpose, as the contrasting case.
    const columns = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS public.account_link_codes'),
      migration.indexOf('CREATE INDEX IF NOT EXISTS idx_account_link_codes_expires')
    ).replace(/--.*$/gm, '');
    expect(columns).not.toMatch(/plain|clear_text|plaintext/i);
  });

  it('returns the plaintext exactly once, in the response', () => {
    const block = adminFn.slice(adminFn.indexOf('if (action === "discord-unlink")'));
    expect(block).toContain('relink_code: relinkCode');
  });
});

describe('peer unlink is permitted but never quiet', () => {
  const block = adminFn.slice(adminFn.indexOf('if (action === "discord-unlink")'), adminFn.indexOf('if (action === "create")'));

  it('uses the same authorization matrix as every other admin action', () => {
    expect(block).toContain('canManageAccount(info, targetCtx)');
    expect(block).toContain('forbidden');
  });

  it('writes the audit ledger AND announces on Discord', () => {
    expect(block).toContain("from(\"system_audit_logs\").insert");
    expect(block).toContain('action_type: "discord_unlink"');
    expect(block).toContain('resolveAuditChannelId(admin, targetGuild)');
    expect(block).toContain('postAuditMessage(');
  });

  it('records who did it and what was detached', () => {
    expect(block).toContain('previous_discord_user_id: previous');
    expect(block).toContain('actor_role: info.role');
  });

  it('treats the announcement as best-effort, the ledger as authoritative', () => {
    // The unlink has already committed by the time we post; a Discord outage
    // must not undo it or fail the response.
    const audit = adminFn.indexOf('from("system_audit_logs").insert');
    const announce = adminFn.indexOf('postAuditMessage(');
    expect(audit, 'the ledger write comes first').toBeLessThan(announce);
    const poster = stripComments(read('supabase/functions/_shared/discord-verification.ts'));
    const fn = poster.slice(poster.indexOf('export async function postAuditMessage'));
    expect(fn).toContain('catch');
    expect(fn).toContain('return false');
  });

  it('cannot be turned into a mass ping', () => {
    // An account id or guild name containing @everyone would otherwise notify
    // the whole server.
    const poster = read('supabase/functions/_shared/discord-verification.ts');
    const fn = poster.slice(poster.indexOf('export async function postAuditMessage'));
    expect(fn).toContain('allowed_mentions: { parse: [] }');
  });

  it('does not auto-delete the announcement', () => {
    // discord-profile-verification deletes its own replies after 15s to keep
    // the verification channel clean. An audit record must survive.
    const poster = read('supabase/functions/_shared/discord-verification.ts');
    const fn = poster.slice(poster.indexOf('export async function postAuditMessage'), poster.indexOf('export interface ExtractedProfile'));
    expect(fn).not.toContain('DELETE');
    expect(fn).not.toContain('setTimeout');
  });
});

describe('a relink code alone is not enough', () => {
  it('requires a fresh Discord authorization as well', () => {
    // The code is spent together with a continuation ticket, so someone who
    // merely finds the code cannot redeem it.
    // Phase D5 merged relink and admin-invite redemption into one action, so
    // the person holding a code never has to know which kind it is.
    expect(discordFn).toMatch(/RedeemCodeSchema = z\.object\(\{[\s\S]*?ticket: TicketField[\s\S]*?code:/);
    const fn = discordFn.slice(discordFn.indexOf('async function handleRedeemCode'));
    expect(fn).toContain('consumeTicket(admin, parsed.data.ticket, logger)');
    expect(fn).toContain('p_discord_user_id: consumed.discordUserId');
  });

  it('issues a continuation ticket when the account is unlinked', () => {
    // Without it the caller would have to redo the entire Discord round trip
    // just to present a code, because redeem already spent the first ticket.
    const fn = discordFn.slice(discordFn.indexOf('async function handleRedeem'));
    expect(fn).toContain('state: "unlinked"');
    expect(fn).toContain('ticket: continuation');
    expect(fn).toContain('issueTicket(admin, discordUserId');
  });

  it('is single-use and expiring, enforced in SQL', () => {
    const fn = migration.slice(migration.indexOf('FUNCTION public.gm_redeem_relink_code'));
    expect(fn).toContain("c.kind = 'relink'");
    expect(fn).toContain('c.used_at IS NULL');
    expect(fn).toContain('c.expires_at > now()');
    expect(fn).toContain('FOR UPDATE');
    expect(fn).toContain('SET used_at = now()');
  });

  it('refuses a Discord identity already attached elsewhere', () => {
    // discord_account_links is a bijection; say so rather than failing on a
    // constraint the caller cannot interpret.
    expect(migration).toContain('discord_already_linked');
  });

  it('refuses a non-active account', () => {
    expect(migration).toContain('account_not_active');
  });
});

describe('backup codes: one implementation, one audience', () => {
  it('lives in _shared and is used by both endpoints', () => {
    // The audit found four subtly different HTML escapers (M11). A credential
    // check is a far worse place for that drift, and during the transition
    // both doors must accept exactly the same codes.
    expect(passkeyFn).toContain('from "../_shared/backup-codes.ts"');
    expect(discordFn).toContain('from "../_shared/backup-codes.ts"');
    for (const local of ['function randomBackupCode', 'function sha256Hex', 'function issueBackupCodes', 'function normalizeBackupCode']) {
      expect(passkeyFn, `auth-passkey must not keep a local ${local}`).not.toContain(local);
    }
  });

  it('excludes visually ambiguous characters', () => {
    // Read aloud, written down, retyped under stress.
    const alphabet = /BACKUP_CODE_ALPHABET = "([^"]+)"/.exec(shared)[1];
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
      expect(alphabet, `${ambiguous} is too easy to misread`).not.toContain(ambiguous);
    }
  });

  it('stores only the hash and replaces the whole set on reissue', () => {
    const fn = shared.slice(shared.indexOf('export async function issueBackupCodes'));
    expect(fn).toContain('code_hash: await sha256Hex(code)');
    expect(fn, 'a code written down last year must not outlive a reissue')
      .toMatch(/delete\(\)\.eq\("account_id", accountId\)/);
  });

  it('is restricted to super_admin, and does not leak that fact', () => {
    // Every other account has an administrator above it who can unlink and
    // reissue — stronger, because a second human is involved. A reply that
    // distinguished "wrong role" from "wrong code" would be a role oracle.
    const fn = discordFn.slice(discordFn.indexOf('async function handleBackupLogin'));
    expect(fn).toContain('acc.role !== "super_admin"');
    // The server logs the true reason — that is useful and stays server-side.
    // What must be uniform is the RESPONSE: every refusal returns invalid_code.
    // `locked_until` also appears in the earlier .select(), so the end bound
    // must be searched for AFTER the role check, not from the start.
    const roleAt = fn.indexOf('acc.role !== "super_admin"');
    const refusal = fn.slice(roleAt, fn.indexOf('locked_until', roleAt));
    const responses = refusal.match(/json\(\{ ok: false, error: "[a-z_]+" \}/g) || [];
    expect(responses.length).toBeGreaterThan(0);
    for (const r of responses) {
      expect(r, 'a refusal must not distinguish a wrong role from a wrong code').toContain('"invalid_code"');
    }
  });

  it('consumes the code before minting anything', () => {
    const fn = discordFn.slice(discordFn.indexOf('async function handleBackupLogin'));
    const consume = fn.indexOf('verifyAndConsumeBackupCode');
    const mint = fn.indexOf('establishShadowSession');
    expect(consume).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(consume);
  });
});

describe('every POST action is rate limited', () => {
  it('throttles redeem, code redemption and backup-login alike', () => {
    for (const fnName of ['handleRedeem', 'handleRedeemCode', 'handleBackupLogin']) {
      const fn = discordFn.slice(discordFn.indexOf(`async function ${fnName}`));
      expect(fn.slice(0, 900), `${fnName} must check the IP budget`).toContain('throttled(req, admin, logger');
    }
  });
});

describe('least privilege on the new objects', () => {
  it('account_link_codes is deny-all', () => {
    expect(migration).toContain('ALTER TABLE public.account_link_codes ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('ALTER TABLE public.account_link_codes FORCE  ROW LEVEL SECURITY;');
    expect(migration).not.toMatch(/CREATE POLICY/);
    expect(migration).toContain('COMMENT ON TABLE public.account_link_codes');
  });

  it('constrains the shape each kind requires', () => {
    // A relink code without an account, or an invite without a destination,
    // is meaningless. Enforce it rather than trusting callers.
    expect(migration).toContain("CHECK (kind IN ('relink', 'admin_invite'))");
    expect(migration).toContain("CHECK (kind <> 'relink' OR account_id IS NOT NULL)");
    expect(migration).toContain("CHECK (kind <> 'admin_invite' OR (guild IS NOT NULL AND role IS NOT NULL))");
  });

  it('revokes both new functions from unprivileged roles', () => {
    const esc = (x) => x.replace(/[.()]/g, '\\$&');
    for (const f of ['gm_discord_unlink(text, text, timestamptz, text)', 'gm_redeem_relink_code(text, text)']) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc(f)}\\s+FROM PUBLIC, anon, authenticated;`));
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc(f)}\\s+TO service_role;`));
    }
  });

  it('purges expired codes but keeps redeemed ones as evidence', () => {
    expect(migration).toContain('DELETE FROM public.account_link_codes WHERE expires_at <= now() AND used_at IS NULL;');
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});

describe('the admin surface tells the truth about what it does', () => {
  const render = read('src/modules/app/admin/accounts.render.ts');

  it('warns that the unlink is announced before it happens', () => {
    const block = render.slice(render.indexOf("'.gm-cred-discord-unlink'"));
    expect(block).toContain("announced on the guild");
    expect(block).toContain('single-use relink code');
  });

  it('surfaces the code and copies it, since there is no second chance', () => {
    const block = render.slice(render.indexOf("'.gm-cred-discord-unlink'"));
    expect(block).toContain('navigator.clipboard');
    expect(block).toContain('res.relink_code');
  });
});
