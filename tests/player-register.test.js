import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerPlayer, generateJoinCode } from '../src/core/auth/session';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';

describe('registerPlayer (player self-registration)', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSupabaseClient();
  });

  afterEach(() => {
    resetSupabaseClient();
  });

  it('invokes player-register edge function with the provided fields', async () => {
    let invoked = null;
    setDbClient({
      functions: {
        invoke: async (name, opts) => {
          invoked = { name, opts };
          return { data: { ok: true, status: 'pending' } };
        },
      },
    });
    const res = await registerPlayer('myname', 'secretpass1', '123456789', 'FGF-ABCD-EFGH');
    expect(invoked.name).toBe('player-register');
    expect(invoked.opts.body).toEqual({
      id: 'myname',
      password: 'secretpass1',
      uid: '123456789',
      code: 'FGF-ABCD-EFGH',
    });
    expect(res).toEqual({ ok: true, status: 'pending' });
  });

  it('trims identifier, uid and code before sending', async () => {
    let body = null;
    setDbClient({
      functions: {
        invoke: async (_name, opts) => {
          body = opts.body;
          return { data: { ok: true } };
        },
      },
    });
    await registerPlayer('  myname  ', 'secretpass1', ' 123456789 ', ' FGF-X-Y ');
    expect(body).toEqual({
      id: 'myname',
      password: 'secretpass1',
      uid: '123456789',
      code: 'FGF-X-Y',
    });
  });

  it('propagates edge function error codes', async () => {
    setDbClient({
      functions: {
        invoke: async () => ({ data: { ok: false, error: 'invalid_code' } }),
      },
    });
    expect(await registerPlayer('a', 'b', 'c', 'd')).toEqual({ ok: false, error: 'invalid_code' });
  });

  it('recovers edge function error codes from non-2xx responses via parseFunctionsInvokeResult', async () => {
    setDbClient({
      functions: {
        invoke: async () => ({
          data: null,
          error: {
            message: 'Edge Function returned a non-2xx status code',
            context: {
              clone: () => ({
                json: async () => ({ ok: false, error: 'uid_not_in_guild' }),
              }),
            },
          },
        }),
      },
    });
    expect(await registerPlayer('a', 'b', '12345678', 'FGF-ABCD-EFGH')).toEqual({
      ok: false,
      error: 'uid_not_in_guild',
    });
  });

  it('returns request_failed when the invoke throws', async () => {
    setDbClient({
      functions: {
        invoke: async () => {
          throw new Error('network');
        },
      },
    });
    expect(await registerPlayer('a', 'b', 'c', 'd')).toEqual({ ok: false, error: 'request_failed' });
  });

  it('returns no_client without a supabase client', async () => {
    expect(await registerPlayer('a', 'b', 'c', 'd')).toEqual({ ok: false, error: 'no_client' });
  });
});

describe('generateJoinCode', () => {
  it('produces a code in the FGF-XXXX-XXXX shape', () => {
    const code = generateJoinCode('FGF');
    expect(code).toMatch(/^FGF-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('uses a custom prefix when provided', () => {
    expect(generateJoinCode('TST')).toMatch(/^TST-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('defaults the prefix to FGF', () => {
    expect(generateJoinCode()).toMatch(/^FGF-/);
  });
});
