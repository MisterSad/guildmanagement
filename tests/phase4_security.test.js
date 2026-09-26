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
