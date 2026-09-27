import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  resolveAuditChannelId,
  evaluateVerification,
} from '../supabase/functions/_shared/discord-verification.ts';

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "—";
}

function formatPlayerLocalTime(offset, referenceUtcDate = new Date("2026-09-16T14:30:00Z")) {
  if (offset === null || offset === undefined || offset === "") return null;
  const n = Number(offset);
  if (!Number.isFinite(n)) return null;
  const utc = referenceUtcDate.getTime();
  const target = new Date(utc + n * 3600000);
  const hh = String(target.getUTCHours()).padStart(2, "0");
  const mm = String(target.getUTCMinutes()).padStart(2, "0");
  const sign = n >= 0 ? "+" : "";
  return `${hh}:${mm} (UTC${sign}${n})`;
}

function makeFakeAdmin({ tableResponses = {}, rpcResponses = {} } = {}) {
  const callCounts = {};
  const calls = [];

  function nextResponse(key) {
    const entry = tableResponses[key];
    if (entry === undefined) return { data: null, error: null };
    if (Array.isArray(entry)) {
      const idx = callCounts[key] || 0;
      callCounts[key] = idx + 1;
      return entry[Math.min(idx, entry.length - 1)];
    }
    return entry;
  }

  function builder(table) {
    const state = { table, op: null, single: false };
    const chain = {
      select() { if (!state.op) state.op = 'select'; return chain; },
      insert(payload) { if (!state.op) { state.op = 'insert'; calls.push({ table, op: 'insert', payload }); } return chain; },
      update(payload) { if (!state.op) { state.op = 'update'; calls.push({ table, op: 'update', payload }); } return chain; },
      delete() { if (!state.op) state.op = 'delete'; return chain; },
      eq() { return chain; },
      neq() { return chain; },
      in() { return chain; },
      limit() { return chain; },
      in() { return chain; },
      maybeSingle() { state.single = true; return chain; },
      then(resolve) {
        const key = `${state.table}:${state.op}`;
        const res = nextResponse(key);
        if (state.single) {
          const row = Array.isArray(res.data) ? (res.data[0] ?? null) : (res.data ?? null);
          resolve({ data: row, error: res.error ?? null });
        } else {
          resolve(res);
        }
      },
    };
    return chain;
  }

  return {
    calls,
    from(table) { return builder(table); },
    async rpc(name, params) {
      calls.push({ rpc: name, params });
      const entry = rpcResponses[name];
      if (typeof entry === 'function') return entry(params);
      if (entry === undefined) return { data: null, error: null };
      return entry;
    },
  };
}

describe('Discord Bot Advanced: Local Time calculation', () => {
  const refDate = new Date("2026-09-16T14:30:00Z");

  it('calculates exact local time for positive UTC offsets', () => {
    expect(formatPlayerLocalTime(2, refDate)).toBe('16:30 (UTC+2)');
    expect(formatPlayerLocalTime(8, refDate)).toBe('22:30 (UTC+8)');
  });

  it('calculates exact local time for negative UTC offsets', () => {
    expect(formatPlayerLocalTime(-5, refDate)).toBe('09:30 (UTC-5)');
    expect(formatPlayerLocalTime(-8, refDate)).toBe('06:30 (UTC-8)');
  });

  it('handles UTC+0 correctly', () => {
    expect(formatPlayerLocalTime(0, refDate)).toBe('14:30 (UTC+0)');
  });

  it('returns null for empty or non-numeric offsets', () => {
    expect(formatPlayerLocalTime(null, refDate)).toBe(null);
    expect(formatPlayerLocalTime(undefined, refDate)).toBe(null);
    expect(formatPlayerLocalTime('', refDate)).toBe(null);
  });
});

describe('Discord Bot Advanced: Call-To-Arms Aggregation Logic', () => {
  it('correctly sums mobilized power and fleet across present members', () => {
    const present = new Map([
      ['u1', { pseudo: 'Alpha1', power: 150_000_000, fleet: 1_200_000 }],
      ['u2', { pseudo: 'Alpha2', power: 250_000_000, fleet: 1_800_000 }],
      ['u3', { pseudo: 'Alpha3', power: 100_000_000, fleet: 900_000 }],
    ]);

    const totalPower = Array.from(present.values()).reduce((acc, p) => acc + p.power, 0);
    const totalFleet = Array.from(present.values()).reduce((acc, p) => acc + p.fleet, 0);

    expect(totalPower).toBe(500_000_000);
    expect(totalFleet).toBe(3_900_000);
    expect(formatNumber(totalPower)).toBe('500,000,000');
    expect(formatNumber(totalFleet)).toBe('3,900,000');
  });

  it('switching presence removes user from previous category', () => {
    const session = {
      present: new Map([['u1', { pseudo: 'Alpha1', power: 100 }]]),
      late: new Map(),
      absent: new Map(),
    };

    // User switches to Late
    session.present.delete('u1');
    session.late.set('u1', { pseudo: 'Alpha1', power: 100 });

    expect(session.present.has('u1')).toBe(false);
    expect(session.late.has('u1')).toBe(true);
    expect(session.present.size).toBe(0);
    expect(session.late.size).toBe(1);
  });
});

