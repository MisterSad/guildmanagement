/**
 * tests/guild_rename_ui.test.js
 *
 * The client side of a guild TAG change (src/modules/app/admin/guild-rename.ts):
 * input normalisation, the localStorage migration, the RPC mapping, the dialog
 * and the Accounts & Access card. The rules themselves live in gm_rename_guild
 * and are covered by tests/guild_rename_migration.test.js.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  TAG_PATTERN,
  normalizeTag,
  renameErrorMessage,
  migrateLocalGuildKeys,
  renameGuild,
  fetchTagHistory,
  applyRenameToSession,
  openRenameGuildDialog,
  loadGuildTagCard
} from '../src/modules/app/admin/guild-rename';
import { getAppState, patchAppState, resetAppState } from '../src/core/state/app-state';

const CARD_DOM = `
  <div id="guild-tag-card" class="hidden">
    <span id="guild-tag-current"></span>
    <button id="guild-tag-rename-btn"></button>
    <div id="guild-tag-info"></div>
    <ul id="guild-tag-history" class="hidden"></ul>
  </div>
  <div id="toast-container"></div>
`;

function stubDb(handlers) {
  const calls = [];
  window.GM = {
    db: {
      rpc: vi.fn(async (name, args) => {
        calls.push({ name, args });
        const h = handlers[name];
        return h ? h(args) : { data: null, error: { message: 'no_handler' } };
      })
    }
  };
  return calls;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  resetAppState();
  document.body.innerHTML = CARD_DOM;
});

afterEach(() => {
  delete window.GM;
  document.getElementById('guild-rename-overlay')?.remove();
  vi.useRealTimers();
});

describe('normalizeTag', () => {
  it('uppercases, trims and strips brackets', () => {
    expect(normalizeTag('  [pr1m] ')).toBe('PR1M');
    expect(normalizeTag('ab_c')).toBe('AB_C');
    expect(normalizeTag(null)).toBe('');
  });

  it('matches the server format', () => {
    expect(TAG_PATTERN.test('AB')).toBe(true);
    expect(TAG_PATTERN.test('ABCDEFGHIJKL')).toBe(true);
    expect(TAG_PATTERN.test('A')).toBe(false);
    expect(TAG_PATTERN.test('ABCDEFGHIJKLM')).toBe(false);
    expect(TAG_PATTERN.test('A B')).toBe(false);
    expect(TAG_PATTERN.test('ÉTÉ')).toBe(false);
  });
});

describe('renameErrorMessage', () => {
  it('has a message for every server error code', () => {
    for (const code of ['invalid_tag', 'unchanged', 'tag_taken', 'tag_reserved', 'demo_protected', 'cooldown', 'unauthorized', 'guild_not_found']) {
      expect(renameErrorMessage(code)).not.toMatch(/could not be changed/);
    }
    expect(renameErrorMessage('boom')).toMatch(/boom/);
  });

  it('gives the date for a cooldown', () => {
    expect(renameErrorMessage('cooldown', '2026-10-10T07:00:00Z')).toMatch(/Next change possible on/);
  });
});

describe('migrateLocalGuildKeys', () => {
  it('moves the tag-keyed entries and the guild pointers', () => {
    localStorage.setItem('gm_config_AB_discord_webhook_url', 'https://discord.com/api/webhooks/1/x');
    localStorage.setItem('gm_server_number_AB', '1058');
    localStorage.setItem('gm_join_code_plain_AB', 'FGF-123');
    localStorage.setItem('gm_current_guild', 'AB');
    localStorage.setItem('gm_guild_restriction', 'AB');

    expect(migrateLocalGuildKeys(localStorage, 'AB', 'CD')).toBe(3);

    expect(localStorage.getItem('gm_config_CD_discord_webhook_url')).toBe('https://discord.com/api/webhooks/1/x');
    expect(localStorage.getItem('gm_server_number_CD')).toBe('1058');
    expect(localStorage.getItem('gm_join_code_plain_CD')).toBe('FGF-123');
    expect(localStorage.getItem('gm_config_AB_discord_webhook_url')).toBeNull();
    expect(localStorage.getItem('gm_server_number_AB')).toBeNull();
    expect(localStorage.getItem('gm_current_guild')).toBe('CD');
    expect(localStorage.getItem('gm_guild_restriction')).toBe('CD');
  });

  it('never touches another guild whose tag starts with the renamed one', () => {
    // A tag may contain an underscore, so AB_C's config keys also begin with
    // `gm_config_AB_`. Config keys are lowercase, tags uppercase.
    localStorage.setItem('gm_config_AB_C_server_number', '1100');
    localStorage.setItem('gm_server_number_ABC', '1200');
    localStorage.setItem('gm_current_guild', 'AB_C');

    expect(migrateLocalGuildKeys(localStorage, 'AB', 'CD')).toBe(0);
    expect(localStorage.getItem('gm_config_AB_C_server_number')).toBe('1100');
    expect(localStorage.getItem('gm_server_number_ABC')).toBe('1200');
    expect(localStorage.getItem('gm_current_guild')).toBe('AB_C');
  });

  it('is a no-op without a store or with identical tags', () => {
    expect(migrateLocalGuildKeys(null, 'AB', 'CD')).toBe(0);
    expect(migrateLocalGuildKeys(localStorage, 'AB', 'AB')).toBe(0);
  });
});

describe('RPC mapping', () => {
  it('renameGuild maps the jsonb answer', async () => {
    const calls = stubDb({
      gm_rename_guild: () => ({ data: { ok: false, error: 'cooldown', next_allowed_at: '2026-10-10T00:00:00Z' }, error: null })
    });
    const res = await renameGuild('AB', 'CD');
    expect(calls[0]).toEqual({ name: 'gm_rename_guild', args: { p_guild: 'AB', p_new_tag: 'CD' } });
    expect(res).toMatchObject({ ok: false, error: 'cooldown', nextAllowedAt: '2026-10-10T00:00:00Z' });
  });

  it('renameGuild reports a transport error as not ok', async () => {
    stubDb({ gm_rename_guild: () => ({ data: null, error: { message: 'network down' } }) });
    expect(await renameGuild('AB', 'CD')).toMatchObject({ ok: false, error: 'network down' });
  });

  it('fetchTagHistory survives an error', async () => {
    stubDb({ gm_guild_tag_history: () => ({ data: null, error: { message: 'x' } }) });
    expect(await fetchTagHistory('AB')).toEqual({ ok: false, history: [], nextAllowedAt: null, canRename: false, cooldownApplies: true });
  });
});

describe('applyRenameToSession', () => {
  it('moves the restriction and the selection, then reloads', () => {
    patchAppState({ currentGuild: 'AB', currentGuildRestriction: 'AB' });
    localStorage.setItem('gm_current_guild', 'AB');
    const reload = vi.fn();
    applyRenameToSession('AB', 'CD', reload);
    expect(getAppState().currentGuild).toBe('CD');
    expect(getAppState().currentGuildRestriction).toBe('CD');
    expect(localStorage.getItem('gm_current_guild')).toBe('CD');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('leaves a super_admin unrestricted', () => {
    patchAppState({ currentGuild: 'AB', currentGuildRestriction: null });
    applyRenameToSession('AB', 'CD', vi.fn());
    expect(getAppState().currentGuildRestriction).toBeNull();
    expect(getAppState().currentGuild).toBe('CD');
  });
});

describe('openRenameGuildDialog', () => {
  function type(value) {
    const input = document.getElementById('guild-rename-input');
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('validates as you type and blocks an invalid or unchanged tag', () => {
    openRenameGuildDialog('AB');
    const ok = document.getElementById('guild-rename-ok');
    const err = document.getElementById('guild-rename-error');
    expect(ok.disabled).toBe(true);
    type('a b');
    expect(ok.disabled).toBe(true);
    expect(err.textContent).toMatch(/2 to 12 characters/);
    type('[ab]');
    expect(ok.disabled).toBe(true);
    expect(err.textContent).toMatch(/already/);
    type('cd');
    expect(ok.disabled).toBe(false);
    expect(err.textContent).toBe('');
  });

  it('escapes the guild name in the title', () => {
    openRenameGuildDialog('<img src=x onerror=alert(1)>');
    expect(document.getElementById('guild-rename-title').innerHTML).not.toMatch(/<img/);
  });

  it('shows the server refusal inline and keeps the dialog open', async () => {
    stubDb({ gm_rename_guild: () => ({ data: { ok: false, error: 'tag_taken' }, error: null }) });
    openRenameGuildDialog('AB');
    type('CD');
    document.getElementById('guild-rename-ok').click();
    await flush();
    expect(document.getElementById('guild-rename-error').textContent).toMatch(/already uses/);
    expect(document.getElementById('guild-rename-overlay')).not.toBeNull();
  });

  it('renaming another guild calls back without touching the session', async () => {
    patchAppState({ currentGuild: 'ZZ' });
    localStorage.setItem('gm_server_number_AB', '1058');
    const calls = stubDb({ gm_rename_guild: () => ({ data: { ok: true, guild: 'CD', old_guild: 'AB' }, error: null }) });
    const onRenamed = vi.fn();
    openRenameGuildDialog('AB', onRenamed);
    type('cd');
    document.getElementById('guild-rename-ok').click();
    await flush();
    expect(calls[0].args).toEqual({ p_guild: 'AB', p_new_tag: 'CD' });
    expect(onRenamed).toHaveBeenCalledWith('CD');
    expect(getAppState().currentGuild).toBe('ZZ');
    expect(localStorage.getItem('gm_server_number_CD')).toBe('1058');
  });
});

describe('loadGuildTagCard', () => {
  it('stays hidden when the server says the caller cannot rename (server_admin)', async () => {
    patchAppState({ currentGuild: 'AB' });
    stubDb({ gm_guild_tag_history: () => ({ data: { ok: true, history: [], can_rename: false }, error: null }) });
    await loadGuildTagCard();
    expect(document.getElementById('guild-tag-card').classList.contains('hidden')).toBe(true);
  });

  it('stays hidden with no active guild, without asking the server', async () => {
    const calls = stubDb({});
    await loadGuildTagCard();
    expect(document.getElementById('guild-tag-card').classList.contains('hidden')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('shows the tag, the history and the cooldown to a guild_admin', async () => {
    patchAppState({ currentGuildRestriction: 'CD', currentGuild: 'CD' });
    const next = new Date(Date.now() + 3 * 86400000).toISOString();
    stubDb({
      gm_guild_tag_history: () => ({
        data: { ok: true, can_rename: true, cooldown_applies: true, next_allowed_at: next, history: [{ old_tag: 'AB', new_tag: 'CD', changed_at: new Date().toISOString() }] },
        error: null
      })
    });
    await loadGuildTagCard();
    expect(document.getElementById('guild-tag-card').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('guild-tag-current').textContent).toBe('CD');
    expect(document.getElementById('guild-tag-rename-btn').disabled).toBe(true);
    expect(document.getElementById('guild-tag-info').textContent).toMatch(/Next change possible/);
    expect(document.getElementById('guild-tag-history').textContent).toMatch(/AB → CD/);
  });

  it('does not lock the super_admin out during the cooldown', async () => {
    patchAppState({ currentGuild: 'CD' });
    stubDb({
      gm_guild_tag_history: () => ({
        data: { ok: true, can_rename: true, cooldown_applies: false, next_allowed_at: new Date(Date.now() + 86400000).toISOString(), history: [] },
        error: null
      })
    });
    await loadGuildTagCard();
    expect(document.getElementById('guild-tag-rename-btn').disabled).toBe(false);
  });

  it('stays hidden when the server refuses the history', async () => {
    patchAppState({ currentGuild: 'CD' });
    stubDb({ gm_guild_tag_history: () => ({ data: { ok: false, error: 'unauthorized' }, error: null }) });
    await loadGuildTagCard();
    expect(document.getElementById('guild-tag-card').classList.contains('hidden')).toBe(true);
  });
});
