// Season 2 (owner decisions, 2026-11-06): a notice for everyone on every visit
// while the app is in season 1, and a super-admin-only button that starts
// Season 2. The database side is supabase/tests/15_season_2.sql.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';
import { setVerifiedRole } from '../src/core/auth/roles';
import {
  showSeasonNoticeIfDue,
  resetSeasonNoticeForTests,
  renderSeasonCard,
  SEASON_2_CONFIRM_PHRASE,
} from '../src/modules/app/season/season';

function useDb(handlers) {
  const rpc = vi.fn(async (name, args) => (handlers[name] ? handlers[name](args) : { data: null, error: null }));
  setDbClient({ rpc });
  return rpc;
}

beforeEach(() => {
  resetSeasonNoticeForTests();
  document.body.innerHTML = '';
});
afterEach(() => {
  resetSupabaseClient();
  document.body.innerHTML = '';
});

describe('the Season 2 notice', () => {
  it('shows in season 1, with the agreed text', async () => {
    useDb({ gm_season_status: () => ({ data: { season: 1, started_at: null }, error: null }) });
    expect(await showSeasonNoticeIfDue()).toBe(true);
    const dlg = document.getElementById('season-2-notice');
    expect(dlg).not.toBeNull();
    expect(dlg.textContent).toContain('Season 2 is coming soon.');
    expect(dlg.textContent).toContain('events and event history');
    expect(dlg.textContent).toContain('Players and their military stats are kept.');
  });

  it('shows once per visit, not once per sign-in event', async () => {
    useDb({ gm_season_status: () => ({ data: { season: 1 }, error: null }) });
    await showSeasonNoticeIfDue();
    expect(await showSeasonNoticeIfDue()).toBe(false);
    expect(document.querySelectorAll('#season-2-notice').length).toBe(1);
  });

  it('is gone once Season 2 has started', async () => {
    useDb({ gm_season_status: () => ({ data: { season: 2, started_at: '2026-11-20T00:00:00Z' }, error: null }) });
    expect(await showSeasonNoticeIfDue()).toBe(false);
    expect(document.getElementById('season-2-notice')).toBeNull();
  });

  it('never blocks the app when the season cannot be read', async () => {
    useDb({ gm_season_status: () => ({ data: null, error: { message: 'boom' } }) });
    expect(await showSeasonNoticeIfDue()).toBe(false);
  });
});

describe('the Start Season 2 card', () => {
  function mountCard() {
    document.body.innerHTML = '<div id="season-card" class="hidden"><div id="season-card-body"></div></div>';
  }

  it('stays hidden for a guild admin', async () => {
    setVerifiedRole('guild_admin', 't_admin');
    mountCard();
    const rpc = useDb({});
    await renderSeasonCard();
    expect(document.getElementById('season-card').classList.contains('hidden')).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('lets the super admin start Season 2 only after typing the exact phrase', async () => {
    setVerifiedRole('super_admin', 't_super');
    mountCard();
    let season = 1;
    const rpc = useDb({
      gm_season_status: () => ({ data: { season }, error: null }),
      gm_start_season_2: () => {
        season = 2;
        return { data: { ok: true, season: 2, deleted: { event_participants: 10, war_sessions: 2 } }, error: null };
      },
    });
    await renderSeasonCard();
    expect(document.getElementById('season-card').classList.contains('hidden')).toBe(false);
    document.getElementById('season-2-start-btn').click();

    const input = document.getElementById('season-2-confirm-input');
    const confirm = document.getElementById('season-2-confirm-btn');
    expect(confirm.disabled).toBe(true);
    input.value = 'start season 2';
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled, 'the phrase is case-sensitive').toBe(true);
    input.value = SEASON_2_CONFIRM_PHRASE;
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(false);

    confirm.click();
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledWith('gm_start_season_2', { p_confirm: 'START SEASON 2' }));
    await vi.waitFor(() =>
      expect(document.getElementById('season-card-body').textContent).toContain('Season 2 has started')
    );
  });
});
