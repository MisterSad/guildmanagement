// Guards the Edge Function <-> config.toml contract.
//
// Every deployable function under supabase/functions/ must have an explicit
// [functions.<name>] block in supabase/config.toml carrying a boolean
// verify_jwt. A missing block silently defaults to verify_jwt = true during
// `supabase functions deploy`, which breaks any unauthenticated endpoint
// (password login, public self-service, signature- or secret-authenticated
// webhooks) -- the exact regression that hit the former auth-passkey and
// guild-request. See PROJECT_CONTEXT.md / ARCHITECTURE.md.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const FUNCTIONS_DIR = path.resolve(__dirname, '../supabase/functions');
const CONFIG_PATH = path.resolve(__dirname, '../supabase/config.toml');
const configSrc = fs.readFileSync(CONFIG_PATH, 'utf-8');

// Subdirectories are deployable functions; _shared only holds imported
// modules and is never deployed as an endpoint of its own.
function listFunctionNames() {
  return fs
    .readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    // A leading underscore marks a non-function directory (_shared, _test), as the
    // Supabase CLI and scripts/deploy-edge-functions.sh treat it.
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort();
}

// Parses every [functions.<name>] block into Map<name, true|false|undefined>,
// the value being verify_jwt (undefined when the key is absent).
function parseFunctionBlocks() {
  const headerRe = /^\[functions\.([A-Za-z0-9_-]+)\]\s*$/gm;
  const headers = [...configSrc.matchAll(headerRe)];
  const blocks = new Map();

  headers.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < headers.length ? headers[index + 1].index : configSrc.length;
    const body = configSrc.slice(start, end);
    const jwt = body.match(/^\s*verify_jwt\s*=\s*(true|false)\s*$/m);
    blocks.set(match[1], jwt ? jwt[1] === 'true' : undefined);
  });

  return blocks;
}

const functionNames = listFunctionNames();
const functionBlocks = parseFunctionBlocks();

describe('supabase/config.toml Edge Function coverage', () => {
  it('discovers the deployable Edge Functions and excludes _shared', () => {
    expect(functionNames.length).toBeGreaterThan(0);
    expect(functionNames).not.toContain('_shared');
  });

  it('declares a [functions.<name>] block for every function directory', () => {
    const missing = functionNames.filter((name) => !functionBlocks.has(name));
    expect(missing, `Missing config.toml block(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('sets an explicit boolean verify_jwt on every declared function', () => {
    const missing = functionNames.filter((name) => typeof functionBlocks.get(name) !== 'boolean');
    expect(missing, `Missing explicit verify_jwt: ${missing.join(', ')}`).toEqual([]);
  });

  it('has no stale [functions.*] block without a matching function directory', () => {
    const stale = [...functionBlocks.keys()].filter((name) => !functionNames.includes(name));
    expect(stale, `Stale config block(s): ${stale.join(', ')}`).toEqual([]);
  });

  it('keeps unauthenticated endpoints on verify_jwt = false', () => {
    // These authenticate by their own means (password,
    // public self-service, Ed25519 signature, shared secret, webhook
    // signature, or cron secret) -- no Supabase JWT exists at call time.
    for (const name of [
      'auth-login',
      'player-register',
      'guild-request',
      'event-reminders',
      'discord-bot-interactions',
      'discord-profile-verification',
    ]) {
      expect(functionBlocks.get(name), `${name} must be declared with verify_jwt = false`).toBe(false);
    }
  });

  it('keeps session-gated endpoints on verify_jwt = true', () => {
    for (const name of [
      'member-portal',
      'admin-accounts',
      'guild-data-export',
      'discord-webhook-proxy',
      'ocr-guild-members',
      'tickets',
      'migration-summary',
    ]) {
      expect(functionBlocks.get(name), `${name} must be declared with verify_jwt = true`).toBe(true);
    }
  });
});
