// Discord bot: profile-verification feature (screenshot -> role, nickname,
// roster update). Exercises the real decision logic in
// _shared/discord-verification.ts against a fake Supabase client (same
// pattern as tests/discord_bot_phase2.test.js), plus static regressions
// confirming the Edge Function stays a thin caller and the always-on worker
// never writes to roster/account tables directly -- the worker only reads
// `guild_members`/`accounts`/`discord_account_links` for its /profile and
// /absent slash commands and routes every write through the validated
// service-role RPC (gm_upsert_player_absence). No path ever writes to
// `accounts` (screenshot-only trust model -- roster presence, never a login
// credential).
//
// ADR-020 added the two guards this file now pins hardest:
//   1. a tag resolves ONLY among guilds sharing the verification channel's own
//      guilds.server_number, so a same-tag guild on another game server can
//      neither be granted from here nor block anyone here;
//   2. when a guild opts in, its roster is the authority and NOTHING is
//      inserted -- a player who is not in the member list is refused with
//      `not_on_roster`, which the caller turns into the "pending" state.

import { describe, it, expect } from 'vitest';
import { squash } from './helpers/source-text.js';
import fs from 'fs';
import path from 'path';
import {
  normalizeTag,
  bracketed,
  resolveExpectedTag,
  resolveHomeServerNumber,
  resolveTagToGuildOnServer,
  visitorTagDisplay,
  VISITOR_TAG_MAX_LENGTH,
  isPlaceholderUid,
  findRosterMember,
  requiresRosterMembership,
  findOtherGuildMemberships,
  evaluateVerification,
  ROSTER_SCAN_CAP,
} from '../supabase/functions/_shared/discord-verification.ts';
import { getUidStatus } from '../src/modules/ocr/ocr.service.ts';

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
    const state = { table, op: null, single: false, filters: [] };
    const chain = {
      select() {
        if (!state.op) state.op = 'select';
        return chain;
      },
      insert(payload) {
        if (!state.op) {
          state.op = 'insert';
          calls.push({ table, op: 'insert', payload });
        }
        return chain;
      },
      update(payload) {
        if (!state.op) {
          state.op = 'update';
          calls.push({ table, op: 'update', payload, filters: state.filters });
        }
        return chain;
      },
      delete() {
        if (!state.op) state.op = 'delete';
        return chain;
      },
      eq(col, val) {
        state.filters.push(['eq', col, val]);
        return chain;
      },
      neq(col, val) {
        state.filters.push(['neq', col, val]);
        return chain;
      },
      in(col, val) {
        state.filters.push(['in', col, val]);
        return chain;
      },
      limit(n) {
        state.filters.push(['limit', n]);
        return chain;
      },
      maybeSingle() {
        state.single = true;
        return chain;
      },
      then(resolve) {
        const key = `${state.table}:${state.op}`;
        const res = nextResponse(key);
        if (state.op === 'select') calls.push({ table: state.table, op: 'select', filters: state.filters });
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
    from(table) {
      return builder(table);
    },
    async rpc(name, params) {
      calls.push({ rpc: name, params });
      const entry = rpcResponses[name];
      if (typeof entry === 'function') return entry(params);
      if (entry === undefined) return { data: null, error: null };
      return entry;
    },
  };
}

/** A roster read followed by the "which other guilds hold this UID" read. */
function rosterThenOthers(rosterRows, otherRows = []) {
  return {
    'guild_members:select': [
      { data: rosterRows, error: null },
      { data: otherRows, error: null },
    ],
  };
}

describe('normalizeTag / bracketed', () => {
  it('strips brackets, trims, and uppercases', () => {
    expect(normalizeTag('[PR1M]')).toBe('PR1M');
    expect(normalizeTag('pr1m')).toBe('PR1M');
    expect(normalizeTag('  [Pr1M]  ')).toBe('PR1M');
    expect(normalizeTag(null)).toBe('');
    expect(normalizeTag(undefined)).toBe('');
  });

  it('brackets a bare tag and leaves an already-bracketed one alone', () => {
    expect(bracketed('PR1M')).toBe('[PR1M]');
    expect(bracketed('[PR1M]')).toBe('[PR1M]');
    expect(bracketed('  DEMO ')).toBe('[DEMO]');
    expect(bracketed('')).toBe('');
    expect(bracketed(null)).toBe('');
  });
});

