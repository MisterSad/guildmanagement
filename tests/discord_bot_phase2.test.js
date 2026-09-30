// Discord bot integration, Phase 2: /power, /glory, /timezone, /challenges,
// /absence (set/list/cancel). All five reuse the exact same validated,
// audited business logic member-portal already used -- extracted into
// _shared/player-actions.ts (not reimplemented) so neither caller can drift
// from the other. These tests exercise the real exported functions against
// a minimal fake Supabase client, not just regex assertions on source text.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  MAX_ALLOWED_POWER,
  MAX_ALLOWED_EVENT_SCORE,
  updatePlayerPower,
  updatePlayerGlory,
  updatePlayerTimezone,
  getPlayerChallenges,
  listPlayerAbsences,
  setPlayerAbsence,
  deletePlayerAbsence,
  getWeekStartIso,
} from '../supabase/functions/_shared/player-actions.ts';

const MEMBER_ROW = {
  pseudo: 'TestPlayer',
  guild: 'ALPHA',
  overall_power: 1_000_000,
  power_updated_at: null,
  metrics_updated_at: null,
  tech_power: 0,
  champion_power: 0,
  crew_power: 0,
  flagship_power: 0,
  fleet_rating: 0,
  glory_score: 500,
  role: 'R4',
  timezone_offset: 0,
};

// Minimal fake supabase-js client. Every query builder method just records
// which table + starting operation (select/insert/update/delete) it is and
// returns itself; awaiting the builder (or an explicit .limit()/.maybeSingle()
// which also just return the same thenable) resolves it against a canned
// response keyed by "table:op" from `tableResponses`. Real code never calls
// .then() directly -- it always `await`s the chain, so this only needs to
// implement the thenable contract, not the full query-builder surface.
function makeFakeAdmin({ tableResponses = {}, rpcResponses = {} } = {}) {
  const callCounts = {};

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
      insert() { if (!state.op) state.op = 'insert'; return chain; },
      update() { if (!state.op) state.op = 'update'; return chain; },
      delete() { if (!state.op) state.op = 'delete'; return chain; },
      eq() { return chain; },
      neq() { return chain; },
      gt() { return chain; },
      or() { return chain; },
      order() { return chain; },
      limit() { return chain; },
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
    from(table) { return builder(table); },
    async rpc(name, params) {
      const entry = rpcResponses[name];
      if (typeof entry === 'function') return entry(params);
      if (entry === undefined) return { data: null, error: null };
      return entry;
    },
  };
}

describe('updatePlayerPower', () => {
  it('rejects missing/invalid power without touching the database', async () => {
    const admin = makeFakeAdmin();
    expect(await updatePlayerPower(admin, 'uid1', 'ALPHA', undefined)).toEqual({ ok: false, error: 'invalid_power' });
    expect(await updatePlayerPower(admin, 'uid1', 'ALPHA', -5)).toEqual({ ok: false, error: 'invalid_power' });
    expect(await updatePlayerPower(admin, 'uid1', 'ALPHA', true)).toEqual({ ok: false, error: 'invalid_power' });
  });

  it('clamps to MAX_ALLOWED_POWER and reports player_not_found when the roster lookup misses', async () => {
    const admin = makeFakeAdmin({ tableResponses: { 'guild_members:select': { data: [], error: null } } });
    const res = await updatePlayerPower(admin, 'uid1', 'ALPHA', MAX_ALLOWED_POWER * 10);
    expect(res).toEqual({ ok: false, error: 'player_not_found' });
  });

  it('succeeds via the RPC path and clamps the value', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_members:select': { data: [MEMBER_ROW], error: null } },
      rpcResponses: { gm_upsert_player_metrics: { data: { ok: true }, error: null } },
    });
    const res = await updatePlayerPower(admin, 'uid1', 'ALPHA', MAX_ALLOWED_POWER * 10);
    expect(res).toEqual({ ok: true, power: MAX_ALLOWED_POWER });
  });

  it('falls back to a direct guild_members update when the RPC errors', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': { data: [MEMBER_ROW], error: null },
        'guild_members:update': { error: null },
      },
      rpcResponses: { gm_upsert_player_metrics: { data: null, error: { message: 'rpc down' } } },
    });
    const res = await updatePlayerPower(admin, 'uid1', 'ALPHA', 42);
    expect(res).toEqual({ ok: true, power: 42 });
  });
});

