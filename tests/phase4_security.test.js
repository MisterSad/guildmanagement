// Phase 4 — security and isolation.
//
// Each block below corresponds to an audit finding, and asserts the property
// that would have to hold for the finding to stay closed. Several of these
// were previously *locked in* by tests asserting the permissive behaviour; the
// CORS ones in particular now assert the opposite of what they used to.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isAllowedOrigin } from '../supabase/functions/_shared/cors.ts';
import { escapeLike, escapeOrFilterValue } from '../supabase/functions/_shared/like.ts';
import { escapeLike as clientEscapeLike } from '../src/core/utils/text.ts';
import { readTokenSessionVersion, isSessionRevoked } from '../supabase/functions/_shared/session-epoch.ts';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('M14 — a suspended account is authorized for nothing', () => {
  const auth = stripComments(read('supabase/functions/_shared/auth.ts'));

  it('refuses centrally instead of asking each endpoint to remember', () => {
    // The helper used to RETURN `status` and leave the check to callers. One
    // of seven did it. Nulling the role makes every existing `!caller.role`
    // gate cover the case automatically.
    expect(auth).toContain('acc.status !== "active"');
    const branch = auth.slice(auth.indexOf('acc.status !== "active"'));
    expect(branch.slice(0, 300)).toContain('denied(');
  });

  it('still reports the status so a caller can explain why', () => {
    expect(auth).toContain('status: acc.status ?? null');
    expect(auth).toContain('active: boolean');
  });

  it('every consumer gates on the role, which is what makes this work', () => {
    for (const f of ['tickets', 'ocr-guild-members', 'migration-summary', 'discord-webhook-proxy', 'guild-data-export', 'event-reminders']) {
      const src = read(`supabase/functions/${f}/index.ts`);
      expect(src, `${f} must gate on caller.role`).toMatch(/caller\.role/);
    }
  });
});

describe('M13 — the CORS allowlist no longer trusts a name anyone can register', () => {
  it('accepts deployments that carry the owning scope', () => {
    for (const o of [
      'https://guildmanagement.vercel.app',
      'https://fgf-guild-management.vercel.app',
      'https://guildmanagement-mistersads-projects.vercel.app',
      'https://guildmanagement-abc123def-mistersads-projects.vercel.app',
      'https://guildmanagement-git-feature-branch-mistersads-projects.vercel.app',
    ]) {
      expect(isAllowedOrigin(o), o).toBe(true);
    }
  });

  it('refuses the scope-less forms, which is the whole bypass', () => {
    for (const o of [
      'https://guildmanagement-evil.vercel.app',
      'https://guildmanagement-preview-123.vercel.app',
      'https://guildmanagement-git-feature.vercel.app',
      'https://preview.guildmanagement.vercel.app',
      'https://guildmanagement-abc123def-attacker-projects.vercel.app',
      'https://guildmanagement.vercel.app.evil.com',
      'http://guildmanagement.vercel.app',
    ]) {
      expect(isAllowedOrigin(o), o).toBe(false);
    }
  });

  it('states why localhost stays, rather than leaving it unexplained', () => {
    // Removing it would break the documented dev loop, which calls the
    // DEPLOYED functions from a local build.
    const cors = read('supabase/functions/_shared/cors.ts');
    expect(cors).toContain('calling the DEPLOYED Edge Functions');
    expect(cors).toContain('bearer tokens in');
  });
});

describe('M16 — a value can no longer change what a query means', () => {
  it('escapes LIKE wildcards without rejecting legal identifiers', () => {
    // `_` is legal in a real account id -- gm_generate_account_id produces
    // them -- so rejecting it, as the audit first proposed, would break
    // sign-in for those accounts.
    expect(escapeLike('Ares_Actual')).toBe('Ares\\_Actual');
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    // The backslash must be escaped first, or the escapes get re-escaped.
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('keeps the client and Edge implementations identical', () => {
    for (const v of ['Ares_Actual', '%', 'a\\b', '\\%', '100%_sure']) {
      expect(clientEscapeLike(v), v).toBe(escapeLike(v));
    }
  });

  it('strips the separators of the PostgREST or() grammar', () => {
    // `a,b` used to re-partition the filter and ask for a column named `b`.
    expect(escapeOrFilterValue('a,b')).toBe('a b');
    expect(escapeOrFilterValue('x(y)')).toBe('x y ');
    expect(escapeOrFilterValue('50%')).toBe('50\\%');
  });

  it('leaves no unescaped ilike anywhere in the codebase', () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name.endsWith('.ts')) files.push(rel);
      }
    };
    walk('src');
    walk('supabase/functions');

    for (const f of files) {
      if (f.endsWith('/like.ts') || f.endsWith('/text.ts')) continue;
      for (const line of stripComments(read(f)).split('\n')) {
        if (!line.includes('.ilike(')) continue;
        expect(line, `${f}: ${line.trim()}`).toMatch(/\.ilike\([^)]*escapeLike\(/);
      }
    }
  });

  it('removed the browser write path that bypassed the authorization matrix', () => {
    // Steps 2-4 of the old update-role chain never ran canManageAccount,
    // isGuildInScope or maxAssignableRole. Step 4 was a direct UPDATE whose
    // pattern an id of "%" would widen to every row in the table.
    const session = stripComments(read('src/core/auth/session.ts'));
    expect(session).not.toContain('.ilike(');
    expect(session).not.toContain("gm_admin_upsert");
    expect(session).not.toContain("'Sync_Role_Update_'");
    // The Edge Function is the only path left.
    expect(session).toMatch(/action: 'update-role'/);
  });

  it('requires the export target guild to exist before interpolating it', () => {
    const exp = stripComments(read('supabase/functions/guild-data-export/index.ts'));
    expect(exp).toContain('guild_not_found');
    expect(exp).toContain('escapeOrFilterValue(targetGuild!)');
  });
});