describe('visitorTagDisplay', () => {
  it('brackets the tag read off the screenshot, keeping its casing', () => {
    expect(visitorTagDisplay('SB')).toBe('[SB]');
    expect(visitorTagDisplay('[WaR]')).toBe('[WaR]');
    expect(visitorTagDisplay('  Sol  ')).toBe('[Sol]');
  });

  it('returns "" for no tag, so the caller falls back to [VISITOR]', () => {
    expect(visitorTagDisplay(null)).toBe('');
    expect(visitorTagDisplay(undefined)).toBe('');
    expect(visitorTagDisplay('   ')).toBe('');
    expect(visitorTagDisplay('[]')).toBe('');
  });

  it('treats OCR output as untrusted: no mention, markdown or control characters', () => {
    expect(visitorTagDisplay('@everyone')).toBe('[everyone]');
    expect(visitorTagDisplay('<@123>')).toBe('[123]');
    expect(visitorTagDisplay('**B**_\u0007x`')).toBe('[Bx]');
    expect(visitorTagDisplay('A\n  B')).toBe('[A B]');
  });

  it('caps the tag at the longest a guild can have', () => {
    expect(visitorTagDisplay('ABCDEFGHIJKLMNOP')).toBe(`[${'ABCDEFGHIJKLMNOP'.slice(0, VISITOR_TAG_MAX_LENGTH)}]`);
  });
});

describe('resolveExpectedTag', () => {
  it('uses the guild_config override when set', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_config:select': { data: { value: '[CUSTOM]' }, error: null } },
    });
    expect(await resolveExpectedTag(admin, 'ALPHA')).toBe('[CUSTOM]');
  });

  it('brackets a stored tag that was saved without brackets', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_config:select': { data: { value: 'DEMO' }, error: null } },
    });
    expect(await resolveExpectedTag(admin, 'DEMO')).toBe('[DEMO]');
  });

  it('falls back to [GUILD] -- from data, never from a table of tenant names', async () => {
    const admin = makeFakeAdmin({ tableResponses: { 'guild_config:select': { data: null, error: null } } });
    expect(await resolveExpectedTag(admin, 'NEWGUILD')).toBe('[NEWGUILD]');
    expect(await resolveExpectedTag(admin, 'ALPHA')).toBe('[ALPHA]');
  });
});

describe('resolveHomeServerNumber', () => {
  it('returns the trimmed server number, or null when the guild has none', async () => {
    const withNumber = makeFakeAdmin({
      tableResponses: { 'guilds:select': { data: { server_number: ' 1058 ' }, error: null } },
    });
    expect(await resolveHomeServerNumber(withNumber, 'ALPHA')).toBe('1058');

    const without = makeFakeAdmin({
      tableResponses: { 'guilds:select': { data: { server_number: null }, error: null } },
    });
    expect(await resolveHomeServerNumber(without, 'GRIM')).toBeNull();
  });
});

