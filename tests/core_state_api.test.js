/**
 * tests/core_state_api.test.js
 *
 * Phase 1 (Sous-lot 5.2B) suite for the state/API/RBAC helpers ported from
 * gm-utils.js into /src/core. The legacy root script is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import * as cache from '../src/core/cache/cache';
import * as guildConfig from '../src/core/config/guild-config';
import { parseFunctionsInvokeResult } from '../src/core/api/supabase';
import * as roles from '../src/core/auth/roles';

function makeDb(opts = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      return {
        select() {
          // The eq() arguments are recorded so a test can prove WHICH tenant was
          // queried. They used to be discarded, which is why nothing caught
          // getGuildConfig ignoring its guild argument (finding H2).
          const filters = {};
          const chain = {
            eq(col, val) {
              filters[col] = val;
              return chain;
            },
            maybeSingle: async () => {
              calls.push({ op: 'select', table, filters });
              return { data: opts.selectValue !== undefined ? { value: opts.selectValue } : null, error: null };
            }
          };
          return chain;
        },
        upsert(payload) {
          calls.push({ op: 'upsert', table, payload });
          return Promise.resolve({ error: opts.upsertError || null });
        }
      };
    }
  };
  return db;
}

beforeEach(() => {
  localStorage.clear();
  cache.clear();
  delete window.currentGuildRestriction;
  delete window.currentGuild;
  delete window.guildsData;
  delete window.GM;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cache — TTL, invalidation, clear', () => {
  it('marks fresh, respects the TTL, and invalidates', () => {
    vi.useFakeTimers();
    expect(cache.isFresh('k', 1000)).toBe(false);
    cache.markFresh('k');
    expect(cache.isFresh('k', 1000)).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(cache.isFresh('k', 1000)).toBe(false);
    cache.markFresh('k');
    cache.invalidate('k');
    expect(cache.isFresh('k', 1000)).toBe(false);
  });

  it('invalidate() with no key clears everything; clear() aliases it', () => {
    cache.markFresh('a');
    cache.markFresh('b');
    cache.invalidate();
    expect(cache.isFresh('a', 10000)).toBe(false);
    expect(cache.isFresh('b', 10000)).toBe(false);
    cache.markFresh('c');
    cache.clear();
    expect(cache.isFresh('c', 10000)).toBe(false);
  });
});

describe('guild config — DB + localStorage', () => {
  // FINDING H2: these used to pass without ever setting a guild, because
  // getActiveGuild() invented 'ALPHA'. The tenant is now established explicitly
  // -- which is the point: config reads and writes must name their tenant.
  beforeEach(() => {
    localStorage.setItem('gm_current_guild', 'ALPHA');
  });

  it('reads the DB value when available', async () => {
    window.GM = { db: makeDb({ selectValue: '7' }) };
    expect(await guildConfig.getGuildConfig('coeff_svs')).toBe('7');
  });

  it('falls back to localStorage, then to the default table', async () => {
    window.GM = { db: makeDb({ selectValue: undefined }) };
    localStorage.setItem('gm_config_ALPHA_coeff_svs', '9');
    expect(await guildConfig.getGuildConfig('coeff_svs')).toBe('9');

    localStorage.clear();
    localStorage.setItem('gm_current_guild', 'ALPHA');
    expect(await guildConfig.getGuildConfig('coeff_gvg')).toBe('5');
    expect(await guildConfig.getGuildConfig('unknown_key')).toBe('');
  });

  it('writes to localStorage and upserts to the DB', async () => {
    const db = makeDb();
    window.GM = { db };
    const ok = await guildConfig.setGuildConfig('coeff_svs', '12');
    expect(ok).toBe(true);
    expect(localStorage.getItem('gm_config_ALPHA_coeff_svs')).toBe('12');
    const upsert = db.calls.find((c) => c.op === 'upsert');
    expect(upsert.payload).toMatchObject({ guild: 'ALPHA', key: 'coeff_svs', value: '12' });
  });

  it('returns false when the DB upsert errors', async () => {
    window.GM = { db: makeDb({ upsertError: { message: 'boom' } }) };
    expect(await guildConfig.setGuildConfig('coeff_svs', '1')).toBe(false);
  });

  it('H2: refuses to read or write config for an unresolved tenant', async () => {
    localStorage.removeItem('gm_current_guild');
    const db = makeDb({ selectValue: '7' });
    window.GM = { db };

    // The static fallback, NOT the DB value and NOT another tenant's value.
    expect(await guildConfig.getGuildConfig('coeff_svs')).toBe('5');
    expect(db.calls.find((c) => c.op === 'select')).toBeUndefined();

    // A write must fail loudly rather than land in a guessed tenant.
    expect(await guildConfig.setGuildConfig('coeff_svs', '12')).toBe(false);
    expect(db.calls.find((c) => c.op === 'upsert')).toBeUndefined();
  });

  it('getGuildTag brackets a stored tag, else derives one from the guild id', async () => {
    window.GM = { db: makeDb({ selectValue: 'PR1M' }) };
    expect(await guildConfig.getGuildTag('ALPHA')).toBe('[PR1M]');

    // H2: `DEFAULT_GUILD_TAGS` is gone -- a hardcoded table of 7 tags for 26
    // tenants, violating ADR-003. With no stored tag the id is used, exactly as
    // the other 19 guilds always did. Production is unaffected: guild_config
    // already holds a tag for all 7, and two of the hardcoded values were
    // actually WRONG (the DB says CLAW is [BYE] and DEMO is DEMO).
    window.GM = { db: makeDb({ selectValue: '' }) };
    expect(await guildConfig.getGuildTag('ALPHA')).toBe('[ALPHA]');
    expect(await guildConfig.getGuildTag('UNKNOWN')).toBe('[UNKNOWN]');
  });

  it('H2: honours the guild argument for the lookup, not just the fallback', async () => {
    // getGuildConfig used to resolve the tenant itself, so getGuildTag('CLAW')
    // returned the ACTIVE guild's tag while only its fallback read the argument.
    const db = makeDb({ selectValue: 'BYE' });
    window.GM = { db };
    localStorage.setItem('gm_current_guild', 'OMEGA');
    expect(await guildConfig.getGuildTag('CLAW')).toBe('[BYE]');
    const select = db.calls.find((c) => c.op === 'select');
    expect(select.filters.guild, 'must query CLAW, not the active guild').toBe('CLAW');
    expect(select.filters.key).toBe('guild_tag');
  });

  it('H2: yields no tag at all when no guild can be resolved', async () => {
    localStorage.removeItem('gm_current_guild');
    window.GM = { db: makeDb({ selectValue: 'PR1M' }) };
    expect(await guildConfig.getGuildTag()).toBe('');
  });
});

describe('parseFunctionsInvokeResult', () => {
  it('returns the data payload on success', async () => {
    expect(await parseFunctionsInvokeResult({ data: { ok: true } })).toEqual({ ok: true });
  });

  it('recovers the JSON body from a non-2xx error context', async () => {
    const body = { ok: false, error: 'rate_limited' };
    const result = { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { clone: () => ({ json: async () => body }) } } };
    expect(await parseFunctionsInvokeResult(result)).toEqual(body);
  });

  it('falls back to the error message when the context is not JSON', async () => {
    const result = { data: null, error: { message: 'unauthorized', context: { clone: () => ({ json: async () => { throw new Error('no json'); } }) } } };
    expect(await parseFunctionsInvokeResult(result)).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('returns request_failed for an empty result', async () => {
    expect(await parseFunctionsInvokeResult(null)).toEqual({ ok: false, error: 'request_failed' });
  });
});

describe('RBAC — roles & write access', () => {
  it('roleFromStorage normalizes and promotes restricted members', () => {
    localStorage.setItem('gm_role', 'super_admin');
    expect(roles.roleFromStorage()).toBe('super_admin');
    localStorage.setItem('gm_role', 'guild_admin');
    expect(roles.roleFromStorage()).toBe('guild_admin');
    localStorage.setItem('gm_role', 'R5');
    expect(roles.roleFromStorage()).toBe('member');
    localStorage.setItem('gm_role', 'R4');
    expect(roles.roleFromStorage()).toBe('member');
    localStorage.setItem('gm_role', 'member');
    localStorage.setItem('gm_server_restriction', '1234');
    expect(roles.roleFromStorage()).toBe('server_admin');
  });

  it('isSuperAdmin / isServerAdmin / isGuildAdmin follow the stored role', () => {
    localStorage.setItem('gm_role', 'guild_admin');
    expect(roles.isGuildAdmin()).toBe(true);
    expect(roles.isSuperAdmin()).toBe(false);
    localStorage.setItem('gm_role', 'super_admin');
    expect(roles.isSuperAdmin()).toBe(true);
    expect(roles.isServerAdmin()).toBe(true);
  });

  it('canWriteGuild: super_admin always, guild_admin only on its guild', () => {
    localStorage.setItem('gm_role', 'super_admin');
    expect(roles.canWriteGuild('ANY')).toBe(true);

    localStorage.setItem('gm_role', 'guild_admin');
    window.currentGuildRestriction = 'ALPHA';
    expect(roles.canWriteGuild('ALPHA')).toBe(true);
    expect(roles.canWriteGuild('BETA')).toBe(false);
    delete window.currentGuildRestriction;
    expect(roles.canWriteGuild('ALPHA')).toBe(false); // never fall back
  });

  it('canWriteGuild: server_admin limited to its server number', () => {
    localStorage.setItem('gm_role', 'member');
    localStorage.setItem('gm_server_restriction', '1234');
    window.currentGuild = 'ALPHA';
    window.guildsData = { ALPHA: { server_number: '1234' }, BETA: { server_number: '9999' } };
    expect(roles.canWriteGuild('ALPHA')).toBe(true);
    expect(roles.canWriteGuild('BETA')).toBe(false);
  });

  it('members cannot write', () => {
    localStorage.setItem('gm_role', 'member');
    window.currentGuild = 'ALPHA';
    expect(roles.canWriteGuild('ALPHA')).toBe(false);
  });

  it('getActiveGuild / getCurrentPseudo / currentAccountId resolve from context', () => {
    window.currentGuild = 'OMEGA';
    expect(roles.getActiveGuild()).toBe('OMEGA');
    localStorage.setItem('gm_user', 'Alpha');
    expect(roles.getCurrentPseudo()).toBe('Alpha');
    expect(roles.currentAccountId()).toBe('Alpha');
    window.GM = { currentAccountId: 'acc-9' };
    expect(roles.currentAccountId()).toBe('acc-9');
  });
});

describe('gating helpers', () => {
  it('detectClientEnvironment parses OS/browser', () => {
    const chrome = roles.detectClientEnvironment('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    expect(chrome.os).toBe('macOS');
    expect(chrome.browser).toBe('Chrome 120');
    expect(chrome.appVersion).toBeTruthy();

    const ios = roles.detectClientEnvironment('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1');
    expect(ios.os).toBe('iOS');
    expect(ios.browser).toBe('Safari 26');
  });
});
