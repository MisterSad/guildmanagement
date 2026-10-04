// Discord sign-in: correcting a mistake must not cost a Discord round trip,
// and a person waiting on approval must hear about it.
//
// A continuation ticket is re-issued after a RECOVERABLE error, at most five
// times per Discord authorization. The bound lives in a CHECK constraint, so
// these tests pin both the SQL bound and the Edge Function that respects it,
// plus the two Discord notifications around a join request.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { edgeSource, edgeFunctionBody } from './helpers/edge-source.js';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const migration = read('supabase/migrations/20261002120000_discord_signin_retry.sql');
const fn = stripComments(edgeSource('auth-discord'));
const adminFn = stripComments(edgeSource('admin-accounts'));
// The approve/reject decision moved here on 2026-10-03, shared with the
// Discord join-request buttons.
const decisionFn = stripComments(read('supabase/functions/_shared/registration-decision.ts'));
// Not comment-stripped: the naive stripper would eat the `//` inside API URLs.
const verification = read('supabase/functions/_shared/discord-verification.ts');

const slice = (src, from, to) => src.slice(src.indexOf(from), to ? src.indexOf(to, src.indexOf(from) + 1) : undefined);

describe('the retry chain is bounded in SQL', () => {
  it('counts attempts on the ticket and caps them with a CHECK', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS attempts smallint NOT NULL DEFAULT 0/);
    expect(migration).toMatch(/CHECK \(attempts BETWEEN 0 AND 5\)/);
  });

  it('caps the display name it carries', () => {
    expect(migration).toMatch(/length\(display_name\) <= 64/);
  });

  it('keeps the consume RPC atomic, definer-scoped and service-role only', () => {
    const def = slice(migration, 'CREATE FUNCTION public.gm_consume_discord_auth_ticket', '$$;');
    expect(def).toContain('SECURITY DEFINER');
    expect(def).toContain("SET search_path = ''");
    expect(def).toMatch(/DELETE FROM public\.discord_auth_tickets[\s\S]*RETURNING/);
    expect(def).toContain('t.expires_at > now()');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.gm_consume_discord_auth_ticket(text) FROM PUBLIC, anon, authenticated;'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.gm_consume_discord_auth_ticket(text) TO service_role;'
    );
  });

  it('mirrors the SQL bound in the Edge Function', () => {
    expect(fn).toMatch(/const MAX_TICKET_ATTEMPTS = 5;/);
  });
});

describe('a recoverable mistake hands back a fresh ticket', () => {
  const helper = slice(fn, 'async function failContinuation', 'async function throttled');

  it('re-issues only for recoverable errors and only while attempts remain', () => {
    expect(helper).toContain('RECOVERABLE_ERRORS.has(error)');
    expect(helper).toContain('consumed.attempts < MAX_TICKET_ATTEMPTS');
    expect(helper).toContain('attempts: consumed.attempts + 1');
    expect(helper).toContain('attempts_left');
  });

  it('treats field mistakes as recoverable', () => {
    const set = slice(fn, 'const RECOVERABLE_ERRORS', ']);');
    for (const code of [
      'invalid_code',
      'code_invalid',
      'uid_not_in_guild',
      'uid_already_claimed',
      'tag_taken',
      'invalid_credentials',
    ]) {
      expect(set, code).toContain(`"${code}"`);
    }
  });

  it('never re-issues for states a retry cannot fix', () => {
    const set = slice(fn, 'const RECOVERABLE_ERRORS', ']);');
    for (const code of [
      'discord_already_linked',
      'discord_account_too_new',
      'daily_limit_reached',
      'account_locked',
      'server_error',
      'too_many_attempts',
    ]) {
      expect(set, code).not.toContain(`"${code}"`);
    }
  });

  it('is used by claim, onboard and redeem-code', () => {
    for (const handler of [
      'async function handleClaim',
      'async function handleOnboard',
      'async function handleRedeemCode',
    ]) {
      const body = slice(fn, handler, '\nasync function ');
      expect(body, handler).toContain('failContinuation(json, admin, logger, consumed');
    }
  });

  it('restarts the budget on a fresh Discord authorization only', () => {
    const redeem = slice(fn, 'async function handleRedeem(', '\nasync function ');
    expect(redeem).toContain('attempts: 0');
  });
});

