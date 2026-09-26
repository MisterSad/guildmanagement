/**
 * Supabase client construction contract.
 *
 * This suite used to assert the opposite of what the app does. Its premise was
 * "Absence of Sensitive Hardcoded Keys": the URL and key had to come from
 * `import.meta.env`, and `getSupabaseConfig()` / `validateSupabaseEnv()` had to
 * exist. That premise was wrong on two counts:
 *
 *   1. The key is a *publishable* key (`sb_publishable_…`), designed to ship to
 *      browsers and protected by RLS. Keeping it out of the bundle buys nothing;
 *      it is in the bundle either way.
 *   2. The env path was unreachable. `main.ts` deliberately builds the client
 *      from the compile-time constants ("never import.meta.env") and wraps it in
 *      `installDbWriteGuard` before publishing it as `window.GM.db`, so the
 *      fallback never ran -- and had it run, it would have produced a client
 *      that bypassed the multi-tenant write guard entirely.
 *
 * So the env plumbing was deleted, and this suite now locks in the real
 * contract: the constants are the single source, the client is only ever the
 * guarded `window.GM.db`, and no *secret* ever gets hardcoded.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getSupabaseClient, resetSupabaseClient } from '../src/core/api/supabase.ts';

const rootDir = path.resolve(__dirname, '..');
const supabaseApiContent = fs.readFileSync(path.join(rootDir, 'src/core/api/supabase.ts'), 'utf-8');
const constantsContent = fs.readFileSync(path.join(rootDir, 'src/core/config/constants.ts'), 'utf-8');
const mainContent = fs.readFileSync(path.join(rootDir, 'src/main.ts'), 'utf-8');
const envExampleContent = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf-8');

function readSrcFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) readSrcFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push([full, fs.readFileSync(full, 'utf8')]);
  }
  return out;
}

describe('the connection constants live in exactly one place', () => {
  it('keeps the URL and publishable key in constants.ts, not in the API module', () => {
    expect(constantsContent).toContain('export const SUPABASE_URL');
    expect(constantsContent).toContain('export const SUPABASE_KEY');
    expect(supabaseApiContent).not.toContain('vgweufzwmfwplusskmuf');
    expect(supabaseApiContent).not.toContain('sb_publishable_');
  });

  it('no longer carries the unreachable import.meta.env fallback', () => {
    // A client built from that path would have skipped installDbWriteGuard.
    // Comments are stripped first: the module documents *why* the fallback was
    // removed, and naming it in prose must not fail this assertion.
    const code = supabaseApiContent
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('import.meta.env');
    expect(code).not.toContain('getSupabaseConfig');
    expect(code).not.toContain('validateSupabaseEnv');
  });

  it('builds the one client in main.ts and wraps it in the tenant write guard', () => {
    expect(mainContent).toContain('installDbWriteGuard(rawClient)');
    const guardIdx = mainContent.indexOf('installDbWriteGuard(rawClient)');
    const assignIdx = mainContent.indexOf('wAny.GM.db =');
    // The guard must be applied in the same statement that publishes GM.db,
    // otherwise an unguarded client is briefly reachable.
    expect(assignIdx).toBeGreaterThan(-1);
    expect(mainContent.slice(assignIdx, assignIdx + 80)).toContain('installDbWriteGuard');
    expect(guardIdx).toBeGreaterThan(-1);
  });
});

describe('.env.example advertises only variables the app reads', () => {
  it('documents VITE_SENTRY_DSN, which constants.ts consumes', () => {
    expect(envExampleContent).toContain('VITE_SENTRY_DSN=');
    expect(constantsContent).toContain('VITE_SENTRY_DSN');
  });

  it('no longer advertises the Supabase variables, which nothing reads', () => {
    expect(envExampleContent).not.toContain('VITE_SUPABASE_URL=');
    expect(envExampleContent).not.toContain('VITE_SUPABASE_ANON_KEY=');
  });
});

describe('no secret is ever hardcoded in the client bundle', () => {
  // The publishable key is fine (it is designed to be public, and RLS is the
  // real control). A service-role key, a Stripe secret or a webhook signing
  // secret in src/ would be a live incident.
  const SECRET_PATTERNS = [
    /sb_secret_[A-Za-z0-9_-]{10,}/,
    /service_role["']?\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/,
    /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/,
    /\bwhsec_[A-Za-z0-9]{10,}/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./,
  ];

  it('contains no service-role key, Stripe secret, webhook secret or signed JWT', () => {
    const offenders = [];
    for (const [file, content] of readSrcFiles(path.join(rootDir, 'src'))) {
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) offenders.push(`${path.relative(rootDir, file)} :: ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('getSupabaseClient only ever returns the guarded client', () => {
  const originalGM = typeof window !== 'undefined' ? window.GM : undefined;

  beforeEach(() => {
    resetSupabaseClient();
  });

  afterEach(() => {
    if (typeof window !== 'undefined') window.GM = originalGM;
    resetSupabaseClient();
  });

  it('returns window.GM.db when main.ts has published it', () => {
    const fakeDb = { from: vi.fn(), rpc: vi.fn(), auth: {} };
    if (typeof window !== 'undefined') window.GM = { db: fakeDb };
    expect(getSupabaseClient()).toBe(fakeDb);
  });

  it('memoises that client across calls', () => {
    const fakeDb = { from: vi.fn(), rpc: vi.fn(), auth: {} };
    if (typeof window !== 'undefined') window.GM = { db: fakeDb };
    expect(getSupabaseClient()).toBe(getSupabaseClient());
  });

  it('returns null rather than fabricating an unguarded client when GM.db is absent', () => {
    if (typeof window !== 'undefined') window.GM = { db: null };
    expect(getSupabaseClient()).toBeNull();
  });
});
