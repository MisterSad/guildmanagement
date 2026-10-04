// FINDING M6 — `db-guard.ts` is 99 lines of security interception with no
// behavioural test of the interception itself.
//
// The existing coverage (view_teardown_and_cache.test.js) deliberately runs as
// a super_admin so `canWriteGuild()` short-circuits, which isolates cache
// invalidation and says nothing about the guard. This file covers what that one
// leaves out: the refusal path, the tenant stamp, and the two shapes the audit
// singled out as fragile -- `readOnlyResult()` returning a *thenable* rather
// than a real Promise, and `.eq('guild', …)` being appended AFTER `.delete()`
// and `.update()`.
//
// RLS remains the real boundary; this is defence in depth. But a defence nobody
// tests is a defence nobody can refactor safely, which is exactly the position
// phase 7 is about to put it in.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installDbWriteGuard,
  TENANT_TABLES,
  READ_ONLY_MESSAGE
} from '../src/core/api/db-guard.ts';
import { setVerifiedRole } from '../src/core/auth/roles.ts';
import { patchAppState, resetAppState } from '../src/core/state/app-state.ts';

/**
 * Supabase-builder stand-in that records the whole chain, including the order
 * in which the guard appends its filters.
 */
function fakeDb() {
  const calls = [];
  const makeBuilder = (table) => {
    const chain = [];
    const b = {
      table,
      chain,
      delete: (...a) => { chain.push(['delete', a]); calls.push({ table, op: 'delete', args: a }); return b; },
      update: (v, o) => { chain.push(['update', v]); calls.push({ table, op: 'update', values: v, options: o }); return b; },
      insert: (v, o) => { chain.push(['insert', v]); calls.push({ table, op: 'insert', values: v, options: o }); return b; },
      upsert: (v, o) => { chain.push(['upsert', v]); calls.push({ table, op: 'upsert', values: v, options: o }); return b; },
      eq: (col, val) => { chain.push(['eq', col, val]); return b; },
      select: (...a) => { chain.push(['select', a]); return b; }
    };
    return b;
  };
  return { from: (t) => makeBuilder(t), __calls: calls };
}

function asGuildAdmin(guild) {
  setVerifiedRole('guild_admin', 'tester');
  localStorage.setItem('gm_role', 'guild_admin');
  localStorage.setItem('gm_current_guild', guild);
  patchAppState({ currentGuildRestriction: guild });
}

beforeEach(() => {
  localStorage.clear();
  // After the clear, so no tenant is resolved until a test establishes one.
  resetAppState();
});

afterEach(() => {
  setVerifiedRole(null, null);
  localStorage.clear();
  resetAppState();
});

describe('M6 — the guard refuses a caller who may not write', () => {
  it('blocks all four verbs for a guild_admin with no restriction', async () => {
    // This is how a guild_admin is actually refused. `getActiveGuild()` gives
    // `currentGuildRestriction` priority over everything else, so the active
    // guild and the restriction can never disagree through that path -- the
    // refusal comes from the restriction being ABSENT, which the guild_admin
    // branch treats as "block" rather than "default to something".
    setVerifiedRole('guild_admin', 'tester');
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_current_guild', 'ALPHA');

    const raw = fakeDb();
    const db = installDbWriteGuard(raw);

    for (const op of ['delete', 'update', 'insert', 'upsert']) {
      const b = db.from('guild_members');
      const res = await (op === 'delete' ? b.delete() : b[op]({ pseudo: 'x' }));
      expect(res.error, `${op} must be refused`).toBeTruthy();
      expect(res.error.message).toBe(READ_ONLY_MESSAGE);
      expect(res.data).toBeNull();
    }
    expect(raw.__calls, 'nothing may reach the client').toEqual([]);
  });

  it('blocks every verb when no tenant is resolved, even for a super_admin', () => {
    // FINDING H2. `canWriteGuild()` returns true unconditionally for a
    // super_admin, so without the explicit null check the guard would stamp
    // `guild: null` onto the row or filter on it.
    setVerifiedRole('super_admin', 'tester');
    localStorage.setItem('gm_role', 'super_admin');
    // No gm_current_guild, no restriction: getActiveGuild() is null.

    const raw = fakeDb();
    const db = installDbWriteGuard(raw);
    const res = db.from('guild_members').insert({ pseudo: 'x' });

    expect(raw.__calls).toEqual([]);
    return Promise.resolve(res).then((r) => {
      expect(r.error.message).toBe(READ_ONLY_MESSAGE);
    });
  });

  it('lets a guild_admin write inside their own guild', () => {
    asGuildAdmin('ALPHA');
    const raw = fakeDb();
    const db = installDbWriteGuard(raw);
    db.from('guild_members').insert({ pseudo: 'x' });
    expect(raw.__calls.length).toBe(1);
    expect(raw.__calls[0].op).toBe('insert');
  });
});

