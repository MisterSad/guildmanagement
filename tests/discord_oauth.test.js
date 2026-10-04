// Phase D2: the pure half of the Discord OAuth flow.
//
// `_shared/discord-oauth.ts` holds every security-relevant computation of the
// authorization-code flow — the PKCE pair, the authorize URL that pins the
// scope, the snowflake parsing the account-age guardrail depends on, and the
// return-URL assembly that must not become an open redirect. It is kept free
// of Deno.env, network and database access precisely so it can be exercised
// here rather than only in production.

import { describe, it, expect } from 'vitest';
import {
  DISCORD_EPOCH_MS,
  DISCORD_SCOPE,
  base64UrlEncode,
  randomToken,
  generatePkcePair,
  buildAuthorizeUrl,
  snowflakeToDate,
  snowflakeAgeDays,
  buildReturnUrl,
  buildErrorReturnUrl,
} from '../supabase/functions/_shared/discord-oauth.ts';

describe('base64url encoding', () => {
  it('produces URL-safe output with no padding', () => {
    // 0xFB 0xFF exercises both characters that differ from standard base64.
    const out = base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xfe, 0x00]));
    expect(out).not.toContain('+');
    expect(out).not.toContain('/');
    expect(out).not.toContain('=');
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips through atob', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const b64 = base64UrlEncode(bytes).replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const back = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    expect([...back]).toEqual([...bytes]);
  });
});

describe('randomToken', () => {
  it('is URL-safe and does not repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const t = randomToken(32);
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      seen.add(t);
    }
    expect(seen.size, 'every token must be distinct').toBe(200);
  });
});

describe('PKCE pair', () => {
  it('verifier length sits inside the RFC 7636 43..128 range', async () => {
    const { verifier } = await generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('challenge is the S256 digest of the verifier, not the verifier itself', async () => {
    const { verifier, challenge, method } = await generatePkcePair();
    expect(method).toBe('S256');
    expect(challenge).not.toBe(verifier);

    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(challenge).toBe(base64UrlEncode(new Uint8Array(digest)));
  });

  it('never reuses a verifier', async () => {
    const a = await generatePkcePair();
    const b = await generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('authorize URL', () => {
  const url = () =>
    buildAuthorizeUrl({
      clientId: '123456789012345678',
      redirectUri: 'https://ref.supabase.co/functions/v1/auth-discord/callback',
      state: 'st-ate',
      codeChallenge: 'chal-lenge',
    });

  it('requests identify and nothing else', () => {
    const p = new URL(url()).searchParams;
    expect(DISCORD_SCOPE).toBe('identify');
    expect(p.get('scope')).toBe('identify');
    // Two scopes we must never ask for: we store no e-mail, and the bot
    // already knows its guilds through the Gateway worker.
    expect(p.get('scope')).not.toContain('email');
    expect(p.get('scope')).not.toContain('guilds');
  });

  it('carries the S256 challenge, never the verifier', () => {
    const p = new URL(url()).searchParams;
    expect(p.get('code_challenge')).toBe('chal-lenge');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(url()).not.toContain('code_verifier');
  });

  it('is an authorization-code request against discord.com', () => {
    const u = new URL(url());
    expect(u.origin).toBe('https://discord.com');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('st-ate');
    expect(u.searchParams.get('redirect_uri')).toBe('https://ref.supabase.co/functions/v1/auth-discord/callback');
  });
});

describe('snowflake parsing', () => {
  it('decodes a known snowflake to its creation instant', () => {
    // The smallest valid snowflake is Discord's own epoch.
    expect(snowflakeToDate('0'.padStart(17, '0'))?.getTime()).toBe(DISCORD_EPOCH_MS);
    // 1 << 22 is exactly one millisecond after the epoch.
    expect(snowflakeToDate(String(2 ** 22).padStart(17, '0'))?.getTime()).toBe(DISCORD_EPOCH_MS + 1);
  });

  it('rejects anything that is not a plausible snowflake', () => {
    // Returning epoch-0 for junk would let a malformed id sail through an
    // "older than N days" guardrail.
    for (const bad of [
      '',
      'abc',
      '123',
      '12345678901234567890123',
      '-12345678901234567',
      '1.5e19',
      null,
      undefined,
      {},
    ]) {
      expect(snowflakeToDate(bad), String(bad)).toBeNull();
      expect(snowflakeAgeDays(bad), String(bad)).toBeNull();
    }
  });

  it('computes whole days of account age', () => {
    const created = DISCORD_EPOCH_MS + 1000;
    const snowflake = String(BigInt(1000) << 22n).padStart(17, '0');
    expect(snowflakeToDate(snowflake)?.getTime()).toBe(created);
    expect(snowflakeAgeDays(snowflake, created + 30 * 86_400_000)).toBe(30);
    expect(snowflakeAgeDays(snowflake, created + 30 * 86_400_000 - 1)).toBe(29);
    expect(snowflakeAgeDays(snowflake, created)).toBe(0);
  });
});

describe('return URLs cannot become an open redirect', () => {
  it('drops any path, query or fragment carried on the origin', () => {
    // The origin is validated by isAllowedOrigin before it is ever stored, but
    // assembling must not preserve an attacker-chosen path even so.
    expect(buildReturnUrl('https://app.example.com/evil/path?x=1#frag', 'TICK')).toBe(
      'https://app.example.com/?gm_auth=TICK'
    );
    expect(buildErrorReturnUrl('https://app.example.com/evil?x=1', 'state_expired')).toBe(
      'https://app.example.com/?gm_auth_error=state_expired'
    );
  });

  it('percent-encodes the ticket', () => {
    expect(buildReturnUrl('https://app.example.com', 'a+b/c=d')).toBe('https://app.example.com/?gm_auth=a%2Bb%2Fc%3Dd');
  });

  it('keeps a non-default port, which localhost development needs', () => {
    expect(buildReturnUrl('http://localhost:5173', 'T')).toBe('http://localhost:5173/?gm_auth=T');
  });
});