describe('B3 — replay, fail-open throttling, per-isolate limits, scrubbers', () => {
  it('refuses a stale Discord interaction before verifying the signature', () => {
    // The signature covers the timestamp, so replaying both together verified
    // perfectly and a captured interaction stayed valid forever.
    const d = stripComments(read('supabase/functions/_shared/discord.ts'));
    expect(d).toContain('DISCORD_TIMESTAMP_TOLERANCE_S = 300');
    const fn = d.slice(d.indexOf('export async function verifyDiscordSignature'));
    const guardAt = fn.indexOf('DISCORD_TIMESTAMP_TOLERANCE_S');
    const verifyAt = fn.indexOf('crypto.subtle.importKey');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt, 'freshness must be checked before the cryptography').toBeLessThan(verifyAt);
  });

  it('fails the throttle CLOSED on a database error', () => {
    // Pressure on the database used to silently disable login, sign-up and OCR
    // throttling at exactly the moment an attacker would be causing it.
    const rl = read('supabase/functions/_shared/rate-limit.ts');
    const fn = rl.slice(rl.indexOf('export async function checkAndRecordIpAttempt'));
    expect(fn).not.toMatch(/return \{ allowed: true, remaining: 1 \}/);
    expect(fn).toContain('FAIL CLOSED');
    expect((fn.match(/return \{ allowed: false, remaining: 0 \}/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('gives guild-request a limiter that survives an isolate', () => {
    const gr = stripComments(read('supabase/functions/guild-request/index.ts'));
    expect(gr).toContain('checkAndRecordIpAttempt');
    expect(gr).not.toContain('new Map<string, number[]>');
    expect(gr).not.toContain('attemptLog');
  });

  it('scrubs the current Supabase key formats, not only legacy JWTs', () => {
    const lg = read('supabase/functions/_shared/logger.ts');
    expect(lg).toContain('sb_secret_');
    expect(lg).toContain('sb_publishable_');
  });
});

describe('M17 — the audit ledger cannot be flooded or silently forged', () => {
  const m = read('supabase/migrations/20260926240000_harden_client_error_reporting.sql');

  it('no longer keys the rate limit on a caller-supplied value', () => {
    // Rotating correlation_id bypassed it; an EMPTY one skipped the check
    // entirely, because the whole block sat inside `IF v_corr <> ''`.
    expect(m).not.toMatch(/WHERE correlation_id = v_corr/);
    expect(m).toContain("l.metadata ->> 'verified_auth_uid' = v_uid::text");
    expect(m).toContain('v_anon_limit');
  });

  it('bounds both jsonb payloads, not just the message', () => {
    expect(m).toContain('v_json_cap');
    // The repo file wraps the arguments across lines; assert on the marker.
    expect(m).toMatch(/jsonb_build_object\(\s*\n?\s*'truncated', true/);
    expect(m).toContain("'original_bytes', length");
  });

  it('records what was verified next to what was merely claimed', () => {
    for (const k of ['verified_auth_uid', 'claimed_guild', 'claimed_user_identifier', 'attribution']) {
      expect(m, k).toContain(k);
    }
  });

  it('says in the function comment that the attribution is not trustworthy', () => {
    expect(m).toContain('CLIENT-DECLARED and must not be trusted for forensics');
  });
});

describe('C1 — session revocation is now real, not merely documented', () => {
  // ADR + migration 20260913130000 claimed pre-bump tokens would fail "on any
  // policy that invokes it". Queried live: ZERO policies invoked it. Meanwhile
  // admin-accounts bumped the epoch with the comment "pre-reset access/refresh
  // tokens must stop matching", and nothing made them stop.

  const token = (appMetadata) => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u', app_metadata: appMetadata })}.sig`;
  };

  it('reads the epoch from the token payload', () => {
    expect(readTokenSessionVersion(token({ session_version: 7 }))).toBe(7);
    expect(readTokenSessionVersion(token({ session_version: '7' }))).toBe(7);
  });

  it('revokes a token whose epoch the account has moved past', () => {
    expect(isSessionRevoked(token({ session_version: 2 }), 3)).toBe(true);
    expect(isSessionRevoked(token({ session_version: 3 }), 3)).toBe(false);
  });

  it('treats epoch 0 as a real epoch, not as an absent claim', () => {
    // 150 of 171 accounts sit at version 0. A `if (!raw)` test would have
    // classified every one of their tokens as "legacy" and made them
    // permanently unrevocable -- the exact failure this check exists to close.
    expect(readTokenSessionVersion(token({ session_version: 0 }))).toBe(0);
    expect(isSessionRevoked(token({ session_version: 0 }), 0)).toBe(false);
    expect(isSessionRevoked(token({ session_version: 0 }), 1)).toBe(true);
  });

  it('tolerates a token minted before the claim existed', () => {
    // 122 of 171 GoTrue users carried no such claim. Refusing them would have
    // cut database access for 71% of the user base on deploy.
    expect(readTokenSessionVersion(token({ app_role: 'member' }))).toBe(null);
    expect(isSessionRevoked(token({ app_role: 'member' }), 4)).toBe(false);
  });

  it('never throws on a malformed token', () => {
    for (const bad of ['', 'x', 'a.b', 'a.!!!.c', 'a.eyJ9.c', null, undefined]) {
      expect(() => isSessionRevoked(bad, 1)).not.toThrow();
      expect(isSessionRevoked(bad, 1)).toBe(false);
    }
  });

  it('defaults a null account version to 0 rather than passing everything', () => {
    expect(isSessionRevoked(token({ session_version: 0 }), null)).toBe(false);
    expect(isSessionRevoked(token({ session_version: 5 }), null)).toBe(true);
  });

  it('does not compare the epoch getUser() reports, which is the live row', () => {
    // getUser() answers from the CURRENT auth.users row, so its session_version
    // is always the freshly bumped one; comparing it to accounts would compare
    // the database to itself and pass every time.
    const epoch = stripComments(read('supabase/functions/_shared/session-epoch.ts'));
    expect(epoch).not.toContain('user.app_metadata');
    expect(epoch).toContain("split(\".\")[1]");
  });

  it('wires the check into every JWT-validating entry point', () => {
    // Six functions share validateCallerAuth; three validate their own JWT and
    // would otherwise have kept serving a revoked token with the service key.
    for (const f of [
      '_shared/auth.ts',
      'admin-accounts/index.ts',
      'member-portal/index.ts',
      'auth-passkey/index.ts',
    ]) {
      const src = read(`supabase/functions/${f}`);
      expect(src, `${f} must consult the epoch`).toContain('isSessionRevoked(jwt,');
      expect(src, `${f} must select session_version`).toMatch(/\.select\("[^"]*session_version/);
    }
  });

  it('checks the epoch only after the signature has been verified', () => {
    const auth = stripComments(read('supabase/functions/_shared/auth.ts'));
    const verifyAt = auth.indexOf('auth.getUser(jwt)');
    const epochAt = auth.indexOf('isSessionRevoked(jwt,');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(epochAt, 'decoding must follow verification').toBeGreaterThan(verifyAt);
  });

  it('reports revocation distinctly from suspension', () => {
    const auth = read('supabase/functions/_shared/auth.ts');
    expect(auth).toContain('sessionRevoked: boolean');
    expect(auth).toContain('sessionRevoked: true');
  });
});

describe('C1 — the migration folds the check into the policy helpers', () => {
  const m = read('supabase/migrations/20260926250000_real_session_revocation.sql');

  it('backfills the claim before enforcing it', () => {
    // Enforcing first would have refused the 122 users who had no claim.
    const backfillAt = m.indexOf('UPDATE auth.users');
    const defineAt = m.indexOf('CREATE OR REPLACE FUNCTION public.gm_session_is_valid');
    expect(backfillAt).toBeGreaterThan(-1);
    expect(backfillAt, 'the backfill must come first').toBeLessThan(defineAt);
    expect(m).toContain("? 'session_version')");
  });

  it('tolerates an absent claim and refuses a stale one', () => {
    expect(m).toContain('THEN true');
    expect(m).toContain('a.session_version =');
    expect(m).toContain("a.status = 'active'");
  });

  it('covers the 77 policy references by editing six functions, not 100+ policies', () => {
    for (const fn of [
      'gm_is_admin_caller',
      'is_super_admin',
      'gm_can_read_guilds',
      'check_user_guild_access',
      'check_user_guild_write_access',
      'gm_can_read_guild_data',
    ]) {
      const at = m.indexOf(`FUNCTION public.${fn}`);
      expect(at, `${fn} must be redefined`).toBeGreaterThan(-1);
      const body = m.slice(at, m.indexOf('$$;', at));
      expect(body, `${fn} must consult the epoch`).toContain('gm_session_is_valid()');
    }
  });

  it('asserts its own postconditions', () => {
    expect(m).toContain('still lack the session_version claim');
    expect(m).toContain('of 6 RLS helpers consult gm_session_is_valid');
  });
});