describe('M6 — readOnlyResult is a thenable, and must behave like a result', () => {
  // The audit flagged this precisely: it is NOT a real Promise, so anything a
  // caller does beyond `await` is worth pinning.
  beforeEach(() => {
    // A guild_admin with no restriction: blocked (see the note above).
    setVerifiedRole('guild_admin', 'tester');
    localStorage.setItem('gm_role', 'guild_admin');
    localStorage.setItem('gm_current_guild', 'ALPHA');
  });

  const refused = () => installDbWriteGuard(fakeDb()).from('guild_members').delete();

  it('resolves under await', async () => {
    const r = await refused();
    expect(r.error.message).toBe(READ_ONLY_MESSAGE);
  });

  it('resolves under .then()', async () => {
    const r = await new Promise((resolve) => { refused().then(resolve); });
    expect(r.error.message).toBe(READ_ONLY_MESSAGE);
  });

  it('survives Promise.resolve(), which is how most helpers normalise it', async () => {
    const r = await Promise.resolve(refused());
    expect(r.error.message).toBe(READ_ONLY_MESSAGE);
  });

  it('rejects nothing: a refusal is a value, not an exception', async () => {
    // A caller that only guards with try/catch must still see the error object,
    // otherwise a blocked write reads as a successful one.
    let threw = false;
    let value = null;
    try {
      value = await refused();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(value.error).toBeTruthy();
  });

  it('is documented as a thenable rather than silently pretending to be a Promise', () => {
    expect(refused() instanceof Promise).toBe(false);
    expect(typeof refused().then).toBe('function');
  });
});

describe('M6 — the tenant filter and stamp', () => {
  beforeEach(() => asGuildAdmin('ALPHA'));

  it('appends .eq(guild) AFTER delete and update', () => {
    // This is the fragile ordering the audit named: the filter is chained onto
    // the result of `.delete()`, so a caller that chains `.select()` first gets
    // a different builder shape.
    const raw = fakeDb();
    const db = installDbWriteGuard(raw);

    const d = db.from('guild_members').delete();
    expect(d.chain.map((c) => c[0])).toEqual(['delete', 'eq']);
    expect(d.chain[1]).toEqual(['eq', 'guild', 'ALPHA']);

    const u = db.from('guild_members').update({ role: 'R2' });
    expect(u.chain.map((c) => c[0])).toEqual(['update', 'eq']);
    expect(u.chain[1]).toEqual(['eq', 'guild', 'ALPHA']);
  });

  it('stamps the active guild onto an insert that omits one', () => {
    const raw = fakeDb();
    const db = installDbWriteGuard(raw);
    db.from('guild_members').insert({ pseudo: 'x' });
    expect(raw.__calls[0].values.guild).toBe('ALPHA');
  });

  it('does not overwrite a guild the caller set deliberately', () => {
    const raw = fakeDb();
    const db = installDbWriteGuard(raw);
    db.from('guild_members').insert({ pseudo: 'x', guild: 'ALPHA' });
    expect(raw.__calls[0].values.guild).toBe('ALPHA');
  });

  it('stamps every row of a batch insert, and copies rather than mutates', () => {
    const raw = fakeDb();
    const db = installDbWriteGuard(raw);
    const rows = [{ pseudo: 'a' }, { pseudo: 'b' }];
    db.from('guild_members').insert(rows);
    expect(raw.__calls[0].values.map((r) => r.guild)).toEqual(['ALPHA', 'ALPHA']);
    expect(rows[0].guild, "the caller's own array must not be mutated").toBeUndefined();
  });

  it('stamps upsert the same way, and forwards its options', () => {
    const raw = fakeDb();
    const db = installDbWriteGuard(raw);
    db.from('guild_members').upsert({ pseudo: 'x' }, { onConflict: 'guild,pseudo' });
    expect(raw.__calls[0].values.guild).toBe('ALPHA');
    expect(raw.__calls[0].options).toEqual({ onConflict: 'guild,pseudo' });
  });
});

describe('M6 — what the guard deliberately does not touch', () => {
  beforeEach(() => asGuildAdmin('ALPHA'));

  it('leaves a non-tenant table completely alone', () => {
    const raw = fakeDb();
    const db = installDbWriteGuard(raw);
    const b = db.from('accounts').delete();
    // No guild filter appended, and the write is not refused: `accounts` is
    // governed by RLS and the admin-accounts Edge Function, not by this guard.
    expect(b.chain.map((c) => c[0])).toEqual(['delete']);
    expect(TENANT_TABLES).not.toContain('accounts');
  });

  it('never guards reads', () => {
    const raw = fakeDb();
    const db = installDbWriteGuard(raw);
    const b = db.from('guild_members').select('*');
    expect(b.chain.map((c) => c[0])).toEqual(['select']);
  });

  it('is idempotent, so a double install cannot double-stamp', () => {
    const raw = fakeDb();
    const once = installDbWriteGuard(raw);
    const twice = installDbWriteGuard(once);
    expect(twice).toBe(once);
    twice.from('guild_members').insert({ pseudo: 'x' });
    expect(raw.__calls.length).toBe(1);
    expect(raw.__calls[0].values.guild).toBe('ALPHA');
  });

  it('returns a client it cannot understand untouched', () => {
    expect(installDbWriteGuard(null)).toBe(null);
    const notAClient = { hello: 1 };
    expect(installDbWriteGuard(notAClient)).toBe(notAClient);
  });
});