describe('updatePlayerGlory', () => {
  it('rejects an invalid glory value without touching the database', async () => {
    const admin = makeFakeAdmin();
    expect(await updatePlayerGlory(admin, 'uid1', 'ALPHA', null)).toEqual({ ok: false, error: 'invalid_glory' });
    expect(await updatePlayerGlory(admin, 'uid1', 'ALPHA', -1)).toEqual({ ok: false, error: 'invalid_glory' });
  });

  it('clamps to MAX_ALLOWED_EVENT_SCORE and returns the resolved week on success', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_members:select': { data: [MEMBER_ROW], error: null } },
      rpcResponses: { gm_upsert_player_glory: { data: { ok: true }, error: null } },
    });
    const res = await updatePlayerGlory(admin, 'uid1', 'ALPHA', MAX_ALLOWED_EVENT_SCORE * 10);
    expect(res.ok).toBe(true);
    expect(res.glory).toBe(MAX_ALLOWED_EVENT_SCORE);
    expect(res.week).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('surfaces an RPC-reported save failure', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_members:select': { data: [MEMBER_ROW], error: null } },
      rpcResponses: { gm_upsert_player_glory: { data: { ok: false, error: 'week_locked' }, error: null } },
    });
    const res = await updatePlayerGlory(admin, 'uid1', 'ALPHA', 1000);
    expect(res).toEqual({ ok: false, error: 'week_locked' });
  });
});

describe('updatePlayerTimezone', () => {
  it('rejects offsets outside -12..14', async () => {
    const admin = makeFakeAdmin();
    expect(await updatePlayerTimezone(admin, 'uid1', 'ALPHA', -13)).toEqual({ ok: false, error: 'invalid_offset' });
    expect(await updatePlayerTimezone(admin, 'uid1', 'ALPHA', 15)).toEqual({ ok: false, error: 'invalid_offset' });
    expect(await updatePlayerTimezone(admin, 'uid1', 'ALPHA', NaN)).toEqual({ ok: false, error: 'invalid_offset' });
    expect(await updatePlayerTimezone(admin, 'uid1', 'ALPHA', 9.4)).toEqual({ ok: false, error: 'invalid_offset' });
  });

  it('accepts half- and quarter-hour offsets (TICKET-0010: Adelaide +9.5, Kathmandu +5.75)', async () => {
    for (const offset of [9.5, 10.5, 5.5, 5.75, -3.5]) {
      const admin = makeFakeAdmin({
        tableResponses: { 'guild_members:select': { data: [MEMBER_ROW], error: null } },
        rpcResponses: { gm_update_player_timezone: { data: { ok: true }, error: null } },
      });
      expect(await updatePlayerTimezone(admin, 'uid1', 'ALPHA', offset)).toEqual({ ok: true });
    }
  });

  it('accepts a valid offset', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_members:select': { data: [MEMBER_ROW], error: null } },
      rpcResponses: { gm_update_player_timezone: { data: { ok: true }, error: null } },
    });
    const res = await updatePlayerTimezone(admin, 'uid1', 'ALPHA', -5);
    expect(res).toEqual({ ok: true });
  });
});

