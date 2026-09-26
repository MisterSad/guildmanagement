// Phase D5: single-use invitation codes for additional admins.
//
// The owner's constraint was that adding a second admin to a tenant must not
// depend on the bot being present in some Discord server, nor on any mapping
// between FGF guilds and Discord servers. The code IS the link. Everything
// below either holds that line, or keeps an invitation from becoming a way to
// mint privilege the issuer does not have.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const migration = read('supabase/migrations/20260926220000_admin_invite_codes.sql');
const adminFn = stripComments(read('supabase/functions/admin-accounts/index.ts'));
const discordFn = stripComments(read('supabase/functions/auth-discord/index.ts'));
const inviteBlock = adminFn.slice(
  adminFn.indexOf('if (action === "issue-admin-invite")'),
  adminFn.indexOf('if (action === "create")')
);
// Bounded at the REVOKE block: running to end-of-file would swallow the
// migration's own DO $verify$ assertions, which mention the very column
// names this test checks are absent.
const redeemFn = migration.slice(
  migration.indexOf('FUNCTION public.gm_redeem_admin_invite'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.gm_generate_account_id')
);

describe('the code is the link', () => {
  it('needs no Discord server and no guild mapping', () => {
    // The worker's /setup-server provisioning plays no part in this path.
    for (const token of ['setup-server', 'discord_guild_id', 'guild_id', 'DISCORD_BOT_TOKEN']) {
      expect(inviteBlock, `issuing must not depend on ${token}`).not.toContain(token);
    }
    const redeemBlock = discordFn.slice(discordFn.indexOf('async function handleRedeemCode'));
    expect(redeemBlock).not.toContain('setup-server');
  });
});

describe('an invited account is Discord-only from birth', () => {
  it('is created with no password column written at all', () => {
    expect(redeemFn).toContain('INSERT INTO public.accounts (id, role, guild, server_number, status)');
    expect(redeemFn).not.toMatch(/password_hash|password_enc/);
  });

  it('is linked in the same transaction that creates it', () => {
    const acc = redeemFn.indexOf('INSERT INTO public.accounts');
    const link = redeemFn.indexOf('INSERT INTO public.discord_account_links');
    expect(acc).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(acc);
    expect(redeemFn.slice(acc, link)).not.toMatch(/COMMIT|ROLLBACK/);
  });

  it('refuses a Discord identity that already has an account', () => {
    // Otherwise someone could spend an invite and end up holding two.
    expect(redeemFn).toContain('discord_already_linked');
  });
});

describe('the account id is generated safely', () => {
  it('is generated inside the transaction, not handed in', () => {
    // Generating it in the Edge Function and inserting afterwards is a TOCTOU
    // race against idx_accounts_lower_id that two redemptions would lose.
    expect(redeemFn).toContain('public.gm_generate_account_id(p_discord_username)');
    const handler = discordFn.slice(discordFn.indexOf('async function handleRedeemCode'));
    expect(handler).not.toContain('gm_generate_account_id');
  });

  it('folds accented Latin before stripping, not after', () => {
    // Stripping straight to [A-Za-z0-9_] turns 'Ärès_Actual' into 'rs_Actual'
    // -- unrecognisable to its owner. Verified live: it now yields
    // 'Ares_Actual', 'AEroskobing', 'Strasse', 'Coeur', 'Zizek'.
    const gen = migration.slice(migration.indexOf('FUNCTION public.gm_generate_account_id'), migration.indexOf('FUNCTION public.gm_issue_admin_invite'));
    const translateAt = gen.indexOf('translate(');
    const stripAt = gen.indexOf("regexp_replace(v_base, '[^A-Za-z0-9_]'");
    expect(translateAt).toBeGreaterThan(-1);
    expect(stripAt).toBeGreaterThan(translateAt);
    // Two-letter expansions translate() cannot express.
    for (const pair of ["'Æ', 'AE'", "'ß', 'ss'", "'Œ', 'OE'"]) {
      expect(gen).toContain(pair);
    }
  });

  it('has a fallback that cannot loop forever', () => {
    const gen = migration.slice(migration.indexOf('FUNCTION public.gm_generate_account_id'), migration.indexOf('FUNCTION public.gm_issue_admin_invite'));
    expect(gen).toMatch(/FOR i IN 1\.\.12 LOOP/);
    expect(gen).toMatch(/RETURN 'd' \|\|/);
  });

  it('keeps accounts.id as the human-readable text key', () => {
    // It is a textual foreign key referenced from many tables; replacing it
    // with an opaque id plus a display_name is its own migration.
    expect(migration).toContain('accounts.id` stays the human-readable text key');
  });
});

describe('an invitation cannot mint privilege the issuer lacks', () => {
  it('caps the role at the caller ceiling, reusing the existing matrix', () => {
    expect(inviteBlock).toContain('maxAssignableRole(info.role)');
    expect(inviteBlock).toContain('rank[targetRole] > rank[ceiling]');
    expect(inviteBlock).toContain('isGuildInScope(info, targetGuild, guildRow.server_number)');
  });

  it('refuses a member role outright in SQL too', () => {
    // Defence in depth: the RPC does not trust the Edge Function's check.
    const issue = migration.slice(migration.indexOf('FUNCTION public.gm_issue_admin_invite'), migration.indexOf('FUNCTION public.gm_redeem_admin_invite'));
    expect(issue).toContain("p_role NOT IN ('guild_admin', 'server_admin', 'super_admin')");
    expect(issue).toContain('invalid_role');
  });

  it('mirrors the ceiling in the UI without relying on it', () => {
    const ctrl = read('src/modules/app/admin/accounts.controller.ts');
    const block = ctrl.slice(ctrl.indexOf("byId<HTMLSelectElement>('admin-invite-role')"));
    expect(block).toContain('isSuperAdmin');
    expect(block.slice(0, 700)).toContain('guild_admin');
    // The comment must say the server re-checks, so nobody mistakes this for
    // the control.
    expect(ctrl).toContain('The server re-checks either way');
  });
});

describe('the outstanding-invitation cap is real', () => {
  it('is counted and enforced in SQL, under a lock', () => {
    const issue = migration.slice(migration.indexOf('FUNCTION public.gm_issue_admin_invite'), migration.indexOf('FUNCTION public.gm_redeem_admin_invite'));
    // Two concurrent issues would otherwise both read "4 open" and both write.
    expect(issue).toContain('FOR UPDATE');
    expect(issue).toContain('v_open >= p_max_open');
    expect(issue).toContain('too_many_open_codes');
    expect(issue).toContain("c.used_at IS NULL");
    expect(issue).toContain("c.expires_at > now()");
  });

  it('is a constant in code, per the owner decision', () => {
    // Changing it is a deploy, not a settings toggle someone can quietly raise.
    expect(adminFn).toMatch(/MAX_OPEN_INVITES_PER_GUILD = 5/);
    expect(inviteBlock).toContain('p_max_open: MAX_OPEN_INVITES_PER_GUILD');
  });
});

describe('issuing is recorded and announced', () => {
  it('writes the ledger and posts to the guild audit channel', () => {
    expect(inviteBlock).toContain('action_type: "admin_invite_issued"');
    expect(inviteBlock).toContain('resolveAuditChannelId(admin, targetGuild)');
    expect(inviteBlock).toContain('postAuditMessage(');
  });

  it('never stores the plaintext code', () => {
    expect(inviteBlock).toContain('p_code_hash: await sha256Hex(inviteCode)');
    expect(inviteBlock).toContain('invite_code: inviteCode');
    const issue = migration.slice(migration.indexOf('FUNCTION public.gm_issue_admin_invite'), migration.indexOf('FUNCTION public.gm_redeem_admin_invite'));
    expect(issue).not.toMatch(/p_code_plain|code_plain/);
  });
});

describe('one redemption entry point for both kinds of code', () => {
  const handler = discordFn.slice(discordFn.indexOf('async function handleRedeemCode'));

  it('dispatches on the stored kind rather than asking the user', () => {
    // The person holding a code has no reason to know whether it is a relink
    // or an invitation; making them choose invites burning a ticket on a guess.
    expect(handler).toContain('codeRow.kind === "admin_invite"');
    expect(handler).toContain('gm_redeem_admin_invite');
    expect(handler).toContain('gm_redeem_relink_code');
  });

  it('classifies without consuming, and lets the RPCs own single use', () => {
    const lookupAt = handler.indexOf('.from("account_link_codes")');
    const rpcAt = handler.indexOf('gm_redeem_admin_invite');
    expect(lookupAt).toBeGreaterThan(-1);
    expect(rpcAt).toBeGreaterThan(lookupAt);
    // The classification read must not mark anything used.
    expect(handler.slice(lookupAt, rpcAt)).not.toContain('update(');
    // Each RPC enforces single use under FOR UPDATE.
    expect(migration).toContain('FOR UPDATE');
  });

  it('still spends a ticket, so a code alone is never enough', () => {
    expect(handler).toContain('consumeTicket(admin, parsed.data.ticket, logger)');
    const ticketAt = handler.indexOf('consumeTicket');
    const hashAt = handler.indexOf('sha256Hex');
    expect(ticketAt).toBeLessThan(hashAt);
  });
});

describe('least privilege on the new functions', () => {
  it('keeps all three off anon and authenticated', () => {
    const esc = (x) => x.replace(/[.()]/g, '\\$&');
    for (const f of [
      'gm_generate_account_id(text)',
      'gm_issue_admin_invite(text, text, text, text, timestamptz, integer)',
      'gm_redeem_admin_invite(text, text, text)',
    ]) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc(f)}\\s+FROM PUBLIC, anon, authenticated;`));
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc(f)}\\s+TO service_role;`));
    }
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});
