// Medium-term plan, M4a: the browser's multi-step guild writes are single
// transactional RPCs, all called through guildWrite(). These tests run it,
// and guard the converted flows against sliding back to table writes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { guildWrite, GuildWriteError } from '../src/core/api/guild-rpc';
import { setVerifiedRole } from '../src/core/auth/roles';
import { READ_ONLY_MESSAGE } from '../src/core/api/db-guard';
import { getAppState, patchAppState } from '../src/core/state/app-state';
import { getClient, setDbClient, resetSupabaseClient } from '../src/core/api/supabase';

function fakeDb(answer) {
  const calls = [];
  return {
    calls,
    rpc: vi.fn(async (name, args) => {
      calls.push({ name, args });
      return answer;
    }),
  };
}

/** Installs a fake as the app's client, the way main.ts installs the real one. */
function useDb(answer) {
  const db = fakeDb(answer);
  setDbClient(db);
  return db;
}

beforeEach(() => {
  localStorage.setItem('gm_current_guild', 'ALPHA');
});
afterEach(() => {
  localStorage.clear();
  resetSupabaseClient();
});

describe('guildWrite', () => {
  it('calls the function for the active guild and returns its answer', async () => {
    setVerifiedRole('super_admin', 't_super');
    useDb({ data: { ok: true, removed: 'Bob' }, error: null });
    await expect(guildWrite('gm_ban_member', { p_uid: '7000002' })).resolves.toEqual({ ok: true, removed: 'Bob' });
    expect(getClient().calls).toEqual([{ name: 'gm_ban_member', args: { p_guild: 'ALPHA', p_uid: '7000002' } }]);
  });

  it('refuses a read-only caller before sending anything', async () => {
    setVerifiedRole('member', 't_member');
    useDb({ data: { ok: true }, error: null });
    await expect(guildWrite('gm_ban_member', {})).rejects.toThrow(READ_ONLY_MESSAGE);
    expect(getClient().rpc).not.toHaveBeenCalled();
  });

  it('refuses an unresolved tenant', async () => {
    setVerifiedRole('super_admin', 't_super');
    const before = getAppState();
    patchAppState({ currentGuild: null, currentGuildRestriction: null });
    localStorage.removeItem('gm_current_guild');
    useDb({ data: { ok: true }, error: null });
    try {
      await expect(guildWrite('gm_ban_member', {})).rejects.toBeInstanceOf(GuildWriteError);
      expect(getClient().rpc).not.toHaveBeenCalled();
    } finally {
      patchAppState({ currentGuild: before.currentGuild, currentGuildRestriction: before.currentGuildRestriction });
    }
  });

  it('throws on a database error and on an { ok: false } answer, with the code', async () => {
    setVerifiedRole('super_admin', 't_super');
    useDb({ data: null, error: { message: 'forbidden', code: '42501' } });
    await expect(guildWrite('gm_ban_member', {})).rejects.toMatchObject({ code: '42501', message: 'forbidden' });
    useDb({ data: { ok: false, error: 'already_banned' }, error: null });
    await expect(guildWrite('gm_ban_member', {})).rejects.toMatchObject({ code: 'already_banned' });
  });
});

describe('the converted flows stay single calls', () => {
  const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

  it.each([
    [
      'src/modules/shadowfront/views/ShadowfrontView.ts',
      'private async editSquadSchedule',
      'EventsService.rescheduleSession(',
    ],
    ['src/modules/events/views/EventsView.ts', 'private async editEventSchedule', 'EventsService.rescheduleSession('],
    [
      'src/modules/armsrace/views/ArmsRaceView.ts',
      'private async editStageSchedule',
      'EventsService.rescheduleSession(',
    ],
  ])('%s reschedules through the transactional RPC', (file, marker, call) => {
    const src = read(file);
    const start = src.indexOf(marker);
    const block = src.slice(start, src.indexOf('\n  private ', start + marker.length));
    expect(block).toContain(call);
    expect(block).not.toMatch(
      /\.from\('event_status'\)\.update|\.from\('event_participants'\)\.update|\.from\('shadowfront_squads'\)\.update/
    );
  });

  it('no browser code writes the tables these functions now own, in their flows', () => {
    expect(read('src/modules/app/members/banned.controller.ts')).not.toContain("from('banned_players').insert");
    expect(read('src/modules/app/members/members.controller.ts')).not.toMatch(
      /from\('player_name_history'\)\.insert|from\('guild_members'\)\.insert/
    );
    expect(read('src/modules/app/admin/migration-groups.controller.ts')).not.toContain(
      "from('server_migration_groups').insert"
    );
    expect(read('src/modules/app/ocr/ocr.controller.ts')).not.toMatch(
      /from\('guild_members'\)\.(insert|update|delete)|from\('event_participants'\)\.(insert|update)/
    );
    expect(read('src/modules/history/views/HistoryView.ts')).not.toMatch(
      /from\('(event_participants|event_status|shadowfront_squads)'\)\.delete/
    );
  });
});