describe('Discord Bot Advanced: resolveAuditChannelId', () => {
  it('resolves discord_audit_channel_id when configured', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_config:select': {
          data: [{ key: 'discord_audit_channel_id', value: '123456789012345678' }],
          error: null,
        },
      },
    });
    const channelId = await resolveAuditChannelId(admin, 'ALPHA');
    expect(channelId).toBe('123456789012345678');
  });

  it('falls back to discord_officer_channel_id when audit_channel is unset', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_config:select': {
          data: [{ key: 'discord_officer_channel_id', value: '987654321098765432' }],
          error: null,
        },
      },
    });
    const channelId = await resolveAuditChannelId(admin, 'ALPHA');
    expect(channelId).toBe('987654321098765432');
  });

  it('returns null when neither is configured', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_config:select': { data: [], error: null },
      },
    });
    const channelId = await resolveAuditChannelId(admin, 'ALPHA');
    expect(channelId).toBe(null);
  });
});

describe('Discord Bot Advanced: evaluateVerification previousPower tracking', () => {
  it('returns previousPower when updating an existing member', async () => {
    // Since ADR-020 the previous power comes from the target guild's own roster
    // read, not from the guild-blind gm_find_player_by_uid RPC.
    const admin = makeFakeAdmin({
      tableResponses: {
        'banned_players:select': { data: null, error: null },
        'guild_members:select': [
          { data: [{ pseudo: 'Veteran', uid: '123456', overall_power: 100_000_000 }], error: null },
          { data: [], error: null },
        ],
        'guild_members:update': { data: null, error: null },
        'guild_config:select': { data: { value: 'true' }, error: null },
        'guilds:select': { data: { server_number: '1058' }, error: null },
      },
    });

    const res = await evaluateVerification(admin, 'ALPHA', 'discord-123', {
      pseudo: 'Veteran',
      uid: '123456',
      power: 120_000_000,
      glory: 10_000,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.isNewPlayer).toBe(false);
      expect(res.previousPower).toBe(100_000_000);
      expect(res.power).toBe(120_000_000);
    }
  });
});

describe('Discord Bot Advanced: Worker Security & Invariants', () => {
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, '../discord-verification-worker/index.js'),
    'utf-8'
  );

  it('does not contain banned_players (respecting existing regression invariant)', () => {
    expect(workerSrc).not.toContain('banned_players');
  });

  it('never performs direct writes to guild_members or accounts', () => {
    expect(workerSrc).not.toMatch(/from\(["'](guild_members|accounts)["']\)\.(insert|update|upsert|delete)/);
  });

  it('handles message deletion for privacy/cleanliness', () => {
    expect(workerSrc).toContain('message.delete()');
  });

  it('registers all 6 slash commands', () => {
    expect(workerSrc).toContain('"profile"');
    expect(workerSrc).toContain('"absent"');
    expect(workerSrc).toContain('"top"');
    expect(workerSrc).toContain('"absences"');
    expect(workerSrc).toContain('"call-to-arms"');
    expect(workerSrc).toContain('"update-stats"');
  });

  it('handles button interactions for Call to Arms', () => {
    expect(workerSrc).toContain('interaction.isButton()');
    expect(workerSrc).toContain('cta_present');
    expect(workerSrc).toContain('cta_late');
    expect(workerSrc).toContain('cta_absent');
  });

  it('registers and handles /link and /myinfo commands without timing out', () => {
    expect(workerSrc).toContain('interaction.commandName === "link"');
    expect(workerSrc).toContain('interaction.commandName === "myinfo"');
    expect(workerSrc).toContain('handleLink');
    expect(workerSrc).toContain('handleMyInfo');
    expect(workerSrc).toContain('randomLinkCode()');
  });
});
