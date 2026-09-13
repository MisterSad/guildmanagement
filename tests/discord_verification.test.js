// Discord bot: profile-verification feature (screenshot -> role, nickname,
// roster upsert). Exercises the real decision logic in
// _shared/discord-verification.ts against a fake Supabase client (same
// pattern as tests/discord_bot_phase2.test.js), plus static regressions
// confirming the Edge Function stays a thin caller and the always-on worker
// never writes to roster/account tables directly -- the worker only reads
// `guild_members`/`accounts`/`discord_account_links` for its /profile and
// /absent slash commands and routes every write through the validated
// service-role RPC (gm_upsert_player_absence). No path ever writes to
// `accounts` (screenshot-only trust model -- roster presence, never a login
// credential).

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  normalizeTag,
  resolveExpectedTag,
  resolveTagToGuild,
  evaluateVerification,
  DEFAULT_GUILD_TAGS,
} from '../supabase/functions/_shared/discord-verification.ts';

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

describe('normalizeTag', () => {
  it('strips brackets, trims, and uppercases', () => {
    expect(normalizeTag('[PR1M]')).toBe('PR1M');
    expect(normalizeTag('pr1m')).toBe('PR1M');
    expect(normalizeTag('  [Pr1M]  ')).toBe('PR1M');
    expect(normalizeTag(null)).toBe('');
    expect(normalizeTag(undefined)).toBe('');
  });
});

describe('resolveExpectedTag', () => {
  it('uses the guild_config override when set', async () => {
    const admin = makeFakeAdmin({ tableResponses: { 'guild_config:select': { data: { value: '[CUSTOM]' }, error: null } } });
    expect(await resolveExpectedTag(admin, 'ALPHA')).toBe('[CUSTOM]');
  });

  it('falls back to the known default tag when no override is set', async () => {
    const admin = makeFakeAdmin({ tableResponses: { 'guild_config:select': { data: null, error: null } } });
    expect(await resolveExpectedTag(admin, 'ALPHA')).toBe(DEFAULT_GUILD_TAGS.ALPHA);
  });

  it('falls back to [GUILD] for an unknown guild with no override', async () => {
    const admin = makeFakeAdmin({ tableResponses: { 'guild_config:select': { data: null, error: null } } });
    expect(await resolveExpectedTag(admin, 'NEWGUILD')).toBe('[NEWGUILD]');
  });
});

describe('resolveTagToGuild', () => {
  it('returns null immediately for an empty tag, without any DB calls', async () => {
    const admin = makeFakeAdmin();
    expect(await resolveTagToGuild(admin, '')).toBeNull();
    expect(admin.calls.length).toBe(0);
  });

  it('matches a guild_config override for some other guild than the caller\'s own channel', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_config:select': { data: [{ guild: 'OMEGA', value: '[CUSTOM]' }], error: null },
        'guilds:select': { data: { server_number: '2200' }, error: null },
      },
    });
    const res = await resolveTagToGuild(admin, 'CUSTOM');
    expect(res).toEqual({ fgfGuild: 'OMEGA', tagDisplay: '[CUSTOM]', serverNumber: '2200' });
  });

  it('falls back to a DEFAULT_GUILD_TAGS entry when no override matches', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_config:select': { data: [], error: null },
        'guilds:select': { data: { server_number: '1058' }, error: null },
      },
    });
    const res = await resolveTagToGuild(admin, 'PR1M');
    expect(res).toEqual({ fgfGuild: 'ALPHA', tagDisplay: DEFAULT_GUILD_TAGS.ALPHA, serverNumber: '1058' });
  });

  it('returns null when the tag matches no known guild at all', async () => {
    const admin = makeFakeAdmin({ tableResponses: { 'guild_config:select': { data: [], error: null } } });
    const res = await resolveTagToGuild(admin, 'UNKNOWNTAG');
    expect(res).toBeNull();
  });

  it('returns null server number when the resolved guild has none on file', async () => {
    const admin = makeFakeAdmin({
      tableResponses: {
        'guild_config:select': { data: [], error: null },
        'guilds:select': { data: null, error: null },
      },
    });
    const res = await resolveTagToGuild(admin, 'PR1M');
    expect(res).toEqual({ fgfGuild: 'ALPHA', tagDisplay: DEFAULT_GUILD_TAGS.ALPHA, serverNumber: null });
  });
});