describe('the claim stays an expensive oracle', () => {
  const claim = slice(fn, 'async function handleClaim', '\nasync function ');

  it('fails closed when the per-Discord throttle cannot be read', () => {
    expect(claim).toMatch(/if \(tErr \|\| !tRow\)/);
    expect(claim).toContain('too_many_attempts');
  });

  it('checks both budgets before verifying the password', () => {
    const verify = claim.indexOf('gm_claim_account_with_discord');
    expect(claim.indexOf('CLAIM_IP_LIMIT')).toBeLessThan(verify);
    expect(claim.indexOf('gm_check_discord_throttle')).toBeLessThan(verify);
  });
});

describe('the unlinked answer is always actionable', () => {
  it('reports a missing continuation as a server error', () => {
    const redeem = slice(fn, 'async function handleRedeem(', '\nasync function ');
    const unlinked = redeem.slice(redeem.lastIndexOf('const continuation'), redeem.indexOf('state: "unlinked"'));
    expect(unlinked).toMatch(/if \(!continuation\)[\s\S]*error: "server_error"/);
  });

  it('greets the person by their Discord display name', () => {
    expect(fn).toContain('me?.global_name');
    expect(fn).toContain('display_name: consumed.displayName');
  });
});

describe('a join request is announced to the guild', () => {
  it('posts to the audit channel after a pending join, best-effort', () => {
    const onboard = slice(fn, 'async function handleOnboard', '\nasync function ');
    const pending = onboard.indexOf('row.status === "pending"');
    expect(onboard.indexOf('announceJoinRequest(')).toBeGreaterThan(pending);
    const announce = slice(fn, 'async function announceJoinRequest', '\nasync function ');
    expect(announce).toContain('resolveAuditChannelId(admin, guild)');
    expect(announce).toContain('postChannelMessage(channelId, {');
    expect(announce).toMatch(/catch/);
  });
});

describe('the player hears the outcome by DM', () => {
  it('sends a DM with mentions disabled and never throws', () => {
    const dm = slice(verification, 'export async function sendDirectMessage', '\nexport ');
    expect(dm).toContain('/users/@me/channels');
    expect(dm).toContain('recipient_id: discordUserId');
    expect(dm).toContain('allowed_mentions: { parse: [] }');
    expect(dm).toMatch(/catch \{\s*return false;/);
  });

  it('resolves the recipient from the link table, never from the request', () => {
    const helper = slice(decisionFn, 'export async function linkedDiscordUserId', '\nexport async function ');
    expect(helper).toContain('.from("discord_account_links")');
    expect(helper).toContain('.eq("account_id", accountId)');
  });

  it('notifies on approval and on rejection, after the decision commits', () => {
    const decide = slice(decisionFn, 'export async function decideRegistration', 'async function auditDecision');
    const approve = decide.slice(
      decide.indexOf('if (decision === "approve")'),
      decide.indexOf('const rejectedDiscordId')
    );
    expect(approve.indexOf('notifyRegistrationOutcome(')).toBeGreaterThan(approve.indexOf('gm_approve_player_account'));
    expect(approve).toContain('"approved"');

    const reject = decide.slice(decide.indexOf('const rejectedDiscordId'));
    // The recipient is read BEFORE the rejection, the message sent after it.
    expect(reject.indexOf('linkedDiscordUserId(')).toBeLessThan(reject.indexOf('gm_reject_player_account'));
    expect(reject.indexOf('notifyRegistrationOutcome(')).toBeGreaterThan(reject.indexOf('gm_reject_player_account'));
    expect(reject).toContain('"rejected"');
  });
});

describe('one decision path for the app and for Discord', () => {
  it('admin-accounts delegates both actions to decideRegistration', () => {
    const block = edgeFunctionBody('admin-accounts', 'decideRegistrationAction');
    expect(block).toContain('decideRegistration(');
    expect(block).toContain('via: "app"');
    expect(adminFn).not.toContain('gm_approve_player_account');
    expect(adminFn).not.toContain('gm_reject_player_account');
  });

  it('authorizes inside the shared function, before any write', () => {
    const decide = slice(decisionFn, 'export async function decideRegistration', 'async function auditDecision');
    expect(decide.indexOf('canManageAccount(actor, targetCtx)')).toBeLessThan(
      decide.indexOf('gm_approve_player_account')
    );
    expect(decide.indexOf('canManageAccount(actor, targetCtx)')).toBeLessThan(
      decide.indexOf('gm_reject_player_account')
    );
    expect(decide).toContain('target.status !== "pending" || !isMember(target.role)');
  });

  it('writes an audit row naming the decider and where they decided', () => {
    const audit = slice(decisionFn, 'async function auditDecision');
    expect(audit).toContain('user_identifier: actor.accountId');
    expect(audit).toContain('via: actor.via');
  });
});
