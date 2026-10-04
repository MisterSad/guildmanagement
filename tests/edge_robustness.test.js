// Short-term plan, phase 3: Edge Function robustness and dependencies
// (audit SEC-12, BE-A-12, BE-A-15, SEC-13, INF-05, SEC-19).

import { describe, it, expect } from 'vitest';
import { squash } from './helpers/source-text.js';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : (/\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []));
}

describe('the Discord verification limiter fails closed (SEC-12, AGENTS.md rule 7)', () => {
  const src = read('supabase/functions/_shared/rate-limit.ts');
  const fn = src.slice(src.indexOf('export async function checkAndRecordDiscordAttempt('),
                       src.indexOf('export async function checkAndRecordIpAttempt('));

  it('delegates to one atomic RPC on its own table', () => {
    expect(fn).toContain('admin.rpc("gm_check_verification_throttle"');
    expect(fn).not.toContain('.from("discord_verification_throttle")');
    const sql = read('supabase/migrations/20261003114333_atomic_verification_throttle.sql');
    expect(sql).toContain('ON CONFLICT (discord_user_id, window_start) DO UPDATE');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.gm_check_verification_throttle\(text, integer, bigint, timestamptz\) FROM PUBLIC, anon, authenticated;/);
  });

  it('never answers "allowed" on an error', () => {
    expect(fn).not.toMatch(/allowed:\s*true/);
    expect(fn.match(/return \{ allowed: false, remaining: 0 \};/g).length).toBeGreaterThanOrEqual(3);
  });
});

describe('bounded inputs (BE-A-15, SEC-13)', () => {

  it('player-register bounds the password and the code, and leaks no DB message', () => {
    const src = read('supabase/functions/player-register/index.ts');
    expect(src).toContain('if (password.length > 128)');
    expect(src).toContain('if (code.length > 64)');
    expect(src).not.toContain('message: error.message');
  });

  it('guild-data-export is rate-limited and checks the guild shape', () => {
    const src = read('supabase/functions/guild-data-export/index.ts');
    expect(squash(src)).toContain(squash('checkAndRecordIpAttempt(admin, extractClientIp(req.headers), { limit: 5, windowMs: 10 * 60_000 })'));
    expect(squash(src)).toContain(squash("/^[A-Za-z0-9_]{2,12}$/.test(body.guild.trim())"));
  });

  it('discord-webhook-proxy bounds what it relays to Discord limits', () => {
    const src = read('supabase/functions/discord-webhook-proxy/index.ts');
    expect(src).toContain('payload.content.length > 2000');
    expect(src).toContain('payload.embeds.length > 10');
    expect(src).toContain('JSON.stringify(payload ?? {}).length > 60_000');
  });

  it('ocr-guild-members bounds each image and its MIME type', () => {
    const src = read('supabase/functions/ocr-guild-members/index.ts');
    expect(squash(src)).toContain(squash('base64Data: z.string().min(1).max(8 * 1024 * 1024),'));
    expect(squash(src)).toMatch(/mimeType: z\.string\(\)\.regex\(/);
  });

  it('auth-passkey is gone: passkeys were removed (owner decision, 2026-10-03)', () => {
    expect(fs.existsSync(path.resolve(root, 'supabase/functions/auth-passkey'))).toBe(false);
  });
});

describe('reproducible Edge bundles (INF-05, SEC-19)', () => {
  it('every remote import names an exact version', () => {
    const offenders = [];
    for (const f of walk(path.join(root, 'supabase/functions'))) {
      for (const m of fs.readFileSync(f, 'utf-8').matchAll(/"(https:\/\/esm\.sh\/[^"]+|npm:[^"]+)"/g)) {
        // @scope/name@1.2.3 or name@1.2.3, optionally followed by a path.
        if (!/@\d+\.\d+\.\d+(\/|$)/.test(m[1])) offenders.push(`${path.relative(root, f)}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