describe('resolveTagToGuildOnServer', () => {
  it('returns none immediately for an empty tag, without any DB calls', async () => {
    const admin = makeFakeAdmin();
    expect(await resolveTagToGuildOnServer(admin, '', '1058', 'ALPHA')).toEqual({ kind: 'none' });
    expect(admin.calls.length).toBe(0);
  });

  it('matches a sibling guild on the same game server via its guild_config tag', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guilds:select': { data: [{ id: 'ALPHA' }, { id: 'OMEGA' }, { id: 'IMK' }], error: null },
        'guild_config:select': {
          data: [
            { guild: 'ALPHA', value: '[PR1M]' },
            { guild: 'OMEGA', value: '[OMG]' },
            { guild: 'IMK', value: '[IMK]' },
          ],
          error: null,
        },
      },
    });
    expect(await resolveTagToGuildOnServer(admin, 'OMG', '1058', 'ALPHA')).toEqual({
      kind: 'match',
      fgfGuild: 'OMEGA',
      tagDisplay: '[OMG]',
      serverNumber: '1058',
    });
  });

  it('matches a guild with no stored tag through its own id', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guilds:select': { data: [{ id: 'CLS' }], error: null },
        'guild_config:select': { data: [], error: null },
      },
    });
    expect(await resolveTagToGuildOnServer(admin, 'CLS', '1083', 'CLS')).toEqual({
      kind: 'match',
      fgfGuild: 'CLS',
      tagDisplay: '[CLS]',
      serverNumber: '1083',
    });
  });

  it('scopes the candidate list to the home server number', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guilds:select': { data: [{ id: 'ALPHA' }], error: null },
        'guild_config:select': { data: [{ guild: 'ALPHA', value: '[PR1M]' }], error: null },
      },
    });
    await resolveTagToGuildOnServer(admin, 'PR1M', '1058', 'ALPHA');
    const guildsRead = admin.calls.find((c) => c.table === 'guilds' && c.op === 'select');
    expect(guildsRead.filters).toEqual([['eq', 'server_number', '1058']]);
    const configRead = admin.calls.find((c) => c.table === 'guild_config' && c.op === 'select');
    expect(configRead.filters).toEqual([
      ['eq', 'key', 'guild_tag'],
      ['in', 'guild', ['ALPHA']],
    ]);
  });

  it('REGRESSION: the same tag on another game server resolves to nothing', async () => {
    // A guild elsewhere carrying [PR1M] used to win this lookup, because the
    // old resolver scanned every tenant's guild_config globally.
    const admin = makeFakeAdmin({
      tableResponses: {
        'guilds:select': { data: [{ id: 'DEMO' }], error: null },
        'guild_config:select': { data: [{ guild: 'DEMO', value: 'DEMO' }], error: null },
      },
    });
    expect(await resolveTagToGuildOnServer(admin, 'PR1M', '0000', 'DEMO')).toEqual({ kind: 'none' });
  });

  it('refuses to guess when two guilds on one server share a tag', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guilds:select': { data: [{ id: 'ONE' }, { id: 'TWO' }], error: null },
        'guild_config:select': {
          data: [
            { guild: 'ONE', value: '[DUP]' },
            { guild: 'TWO', value: 'DUP' },
          ],
          error: null,
        },
      },
    });
    expect(await resolveTagToGuildOnServer(admin, 'DUP', '1200', 'ONE')).toEqual({
      kind: 'ambiguous',
      serverNumber: '1200',
      candidates: ['ONE', 'TWO'],
    });
  });

  it('fails visibly when the channel guild has no server number, instead of widening the scan', async () => {
    const admin = makeFakeAdmin();
    expect(await resolveTagToGuildOnServer(admin, 'PR1M', null, 'GRIM')).toEqual({
      kind: 'home_server_unknown',
      homeGuild: 'GRIM',
    });
    expect(admin.calls.length).toBe(0);
  });

  it('returns none when no guild shares the home server number', async () => {
    const admin = makeFakeAdmin({ tableResponses: { 'guilds:select': { data: [], error: null } } });
    expect(await resolveTagToGuildOnServer(admin, 'PR1M', '9999', 'X')).toEqual({ kind: 'none' });
  });
});

describe('isPlaceholderUid', () => {
  // The Edge module cannot import from src/, so the rule lives in two places.
  // This table is the contract between them.
  const cases = [
    ['1917131', false],
    ['  1917131  ', false],
    ['', true],
    [null, true],
    ['-', true],
    ['TEMP-yu1or6r5', true],
    ['temp_abc123', true],
    ['TMP-9x', true],
    ['TEMP', true],
    ['MEGATRON', true],
    ['12345', true],
    ['12345678901', true],
  ];

  it.each(cases)('treats %s as placeholder=%s', (uid, expected) => {
    expect(isPlaceholderUid(uid)).toBe(expected);
  });

  it('agrees with getUidStatus in src/modules/ocr/ocr.service.ts', () => {
    for (const [uid] of cases) {
      expect(isPlaceholderUid(uid)).toBe(!getUidStatus(uid).valid);
    }
  });
});

