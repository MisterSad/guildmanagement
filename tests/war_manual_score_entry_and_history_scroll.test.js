/**
 * tests/war_manual_score_entry_and_history_scroll.test.js
 *
 * Verifies the bug fixes for:
 * 1. Manual score entries on the main active event page saving cleanly without null
 *    payloads rejected by Postgres RPC public.gm_upsert_daily_scores.
 * 2. Toast notification ('Daily scores saved.') appearing upon successful score save.
 * 3. Immediate flush on 'change' event in addition to debounced 'input'.
 * 4. History modal table column alignment: col_participated is rendered in both
 *    header and rows for granular war sessions (preventing cell misalignment).
 * 5. History modal table scrolling: container is constrained with visible scrollbars
 *    and sticky headers, with modal width expanded to 1080px.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EventsView } from '../src/modules/events/views/EventsView';
import { HistoryView } from '../src/modules/history/views/HistoryView';
import { EventsService } from '../src/modules/events/events.service';
import { showToast } from '../src/core/dom/toast';

// The views import their helpers directly (no more `window.GM.*` reads): mock
// the source modules with the stubs the suite used to put on window.GM.
vi.mock('../src/core/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal()),
  t: (k) => k,
}));
vi.mock('../src/core/dom/toast', async (importOriginal) => ({
  ...(await importOriginal()),
  showToast: vi.fn(),
}));

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

describe('War Manual Score Entry & History Modal Scroll', () => {
  let upsertDailyScoresSpy;

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.mocked(showToast).mockReset();
    localStorage.setItem('gm_current_guild', 'ALPHA');
    localStorage.setItem('gm_role', 'guild_admin');
    upsertDailyScoresSpy = vi.spyOn(EventsService, 'upsertDailyScores').mockResolvedValue({ ok: true, count: 1 });
  });

  afterEach(() => {
    delete window.GM;
    delete window.requestAnimationFrame;
    localStorage.clear();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('EventsView: Manual score entry & daily upsert safety', () => {
    it('sends purely numeric scores (never null or NaN) when some day inputs are left blank', async () => {
      const showToastMock = vi.mocked(showToast);
      // Only the Supabase client is still read from `window.GM` (via getClient()).
      window.GM = { db: null };

      const view = new EventsView();
      // Setup state for active SvS tab
      view.state['SvS'] = {
        activeEventName: 'SvS',
        sessionId: 'SVS-2026-W38',
        participants: [{ pseudo: 'Warrior1', participated: 0, score_prep: 0, score_pvp: 0 }],
        war: {
          session: { guild: 'ALPHA', event_name: 'SvS', session_id: 'SVS-2026-W38' },
          grid: [],
          daily: {},
        },
      };

      // Mock DOM row with day 1 filled, day 2..6 blank
      const row = document.createElement('tr');
      row.className = 'participant-row';
      row.setAttribute('data-pseudo', 'Warrior1');
      row.innerHTML = `
        <td><input type="checkbox" class="participation-checkbox"></td>
        <td><input class="day-score-input" data-pseudo="Warrior1" data-day="1" value="5000000"></td>
        <td><input class="day-score-input" data-pseudo="Warrior1" data-day="2" value=""></td>
        <td><input class="day-score-input" data-pseudo="Warrior1" data-day="3" value=""></td>
        <td><input class="day-score-input" data-pseudo="Warrior1" data-day="4" value=""></td>
        <td><input class="day-score-input" data-pseudo="Warrior1" data-day="5" value=""></td>
        <td><input class="day-score-input" data-pseudo="Warrior1" data-day="6" value=""></td>
        <td class="player-chests-cell">-</td>
      `;
      document.body.appendChild(row);

      // Trigger saveGranularRow
      await view.saveGranularRow('SvS', 'Warrior1', row);

      expect(upsertDailyScoresSpy).toHaveBeenCalled();
      const sentRows = upsertDailyScoresSpy.mock.calls[0][3];
      // Must not send null scores
      for (const r of sentRows) {
        expect(typeof r.score).toBe('number');
        expect(isNaN(r.score)).toBe(false);
        expect(r.score).not.toBeNull();
      }
      expect(sentRows).toEqual([{ pseudo: 'Warrior1', day: 1, score: 5000000 }]);

      // Shows success toast
      expect(showToastMock).toHaveBeenCalledWith('war_save_daily_success', 'success');

      // Participation checkbox updated
      const cb = row.querySelector('.participation-checkbox');
      expect(cb.checked).toBe(true);
      expect(row.classList.contains('participated')).toBe(true);
    });

    it('flushes granular input save immediately on change event in wireGranularInputs', async () => {
      const showToastMock = vi.mocked(showToast);
      // Only the Supabase client is still read from `window.GM` (via getClient()).
      window.GM = { db: null };

      const view = new EventsView();
      view.state['SvS'] = {
        activeEventName: 'SvS',
        sessionId: 'SVS-2026-W38',
        participants: [{ pseudo: 'Warrior1', participated: 0, score_prep: 0, score_pvp: 0 }],
        war: {
          session: { guild: 'ALPHA', event_name: 'SvS', session_id: 'SVS-2026-W38' },
          grid: [],
          daily: {},
        },
      };

      const container = document.createElement('div');
      container.innerHTML = `
        <table>
          <tr class="participant-row" data-pseudo="Warrior1">
            <td><input type="checkbox" class="participation-checkbox"></td>
            <td><input class="day-score-input" data-pseudo="Warrior1" data-day="1" value="7777777"></td>
            <td class="player-chests-cell">-</td>
          </tr>
        </table>
      `;
      document.body.appendChild(container);

      // Wire granular inputs
      view.wireGranularInputs(container, 'SvS');

      const inp = container.querySelector('.day-score-input');
      expect(inp).toBeTruthy();

      // Dispatch change event
      inp.dispatchEvent(new Event('change', { bubbles: true }));

      // Give microtasks time to resolve
      await new Promise((r) => setTimeout(r, 20));

      // Should have called upsertDailyScoresSpy immediately without waiting 700ms debounce
      expect(upsertDailyScoresSpy).toHaveBeenCalled();
      const sentRows = upsertDailyScoresSpy.mock.calls[0][3];
      expect(sentRows).toEqual([{ pseudo: 'Warrior1', day: 1, score: 7777777 }]);
      expect(showToastMock).toHaveBeenCalledWith('war_save_daily_success', 'success');

      const cb = container.querySelector('.participation-checkbox');
      expect(cb.checked).toBe(true);
    });
  });

  describe('HistoryView: Granular modal layout & column synchronization', () => {
    it('includes col_participated in both header and rows for granular war sessions', () => {
      // Only the Supabase client is still read from `window.GM` (via getClient()).
      window.GM = { db: null };

      const view = new HistoryView();
      const meta = { label: 'SvS War', icon: 'ph-swords', hasScore: true };
      const rows = [{ pseudo: 'Warrior1', participated: 1, score: 0, score_prep: 100, score_pvp: 200 }];
      const warExtra = {
        grid: [],
        daily: { Warrior1: [{ day: 1, score: 100, chests_unlocked: 0 }] },
      };

      view.renderSessionModal('SvS', 'SVS-2026-W38', '2026-08-03', rows, meta, false, true, warExtra);

      const modal = document.getElementById('history-modal');
      expect(modal).toBeTruthy();

      const table = modal.querySelector('table');
      expect(table).toBeTruthy();

      const ths = table.querySelectorAll('thead th');
      const tds = table.querySelectorAll('tbody tr td');

      // Member (1) + Participated (1) + Days 1..6 (6) = 8 columns without grid
      expect(ths.length).toBe(8);
      // Row must also have exactly 8 td cells (not 7!)
      expect(tds.length).toBe(8);

      // Verify col_participated is in the second header position
      expect(ths[1].textContent).toContain('col_participated');

      // Verify second td cell contains the participation checkbox
      const partCb = tds[1].querySelector('.hist-edit-check[data-field="participated"]');
      expect(partCb).toBeTruthy();

      // Verify table wrapper classes for sticky header & scroll
      const wrap = modal.querySelector('.gm-table-wrap');
      expect(wrap.classList.contains('gm-ui-table-wrap')).toBe(true);
      expect(table.classList.contains('gm-ui-table-el')).toBe(true);
      expect(table.classList.contains('gm-ui-table-sticky')).toBe(true);
    });
  });

  describe('CSS styling verification', () => {
    it('defines 1080px max-width for gm-ui-dialog-lg and overflow:auto on table-scroll', () => {
      const css = read('styles.css');
      expect(css).toMatch(/\.gm-ui-dialog-lg\s*\{\s*max-width:\s*1080px;/);
      expect(css).toMatch(/\.gm-ui-dialog-body\s+\.gm-table-scroll\s*\{\s*overflow:\s*auto;\s*max-height:\s*52vh;/);
      expect(css).toMatch(/\.gm-ui-dialog-body\s+\.gm-table\s+thead\s+th\s*\{\s*position:\s*sticky;/);
    });
  });
});