describe('setPlayerAbsence / listPlayerAbsences / deletePlayerAbsence', () => {
  it('rejects a missing date range or an invalid kind before touching the database', async () => {
    const admin = makeFakeAdmin();
    expect(await setPlayerAbsence(admin, 'uid1', 'ALPHA', { startDate: '', endDate: '2026-09-10', kind: 'full' }))
      .toEqual({ ok: false, error: 'missing_dates' });
    expect(await setPlayerAbsence(admin, 'uid1', 'ALPHA', { startDate: '2026-09-05', endDate: '2026-09-10', kind: 'bogus' }))
      .toEqual({ ok: false, error: 'invalid_kind' });
  });

  it('declares a valid absence', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_members:select': { data: [MEMBER_ROW], error: null } },
      rpcResponses: { gm_upsert_player_absence: { data: { ok: true }, error: null } },
    });
    const res = await setPlayerAbsence(admin, 'uid1', 'ALPHA', { startDate: '2026-09-05', endDate: '2026-09-10', kind: 'full', note: null });
    expect(res).toEqual({ ok: true });
  });

  it('lists absences from the RPC', async () => {
    const absences = [{ id: 'abc-123', start_date: '2026-09-05', end_date: '2026-09-10', kind: 'full', note: null }];
    const admin = makeFakeAdmin({ rpcResponses: { gm_get_player_absences: { data: absences, error: null } } });
    const res = await listPlayerAbsences(admin, 'uid1');
    expect(res).toEqual({ ok: true, absences });
  });

  it('rejects a cancel with no id before touching the database', async () => {
    const admin = makeFakeAdmin();
    expect(await deletePlayerAbsence(admin, 'uid1', 'ALPHA', '')).toEqual({ ok: false, error: 'missing_id' });
  });

  it('cancels an existing absence', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_members:select': { data: [MEMBER_ROW], error: null } },
      rpcResponses: { gm_delete_player_absence: { data: { ok: true }, error: null } },
    });
    const res = await deletePlayerAbsence(admin, 'uid1', 'ALPHA', 'abc-123');
    expect(res).toEqual({ ok: true });
  });
});

describe('getPlayerChallenges', () => {
  it('reports player_not_found when the roster lookup misses', async () => {
    const admin = makeFakeAdmin({ tableResponses: { 'guild_members:select': { data: [], error: null } } });
    const res = await getPlayerChallenges(admin, 'uid1', 'ALPHA');
    expect(res).toEqual({ ok: false, error: 'player_not_found' });
  });

  it('computes challenge progress from attendance and glory rows', async () => {
    const currentWeek = getWeekStartIso(new Date());
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': { data: [MEMBER_ROW], error: null },
        'event_participants:select': [
          { data: [{ event_name: 'SvS', session_id: null, week_start: currentWeek }], error: null }, // participation rows
          { data: [{ score: 100 }], error: null }, // glory-this-week rows
        ],
      },
    });
    const res = await getPlayerChallenges(admin, 'uid1', 'ALPHA');
    expect(res.ok).toBe(true);
    expect(res.challenges.find((c) => c.id === 'events1').done).toBe(true);
    expect(res.challenges.find((c) => c.id === 'glory').done).toBe(true);
    expect(res.completed).toBeGreaterThanOrEqual(2);
  });
});