describe('findRosterMember', () => {
  it('matches on the in-game UID and returns the on-file pseudo', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': {
          data: [{ pseudo: 'OnFileName', uid: '1917131', overall_power: 900000 }],
          error: null,
        },
      },
    });
    expect(await findRosterMember(admin, 'ALPHA', '1917131', 'FreshOCRRead')).toEqual({
      kind: 'uid_match',
      pseudo: 'OnFileName',
      uid: '1917131',
      overallPower: 900000,
    });
  });

  it('never filters with ilike on OCR text -- a pseudo holding % would match half the roster', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_members:select': { data: [], error: null } },
    });
    await findRosterMember(admin, 'ALPHA', '1917131', '100%Real');
    const read = admin.calls.find((c) => c.table === 'guild_members' && c.op === 'select');
    expect(read.filters).toEqual([
      ['eq', 'guild', 'ALPHA'],
      ['limit', ROSTER_SCAN_CAP],
    ]);
  });

  it('claims a roster row whose UID is a TEMP- placeholder, case-insensitively', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': {
          data: [{ pseudo: 'Trader23634', uid: 'TEMP-yu1or6r5', overall_power: 50 }],
          error: null,
        },
      },
    });
    expect(await findRosterMember(admin, 'OMEGA', '1917131', 'trader23634')).toEqual({
      kind: 'pseudo_claim',
      pseudo: 'Trader23634',
      overallPower: 50,
      staleUid: 'TEMP-yu1or6r5',
    });
  });

  it('claims a roster row with no UID at all', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': { data: [{ pseudo: 'NoUid', uid: null, overall_power: 0 }], error: null },
      },
    });
    expect(await findRosterMember(admin, 'ALPHA', '1917131', 'NoUid')).toEqual({
      kind: 'pseudo_claim',
      pseudo: 'NoUid',
      overallPower: 0,
      staleUid: null,
    });
  });

  it('refuses when the pseudo is on file under a different real UID (rename or impostor)', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': { data: [{ pseudo: 'HawkEye', uid: '7654321', overall_power: 10 }], error: null },
      },
    });
    expect(await findRosterMember(admin, 'ALPHA', '1917131', 'HawkEye')).toEqual({
      kind: 'pseudo_conflict',
      pseudo: 'HawkEye',
      onFileUid: '7654321',
    });
  });

  it('refuses when two roster rows differ only in case -- UNIQUE (guild, pseudo) is case-sensitive', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': {
          data: [
            { pseudo: 'HawkEye', uid: null, overall_power: 1 },
            { pseudo: 'hawkeye', uid: null, overall_power: 2 },
          ],
          error: null,
        },
      },
    });
    expect(await findRosterMember(admin, 'ALPHA', '1917131', 'HAWKEYE')).toEqual({
      kind: 'ambiguous_pseudo',
      pseudo: 'HawkEye',
      count: 2,
    });
  });

  it('reports absent when neither the UID nor the pseudo is on the roster', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': { data: [{ pseudo: 'Someone', uid: '111111', overall_power: 1 }], error: null },
      },
    });
    expect(await findRosterMember(admin, 'ALPHA', '1917131', 'Stranger')).toEqual({ kind: 'absent' });
  });

  it('reports a truncated read as an error, never as absent', async () => {
    const rows = Array.from({ length: ROSTER_SCAN_CAP }, (_, i) => ({
      pseudo: `P${i}`,
      uid: `${1000000 + i}`,
      overall_power: 0,
    }));
    const admin = makeFakeAdmin({ tableResponses: { 'guild_members:select': { data: rows, error: null } } });
    expect(await findRosterMember(admin, 'ALPHA', '9999999', 'Stranger')).toEqual({ kind: 'scan_truncated' });
  });

  it('reports a failed read as scan_truncated, never as absent', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_members:select': { data: null, error: { message: 'timeout' } } },
    });
    expect(await findRosterMember(admin, 'ALPHA', '1917131', 'HawkEye')).toEqual({ kind: 'scan_truncated' });
  });
});

describe('requiresRosterMembership', () => {
  it('is opt-in: only the exact string "true" turns it on', async () => {
    const on = makeFakeAdmin({ tableResponses: { 'guild_config:select': { data: { value: 'true' }, error: null } } });
    expect(await requiresRosterMembership(on, 'ALPHA')).toBe(true);

    const off = makeFakeAdmin({ tableResponses: { 'guild_config:select': { data: { value: 'false' }, error: null } } });
    expect(await requiresRosterMembership(off, 'PSA')).toBe(false);

    const absent = makeFakeAdmin({ tableResponses: { 'guild_config:select': { data: null, error: null } } });
    expect(await requiresRosterMembership(absent, 'STW')).toBe(false);

    const junk = makeFakeAdmin({ tableResponses: { 'guild_config:select': { data: { value: '1' }, error: null } } });
    expect(await requiresRosterMembership(junk, 'STW')).toBe(false);
  });
});

describe('findOtherGuildMemberships', () => {
  it('lists the other guilds holding that UID, de-duplicated and sorted', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': { data: [{ guild: 'YARR' }, { guild: 'PAIN' }, { guild: 'PAIN' }], error: null },
      },
    });
    expect(await findOtherGuildMemberships(admin, 'ALPHA', '1905776')).toEqual(['PAIN', 'YARR']);
    const read = admin.calls.find((c) => c.table === 'guild_members' && c.op === 'select');
    expect(read.filters).toEqual([
      ['eq', 'uid', '1905776'],
      ['neq', 'guild', 'ALPHA'],
    ]);
  });

  it('does not query at all for an empty UID', async () => {
    const admin = makeFakeAdmin();
    expect(await findOtherGuildMemberships(admin, 'ALPHA', '')).toEqual([]);
    expect(admin.calls.length).toBe(0);
  });
});