describe('evaluateVerification', () => {
  const baseExtracted = { pseudo: 'HawkEye', uid: 'uid-123', power: 1_500_000, glory: 200_000 };

  it('rejects a banned player', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'banned_players:select': { data: { uid: 'uid-123' }, error: null } },
    });
    const res = await evaluateVerification(admin, 'ALPHA', 'discord-1', baseExtracted);
    expect(res).toEqual({ ok: false, error: 'banned' });
  });

  it('rejects a UID already registered under a different guild', async () => {
    const admin = makeFakeAdmin({
      rpcResponses: {
        gm_find_player_by_uid: { data: { found: true, player: { pseudo: 'HawkEye', guild: 'OMEGA', overall_power: 1_000_000 } }, error: null },
      },
    });
    const res = await evaluateVerification(admin, 'ALPHA', 'discord-1', baseExtracted);
    expect(res).toEqual({ ok: false, error: 'uid_registered_elsewhere' });
  });

  it('inserts a new player with role R1 when the UID is not found anywhere', async () => {
    const admin = makeFakeAdmin({
      rpcResponses: { gm_find_player_by_uid: { data: { found: false }, error: null } },
    });
    const res = await evaluateVerification(admin, 'ALPHA', 'discord-1', baseExtracted);
    expect(res).toEqual({ ok: true, finalPseudo: 'HawkEye', isNewPlayer: true, power: 1_500_000, glory: 200_000 });
    const insertCall = admin.calls.find((c) => c.table === 'guild_members' && c.op === 'insert');
    expect(insertCall.payload).toEqual({
      pseudo: 'HawkEye', uid: 'uid-123', guild: 'ALPHA', overall_power: 1_500_000, glory_score: 200_000, role: 'R1',
    });
  });

  it('updates an existing player and keeps the on-file pseudo, not a fresh OCR guess', async () => {
    const admin = makeFakeAdmin({
      rpcResponses: {
        gm_find_player_by_uid: { data: { found: true, player: { pseudo: 'OnFileName', guild: 'ALPHA', overall_power: 900_000 } }, error: null },
      },
    });
    const res = await evaluateVerification(admin, 'ALPHA', 'discord-1', { ...baseExtracted, pseudo: 'FreshOCRRead' });
    expect(res.ok).toBe(true);
    expect(res.finalPseudo).toBe('OnFileName');
    expect(res.isNewPlayer).toBe(false);
    const updateCall = admin.calls.find((c) => c.table === 'guild_members' && c.op === 'update');
    expect(updateCall.payload).toEqual({ overall_power: 1_500_000, glory_score: 200_000 });
    expect(admin.calls.some((c) => c.table === 'guild_members' && c.op === 'insert')).toBe(false);
  });

  it('surfaces a db_error without throwing when the write fails', async () => {
    const admin = makeFakeAdmin({
      tableResponses: { 'guild_members:insert': { error: { message: 'constraint violation' } } },
      rpcResponses: { gm_find_player_by_uid: { data: { found: false }, error: null } },
    });
    const res = await evaluateVerification(admin, 'ALPHA', 'discord-1', baseExtracted);
    expect(res).toEqual({ ok: false, error: 'db_error' });
  });

  it('never writes to accounts -- roster-only, no login credentials created', async () => {
    const admin = makeFakeAdmin({
      rpcResponses: { gm_find_player_by_uid: { data: { found: false }, error: null } },
    });
    await evaluateVerification(admin, 'ALPHA', 'discord-1', baseExtracted);
    expect(admin.calls.some((c) => c.table === 'accounts')).toBe(false);
  });
});

describe('Regression: discord-profile-verification role decision (Visitor fallback)', () => {
  const fnSrc = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/discord-profile-verification/index.ts'),
    'utf-8'
  );

  it('only calls evaluateVerification (and only touches guild_members) once a matching guild role was found', () => {
    const roleCheckIdx = fnSrc.indexOf('const matchedGuildRole');
    const evalIdx = fnSrc.indexOf('evaluateVerification(admin, fgfGuild, discordUserId, extracted)');
    expect(roleCheckIdx).toBeGreaterThan(-1);
    expect(evalIdx).toBeGreaterThan(roleCheckIdx);
    // The Visitor branch returns before reaching evaluateVerification.
    const visitorBranchIdx = fnSrc.indexOf('if (!matchedGuildRole)');
    expect(visitorBranchIdx).toBeGreaterThan(-1);
    expect(visitorBranchIdx).toBeLessThan(evalIdx);
  });

  it('requires BOTH the tag to match this channel\'s guild AND a same-named role to exist, else falls back to Visitor', () => {
    expect(fnSrc).toContain('tagMatchesThisChannel ? findRoleByNormalizedName(serverRoles, expectedTagNormalized) : null');
    expect(fnSrc).toContain('findRoleByNormalizedName(serverRoles, VISITOR_ROLE_NAME)');
  });

  it('still resolves a "[TAG] Pseudo #Server" nickname on the Visitor path via resolveTagToGuild, never from raw unverified OCR text', () => {
    const visitorIdx = fnSrc.indexOf('if (!matchedGuildRole)');
    const guildMemberIdx = fnSrc.indexOf('Real guild member');
    const visitorBlock = fnSrc.slice(visitorIdx, guildMemberIdx);
    expect(visitorBlock).toContain('resolveTagToGuild(admin, extractedTagNormalized)');
    expect(visitorBlock).toContain('assignRoleAndNickname(discordServerId, discordUserId, visitorRole.id, visitorNickname, logger)');
    // No nickname at all when the tag doesn't resolve to any known guild.
    expect(visitorBlock).toContain('tagMatch ? buildNickname(tagMatch.tagDisplay, pseudo, tagMatch.serverNumber) : null');
  });
});

describe('Regression: discord-profile-verification stays a thin caller', () => {
  const fnSrc = fs.readFileSync(
    path.resolve(__dirname, '../supabase/functions/discord-profile-verification/index.ts'),
    'utf-8'
  );

  it('delegates every guild_members / ban / cross-guild decision to the shared module', () => {
    expect(fnSrc).toContain('evaluateVerification(admin, fgfGuild, discordUserId, extracted)');
    expect(fnSrc).not.toMatch(/from\(["']guild_members["']\)\.insert/);
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
    const ocrIdx = fnSrc.indexOf('callGeminiVision(');
    expect(rateLimitIdx).toBeGreaterThan(-1);
    expect(ocrIdx).toBeGreaterThan(rateLimitIdx);
  });
});

describe('Regression: discord-verification-worker keeps business writes out', () => {
  const workerSrc = fs.readFileSync(
    path.resolve(__dirname, '../discord-verification-worker/index.js'),
    'utf-8'
  );

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
    expect(workerSrc).toContain("eq(\"key\", \"discord_verification_channel_id\")");
    expect(workerSrc).toContain('VERIFICATION_FUNCTION_URL');
    expect(workerSrc).toContain('DISCORD_WORKER_SECRET');
  });
});