describe('Regression: member-portal reuses _shared/player-actions.ts instead of redefining the logic', () => {
  const memberPortalSrc = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/member-portal/index.ts'),
    'utf-8'
  );

  it('imports every relocated helper instead of defining it locally', () => {
    for (const name of [
      'logPlayerAction', 'getWeekStartIso', 'eventScoringKey',
      'updatePlayerPower', 'updatePlayerGlory', 'updatePlayerTimezone',
      'getPlayerChallenges', 'listPlayerAbsences', 'setPlayerAbsence', 'deletePlayerAbsence',
    ]) {
      expect(memberPortalSrc).toContain(`  ${name},`);
    }
    expect(memberPortalSrc).toContain('} from "../_shared/player-actions.ts"');
    expect(memberPortalSrc).not.toMatch(/^async function logPlayerAction\(/m);
    expect(memberPortalSrc).not.toMatch(/^function getWeekStartIso\(/m);
    expect(memberPortalSrc).not.toMatch(/^function eventScoringKey\(/m);
    expect(memberPortalSrc).not.toMatch(/^interface AuditLogEntry\b/m);
  });

  it('update-power/update-glory/update-timezone/get-weekly-challenges/absence actions delegate to the shared functions', () => {
    expect(memberPortalSrc).toContain('await updatePlayerPower(admin, uid, identity.guild, payload?.power)');
    expect(memberPortalSrc).toContain('await updatePlayerGlory(admin, uid, identity.guild, payload?.glory)');
    expect(memberPortalSrc).toContain('await updatePlayerTimezone(admin, uid, identity.guild, offset');
    expect(memberPortalSrc).toContain('await getPlayerChallenges(admin, uid, identity.guild)');
    expect(memberPortalSrc).toContain('await listPlayerAbsences(admin, uid)');
    expect(memberPortalSrc).toContain('await setPlayerAbsence(admin, uid, identity.guild,');
    expect(memberPortalSrc).toContain('await deletePlayerAbsence(admin, uid, identity.guild, absenceId)');
  });
});

describe('Regression: discord-bot-interactions exposes the Phase 2 commands via the shared actions', () => {
  const botSrc = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/discord-bot-interactions/index.ts'),
    'utf-8'
  );

  it('imports the shared write/read functions rather than reimplementing them', () => {
    for (const name of [
      'updatePlayerPower', 'updatePlayerGlory', 'updatePlayerTimezone',
      'getPlayerChallenges', 'listPlayerAbsences', 'deletePlayerAbsence',
    ]) {
      expect(botSrc).toContain(`  ${name},`);
    }
    // setPlayerAbsence is NOT imported any more: /absence set was retired on
    // 2026-09-28 because /absent does the same write and also alerts the officer
    // channel, which this path never did. member-portal still uses it.
    expect(botSrc).not.toContain('  setPlayerAbsence,');
  });

  it('routes every live command name and resolves the linked account first', () => {
    // /power and /glory were retired the same day: /update-stats does both
    // writes, and now does them through these audited helpers rather than
    // calling the RPCs directly as the worker's own version did.
    for (const name of ['update-stats', 'timezone', 'challenges', 'absence']) {
      expect(botSrc).toContain(`commandName === "${name}"`);
    }
    for (const retired of ['power', 'glory']) {
      expect(botSrc, `/${retired} is retired`).not.toContain(`commandName === "${retired}"`);
    }
    // Every command must gate on resolveLinkedAccount before touching player data,
    // same as /myinfo -- no command should invent its own lookup path.
    const resolverCalls = (botSrc.match(/await resolveLinkedAccount\(admin, discordUserId\)/g) || []).length;
    expect(resolverCalls).toBe(5); // myinfo + update-stats + timezone + challenges + absence
  });

  it('routes all three /absence subcommands', () => {
    expect(botSrc).toContain('subName === "set"');
    expect(botSrc).toContain('subName === "list"');
    expect(botSrc).toContain('subName === "cancel"');
  });
});

// The command definitions used to live in scripts/register-discord-commands.mjs,
// a third registry run by hand that nothing kept in step with the two handlers.
// Deleted 2026-09-28: the worker registers every command on boot (globally and
// per guild), so its definitions are the single source of truth.
describe('Regression: the worker owns the full Phase 2 command set', () => {
  const scriptSrc = fs.readFileSync(
    path.resolve(__dirname, '../discord-verification-worker/index.js'),
    'utf-8'
  );

  it('declares all 7 commands', () => {
    for (const name of ['link', 'myinfo', 'power', 'glory', 'timezone', 'challenges', 'absence']) {
      expect(scriptSrc).toContain(`name: "${name}"`);
    }
  });

  it('declares /timezone bounded natively by Discord (-12..14), matching updatePlayerTimezone', () => {
    const idx = scriptSrc.indexOf('name: "timezone"');
    const block = scriptSrc.slice(idx, idx + 400);
    expect(block).toContain('min_value: -12');
    expect(block).toContain('max_value: 14');
    // NUMBER (10), not INTEGER (4): half-hour zones such as Adelaide are +9.5.
    expect(block).toContain('type: 10');
  });

  it('declares /absence with list/cancel as SUB_COMMAND (type 1) options', () => {
    const idx = scriptSrc.indexOf('name: "absence"');
    const block = scriptSrc.slice(idx, scriptSrc.indexOf('\n};', idx));
    // `set` retired: /absent declares an absence AND alerts the officers.
    expect(block).not.toContain('name: "set"');
    expect(block).toContain('name: "list"');
    expect(block).toContain('name: "cancel"');
    expect(block).toContain('name: "id"');
  });

  it('retires the two commands /update-stats already covered', () => {
    expect(scriptSrc).toContain('const RETIRED_COMMANDS = new Set(["power", "glory"])');
    // Dropping a name from `desired` is not enough: the merge folds unknown
    // existing commands back in, so a retired one must be excluded explicitly
    // or Discord keeps serving it.
    expect(scriptSrc).toContain('if (desired.has(cmd.name) || RETIRED_COMMANDS.has(cmd.name)) continue;');
  });
});
