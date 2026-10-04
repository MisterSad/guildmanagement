/**
 * Regression tests for the password `login()` path (src/core/auth/session.ts).
 *
 * Guards the reported production bug: an Edge gateway/error body without an
 * `ok`/`error` key used to be mapped to the bare "invalid" message, and a
 * stale deployment returning the minted session WITHOUT the `ok` flag could
 * lock users out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { login } from '../src/core/auth/session';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';

function setClient(invokeImpl) {
  const client = {
    functions: { invoke: invokeImpl },
    auth: {
      setSession: vi.fn().mockResolvedValue({ data: { session: {} }, error: null }),
    },
  };
  setDbClient(client);
  return client;
}

function invokeData(data) {
  return vi.fn().mockResolvedValue({ data });
}

beforeEach(() => {
  resetSupabaseClient();
});

describe('login() against the auth-login Edge Function', () => {
  it('accepts a nominal { ok: true } success payload', async () => {
    const invoke = invokeData({
      ok: true,
      role: 'super_admin',
      id: 'ADMIN',
      access_token: 'at',
      refresh_token: 'rt',
      has_passkey: false,
    });
    const client = setClient(invoke);

    const result = await login('ADMIN', 'secret');

    expect(result.ok).toBe(true);
    expect(result.role).toBe('super_admin');
    expect(result.id).toBe('ADMIN');
    expect(invoke).toHaveBeenCalledWith('auth-login', { body: { id: 'ADMIN', password: 'secret' } });
    expect(client.auth.setSession).toHaveBeenCalledWith({
      access_token: 'at',
      refresh_token: 'rt',
    });
  });

  it('accepts a legacy payload that mints a session without the ok flag', async () => {
    const client = setClient(
      invokeData({
        role: 'guild_admin',
        id: 'LEGACY',
        access_token: 'at-legacy',
        refresh_token: 'rt-legacy',
      })
    );

    const result = await login('LEGACY', 'secret');

    expect(result.ok).toBe(true);
    expect(result.role).toBe('guild_admin');
    expect(client.auth.setSession).toHaveBeenCalledWith({
      access_token: 'at-legacy',
      refresh_token: 'rt-legacy',
    });
  });

  it('surfaces the real gateway message instead of the bare "invalid"', async () => {
    setClient(
      invokeData({
        msg: 'Edge Function not found. Could not find a matching function for "/auth-login" in this project.',
      })
    );

    const result = await login('ADMIN', 'secret');

    expect(result.ok).toBe(false);
    expect(result.error).not.toBe('invalid');
    expect(result.error).toContain('Edge Function not found');
  });

  it('surfaces standard error codes from the function unchanged', async () => {
    setClient(invokeData({ ok: false, error: 'invalid_credentials' }));

    const result = await login('ADMIN', 'wrong');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_credentials');
  });

  it('returns request_failed when the invoke rejects', async () => {
    setClient(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const result = await login('ADMIN', 'secret');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('request_failed');
  });

  it('returns no_client when there is no Supabase client', async () => {
    resetSupabaseClient();
    const result = await login('ADMIN', 'secret');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_client');
  });
});
