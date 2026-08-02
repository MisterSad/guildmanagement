import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '../gm-utils.js';

const GM = window.GM;

describe('registerPlayer (player self-registration)', () => {
    beforeEach(() => {
        localStorage.clear();
        GM.db = null;
    });

    afterEach(() => {
        GM.db = null;
    });

    it('invokes player-register edge function with the provided fields', async () => {
        let invoked = null;
        GM.db = {
            functions: {
                invoke: async (name, opts) => {
                    invoked = { name, opts };
                    return { data: { ok: true, status: 'pending' } };
                },
            },
        };
        const res = await GM.registerPlayer('myname', 'secretpass1', '123456789', 'FGF-ABCD-EFGH');
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
        GM.db = {
            functions: {
                invoke: async (_name, opts) => {
                    body = opts.body;
                    return { data: { ok: true } };
                },
            },
        };
        await GM.registerPlayer('  myname  ', 'secretpass1', ' 123456789 ', ' FGF-X-Y ');
        expect(body).toEqual({
            id: 'myname',
            password: 'secretpass1',
            uid: '123456789',
            code: 'FGF-X-Y',
        });
    });

    it('propagates edge function error codes', async () => {
        GM.db = {
            functions: {
                invoke: async () => ({ data: { ok: false, error: 'invalid_code' } }),
            },
        };
        expect(await GM.registerPlayer('a', 'b', 'c', 'd')).toEqual({ ok: false, error: 'invalid_code' });
    });

    it('returns request_failed when the invoke throws', async () => {
        GM.db = {
            functions: {
                invoke: async () => { throw new Error('network'); },
            },
        };
        expect(await GM.registerPlayer('a', 'b', 'c', 'd')).toEqual({ ok: false, error: 'request_failed' });
    });

    it('returns no_client without a supabase client', async () => {
        expect(await GM.registerPlayer('a', 'b', 'c', 'd')).toEqual({ ok: false, error: 'no_client' });
    });
});

describe('generateJoinCode', () => {
    it('produces a code in the FGF-XXXX-XXXX shape', () => {
        const code = GM.generateJoinCode('FGF');
        expect(code).toMatch(/^FGF-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it('uses a custom prefix when provided', () => {
        expect(GM.generateJoinCode('TST')).toMatch(/^TST-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it('defaults the prefix to FGF', () => {
        expect(GM.generateJoinCode()).toMatch(/^FGF-/);
    });
});