describe('evaluateVerification', () => {
  const baseExtracted = { pseudo: 'HawkEye', uid: '1917131', power: 1_500_000, glory: 200_000 };
  const gateOn = { 'guild_config:select': { data: { value: 'true' }, error: null } };
  const gateOff = { 'guild_config:select': { data: null, error: null } };

  it('rejects a banned player', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'banned_players:select': { data: { uid: '1917131' }, error: null } },
    });
    const res = await evaluateVerification(admin, 'ALPHA', 'discord-1', baseExtracted);
    expect(res).toEqual({ ok: false, error: 'banned' });
  });

  it('with the gate ON, refuses a player who is not on the roster and inserts NOTHING', async () => {
    const admin = makeFakeAdmin({ tableResponses: { ...rosterThenOthers([]), ...gateOn } });
    const res = await evaluateVerification(admin, 'ALPHA', 'discord-1', baseExtracted);
    expect(res).toEqual({ ok: false, error: 'not_on_roster', reason: 'absent', otherGuilds: [] });
    expect(admin.calls.some((c) => c.table === 'guild_members' && c.op === 'insert')).toBe(false);
    expect(admin.calls.some((c) => c.table === 'guild_members' && c.op === 'update')).toBe(false);
  });

  it('records a refusal in the audit trail, attributed to this service', async () => {
    const admin = makeFakeAdmin({ tableResponses: { ...rosterThenOthers([], [{ guild: 'PAIN' }]), ...gateOn } });
    await evaluateVerification(admin, 'ALPHA', 'discord-1', baseExtracted);
    const audit = admin.calls.find((c) => c.rpc === 'gm_log_player_audit');
    expect(audit.params.p_action_type).toBe('discord_verification_refused');
    expect(audit.params.p_service).toBe('discord-profile-verification');
    expect(audit.params.p_level).toBe('WARN');
    expect(audit.params.p_metadata.reason).toBe('absent');
    expect(audit.params.p_metadata.other_guilds).toEqual(['PAIN']);
    expect(audit.params.p_metadata.discord_user_id).toBe('discord-1');
  });

  it('with the gate OFF, still inserts a new player with role R1 (PSA/STW onboarding)', async () => {
    const admin = makeFakeAdmin({ tableResponses: { ...rosterThenOthers([]), ...gateOff } });
    const res = await evaluateVerification(admin, 'PSA', 'discord-1', baseExtracted);
    expect(res).toEqual({
      ok: true,
      finalPseudo: 'HawkEye',
      isNewPlayer: true,
      power: 1_500_000,
      glory: 200_000,
      otherGuilds: [],
    });
    const insertCall = admin.calls.find((c) => c.table === 'guild_members' && c.op === 'insert');
    expect(insertCall.payload).toEqual({
      pseudo: 'HawkEye',
      uid: '1917131',
      guild: 'PSA',
      overall_power: 1_500_000,
      glory_score: 200_000,
      role: 'R1',
    });
  });

  it('REGRESSION: a UID that also exists in another guild is accepted in the target guild', async () => {
    // gm_find_player_by_uid is guild-blind (ORDER BY created_at DESC LIMIT 1),
    // so it refused the legitimate member of whichever guild was older. Four
    // real members are in exactly that position in production.
    const admin = makeFakeAdmin({
      tableResponses: {
        ...rosterThenOthers([{ pseudo: 'MorganKane', uid: '1922059', overall_power: 900_000 }], [{ guild: 'PAIN' }]),
        ...gateOn,
      },
    });
    const res = await evaluateVerification(admin, 'ALPHA', 'discord-1', { ...baseExtracted, uid: '1922059' });
    expect(res.ok).toBe(true);
    expect(res.finalPseudo).toBe('MorganKane');
    expect(res.otherGuilds).toEqual(['PAIN']);
    expect(admin.calls.some((c) => c.rpc === 'gm_find_player_by_uid')).toBe(false);
  });

  it('updates an existing player and keeps the on-file pseudo, not a fresh OCR guess', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        ...rosterThenOthers([{ pseudo: 'OnFileName', uid: '1917131', overall_power: 900_000 }]),
        ...gateOn,
      },
    });
    const res = await evaluateVerification(admin, 'ALPHA', 'discord-1', { ...baseExtracted, pseudo: 'FreshOCRRead' });
    expect(res.ok).toBe(true);
    expect(res.finalPseudo).toBe('OnFileName');
    expect(res.isNewPlayer).toBe(false);
    expect(res.previousPower).toBe(900_000);
    const updateCall = admin.calls.find((c) => c.table === 'guild_members' && c.op === 'update');
    expect(updateCall.payload).toEqual({ overall_power: 1_500_000, glory_score: 200_000 });
    expect(updateCall.filters).toEqual([
      ['eq', 'guild', 'ALPHA'],
      ['eq', 'uid', '1917131'],
    ]);
    expect(admin.calls.some((c) => c.table === 'guild_members' && c.op === 'insert')).toBe(false);
  });

  it('backfills the real UID onto a claimed placeholder row, keyed on the on-file pseudo', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        ...rosterThenOthers([{ pseudo: 'Trader23634', uid: 'TEMP-yu1or6r5', overall_power: 10 }]),
        ...gateOn,
      },
    });
    const res = await evaluateVerification(admin, 'OMEGA', 'discord-1', { ...baseExtracted, pseudo: 'trader23634' });
    expect(res.ok).toBe(true);
    expect(res.uidBackfilled).toBe(true);
    const updateCall = admin.calls.find((c) => c.table === 'guild_members' && c.op === 'update');
    expect(updateCall.payload).toEqual({ overall_power: 1_500_000, glory_score: 200_000, uid: '1917131' });
    expect(updateCall.filters).toEqual([
      ['eq', 'guild', 'OMEGA'],
      ['eq', 'pseudo', 'Trader23634'],
    ]);
    const audit = admin.calls.find((c) => c.rpc === 'gm_log_player_audit');
    expect(audit.params.p_metadata.uid_backfilled).toBe(true);
    expect(audit.params.p_metadata.previous_uid).toBe('TEMP-yu1or6r5');
  });

  it('refuses a pseudo conflict even with the gate OFF, rather than hitting UNIQUE (guild, pseudo)', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        ...rosterThenOthers([{ pseudo: 'HawkEye', uid: '7654321', overall_power: 1 }]),
        ...gateOff,
      },
    });
    const res = await evaluateVerification(admin, 'PSA', 'discord-1', baseExtracted);
    expect(res).toEqual({
      ok: false,
      error: 'not_on_roster',
      reason: 'pseudo_conflict',
      onFileUid: '7654321',
      otherGuilds: [],
    });
    expect(admin.calls.some((c) => c.table === 'guild_members' && c.op === 'insert')).toBe(false);
  });

  it('refuses an ambiguous pseudo even with the gate OFF', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        ...rosterThenOthers([
          { pseudo: 'HawkEye', uid: null, overall_power: 1 },
          { pseudo: 'hawkeye', uid: null, overall_power: 2 },
        ]),
        ...gateOff,
      },
    });
    const res = await evaluateVerification(admin, 'PSA', 'discord-1', baseExtracted);
    expect(res.error).toBe('not_on_roster');
    expect(res.reason).toBe('ambiguous_pseudo');
    expect(admin.calls.some((c) => c.table === 'guild_members' && c.op === 'insert')).toBe(false);
  });

  it('refuses a truncated roster read even with the gate OFF', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_members:select': [
          { data: null, error: { message: 'timeout' } },
          { data: [], error: null },
        ],
        ...gateOff,
      },
    });
    const res = await evaluateVerification(admin, 'PSA', 'discord-1', baseExtracted);
    expect(res.reason).toBe('scan_truncated');
    expect(admin.calls.some((c) => c.table === 'guild_members' && c.op === 'insert')).toBe(false);
  });

  it('surfaces a db_error without throwing when the write fails', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        ...rosterThenOthers([]),
        ...gateOff,
        'guild_members:insert': { error: { message: 'constraint violation' } },
      },
    });
    const res = await evaluateVerification(admin, 'PSA', 'discord-1', baseExtracted);
    expect(res).toEqual({ ok: false, error: 'db_error' });
  });

  it('never writes to accounts -- roster-only, no login credentials created', async () => {
    const admin = makeFakeAdmin({ tableResponses: { ...rosterThenOthers([]), ...gateOff } });
    await evaluateVerification(admin, 'PSA', 'discord-1', baseExtracted);
    expect(admin.calls.some((c) => c.table === 'accounts')).toBe(false);
  });
});

describe('Regression: no table of per-guild default tags anywhere in the backend', () => {
  // The frontend copy of this table was deleted as an ADR-003 violation
  // (finding H2) after two of its seven values turned out to be wrong -- and
  // it promptly reappeared in supabase/functions/, because the test that
  // guards it only walked src/.
  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.(ts|js)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const files = walk(path.resolve(__dirname, '../supabase/functions'));

  it('reads a non-trivial number of Edge Function sources', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it('declares no DEFAULT_GUILD_TAGS map', () => {
    const offenders = files.filter((f) => fs.readFileSync(f, 'utf-8').includes('DEFAULT_GUILD_TAGS'));
    expect(offenders).toEqual([]);
  });

  it('hardcodes no tag for a real tenant', () => {
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      // A tenant id next to its bracketed tag is the shape of the deleted table.
      if (/ALPHA:\s*"\[PR1M\]"|OMEGA:\s*"\[OMG\]"|IMK:\s*"\[IMK\]"/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('Regression: discord-profile-verification role decision', () => {
  const fnSrc = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/discord-profile-verification/index.ts'),
    'utf-8'
  );

  it('only calls evaluateVerification (and only touches guild_members) once a matching guild role was found', () => {
    const roleCheckIdx = fnSrc.indexOf('const matchedGuildRole');
    const evalIdx = fnSrc.indexOf('evaluateVerification(admin, targetGuild, discordUserId, extracted)');
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(roleCheckIdx);
    const visitorBranchIdx = fnSrc.indexOf('if (!matchedGuildRole)');
    expect(visitorBranchIdx).toBeGreaterThan(-1);
    expect(visitorBranchIdx).toBeLessThan(evalIdx);
  });

  it("resolves the tag only within the channel guild's own game server", () => {
    expect(fnSrc).toContain('resolveHomeServerNumber(admin, fgfGuild)');
    expect(fnSrc).toContain('resolveTagToGuildOnServer(admin, extractedTagNormalized, homeServerNumber, fgfGuild)');
    // The globally-scanning resolver must not come back.
    expect(fnSrc).not.toContain('resolveTagToGuild(admin');
  });

  it('carries no game-server literal and no tenant name in the decision path', () => {
    // The OCR prompt legitimately shows "#1058" as an example of what to read,
    // so judge only the code that decides, which starts after the prompt.
    const decisionPath = fnSrc.slice(fnSrc.indexOf('const serverRoles = await fetchServerRoles'));
    expect(decisionPath.length).toBeGreaterThan(1000);
    expect(decisionPath).not.toMatch(/["']1058["']/);
    expect(decisionPath).not.toMatch(/["'](ALPHA|OMEGA|IMK|PR1M|OMG)["']/);
    expect(fnSrc).not.toMatch(/fgfGuild === ["'][A-Z]+["']/);
  });

  it('treats a screenshot from another game server as a visitor, even when the tag matched', () => {
    expect(fnSrc).toContain(
      'const serverMismatch = !!(matched && extractedServerNumber && extractedServerNumber !== matched.serverNumber)'
    );
    const mismatchIdx = fnSrc.indexOf('const serverMismatch');
    const roleIdx = fnSrc.indexOf('const matchedGuildRole');
    expect(mismatchIdx).toBeLessThan(roleIdx);
    expect(fnSrc).toContain('matched && !serverMismatch');
  });

  it('requires a same-named role to exist on the server, else falls back to Visitor', () => {
    expect(fnSrc).toContain('findRoleByNormalizedName(serverRoles, normalizeTag(matched.tagDisplay))');
    expect(fnSrc).toContain('findRoleByNormalizedName(serverRoles, VISITOR_ROLE_NAME)');
    expect(fnSrc).toContain('findRoleByNormalizedName(serverRoles, PENDING_ROLE_NAME)');
  });

  it('names a visitor after the tag on their screenshot, [VISITOR] when it shows none, and keeps the Visitor role', () => {
    const visitorIdx = fnSrc.indexOf('if (!matchedGuildRole)');
    const guildMemberIdx = fnSrc.indexOf('Real guild member candidate');
    const visitorBlock = fnSrc.slice(visitorIdx, guildMemberIdx);
    expect(squash(visitorBlock)).toContain(
      squash(
        'buildNickname( visitorTagDisplay(rawExtracted?.guild_tag) || `[${VISITOR_ROLE_NAME}]`, pseudo, serverNum )'
      )
    );
    expect(squash(visitorBlock)).toContain(
      squash('assignRoleAndNickname(discordServerId, discordUserId, visitorRole.id, visitorNickname, logger')
    );
  });

  it('never grants the guild role on the pending path, and never stamps the refused tag into the nickname', () => {
    const pendingIdx = fnSrc.indexOf('result.error === "not_on_roster"');
    expect(pendingIdx).toBeGreaterThan(-1);
    const pendingBlock = fnSrc.slice(pendingIdx, fnSrc.indexOf('if (!result.ok) {', pendingIdx));
    expect(pendingBlock).toContain('buildNickname("", pseudo,');
    expect(pendingBlock).toContain('pendingRole || visitorRole || null');
    // The guild role is removed here, never assigned.
    expect(pendingBlock).toContain('[matchedGuildRole.id, visitorRole?.id, pendingRole?.id]');
    expect(pendingBlock).not.toContain('assignRoleAndNickname(discordServerId, discordUserId, matchedGuildRole.id');
    // And the refusal is durable for officers, not an auto-deleting reply.
    expect(pendingBlock).toContain('postAuditMessage(');
  });

  it('reports the pending outcome so the worker can tell it apart from a visitor', () => {
    expect(fnSrc).toContain('role: "pending"');
    expect(fnSrc).toContain('error: "not_on_roster"');
  });

  it('suppresses role mentions by never outputting <@& and enforcing allowed_mentions: { parse: [] }', () => {
    expect(fnSrc).not.toContain('<@&');
    expect(fnSrc).toContain('allowed_mentions: { parse: [] }');
  });
});

describe('Regression: discord-profile-verification stays a thin caller', () => {
  const fnSrc = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/discord-profile-verification/index.ts'),
    'utf-8'
  );

  it('delegates every guild_members / ban / roster decision to the shared module', () => {
    expect(fnSrc).toContain('evaluateVerification(admin, targetGuild, discordUserId, extracted)');
    expect(fnSrc).not.toMatch(/from\(["']guild_members["']\)/);
    expect(fnSrc).not.toMatch(/from\(["']banned_players["']\)/);
  });

  it('is authenticated by a shared worker secret, not a Supabase JWT', () => {
    expect(fnSrc).toContain('DISCORD_WORKER_SECRET');
    expect(fnSrc).toContain('safeEqual(authBearer, DISCORD_WORKER_SECRET)');
  });

  it('is registered as a public endpoint in config.toml (verify_jwt = false)', () => {
    const configSrc = fs.readFileSync(path.resolve(__dirname, '../supabase/config.toml'), 'utf-8');
    const idx = configSrc.indexOf('[functions.discord-profile-verification]');
    expect(idx).toBeGreaterThan(-1);
    expect(configSrc.slice(idx, idx + 60)).toContain('verify_jwt = false');
  });

  it('rate-limits by discord_user_id before calling the metered OCR API', () => {
    const rateLimitIdx = fnSrc.indexOf('checkAndRecordDiscordAttempt');
    const ocrIdx = fnSrc.indexOf('callVisionModel(');
    expect(rateLimitIdx).toBeGreaterThan(-1);
    expect(ocrIdx).toBeGreaterThan(rateLimitIdx);
  });
});

describe('Regression: discord-verification-worker keeps business writes out', () => {
  const workerSrc = fs.readFileSync(path.resolve(__dirname, '../discord-verification-worker/index.js'), 'utf-8');

  it('never writes to guild_members, accounts, or banned_players directly', () => {
    expect(workerSrc).not.toContain('banned_players');
    expect(workerSrc).not.toMatch(/from\(["'](guild_members|accounts)["']\)\.(insert|update|upsert|delete)/);
  });

  it('reads roster/account data only for the slash commands and writes absences through the validated service-role RPC', () => {
    expect(workerSrc).toContain('.from("guild_members")');
    expect(workerSrc).toContain('.from("accounts")');
    expect(workerSrc).toContain('.from("discord_account_links")');
    expect(workerSrc).toContain('gm_upsert_player_absence');
  });

  it('still reads the channel -> guild config map, and forwards verification screenshots to the Edge Function', () => {
    expect(workerSrc).toContain('eq("key", "discord_verification_channel_id")');
    expect(workerSrc).toContain('VERIFICATION_FUNCTION_URL');
    expect(workerSrc).toContain('DISCORD_WORKER_SECRET');
  });

  it('schedules auto-deletion for screenshots and bot replies to keep verification clean', () => {
    expect(workerSrc).toContain('message.delete()');
    expect(workerSrc).toContain('result?.bot_message_id');
  });

  it('grants the extra verified-member role ONLY to a confirmed guild member', () => {
    // discord_member_role_id is auto-wired by the provisioner to a tag-bearing
    // "[TAG] Member" role, so granting it on a visitor or pending outcome
    // hands out exactly what the roster gate exists to withhold.
    const okIdx = workerSrc.indexOf('result?.ok === true');
    // lastIndexOf, not indexOf: the first occurrence is the declaration.
    const roleIdx = workerSrc.lastIndexOf('await addVerifiedRole(message,');
    expect(okIdx).toBeGreaterThan(-1);
    expect(roleIdx).toBeGreaterThan(okIdx);
    const between = workerSrc.slice(okIdx, roleIdx);
    expect(between).toContain('result.role === "guild_member"');
  });
});
