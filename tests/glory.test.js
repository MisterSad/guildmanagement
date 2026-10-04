import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gloryView } from '../src/modules/glory/views/GloryView';
import { getAppState, patchAppState } from '../src/core/state/app-state';
import { setDbClient, resetSupabaseClient } from '../src/core/api/supabase';
import { getWeekStart, getPrevWeekStart } from '../src/core/utils/date';
import { formatNumber } from '../src/core/utils/text';

const GLORY = gloryView;

const W_CUR = getWeekStart();
const W_PREV = getPrevWeekStart(W_CUR);

class MockBuilder {
  constructor(table, rows) {
    this.table = table;
    this.rows = rows || [];
    this.where = [];
    this.insertCalls = [];
  }
  select() {
    return this;
  }
  eq(field, value) {
    this.where.push([field, value]);
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  insert(items) {
    this.insertCalls.push(items);
    return Promise.resolve({ data: items, error: null });
  }
  then(resolve) {
    let rows = this.rows;
    for (const [field, value] of this.where) {
      rows = rows.filter((r) => r[field] === value);
    }
    return Promise.resolve({ data: rows, error: null }).then(resolve);
  }
}

describe('Glory Module Tests', () => {
  let containerEl;
  let mockParticipants;
  let insertTracker;
  let previousGuild;
  let mockDb;

  beforeEach(() => {
    containerEl = document.createElement('div');
    containerEl.id = 'event-glory';
    containerEl.innerHTML = '<div class="event-participants-area"></div>';
    document.body.appendChild(containerEl);

    insertTracker = [];
    mockParticipants = [
      // Kassandra has duplicate rows: one legacy ghost NULL and one with actual score
      {
        pseudo: 'Kassandra',
        guild: 'YARR',
        event_name: 'Glory',
        week_start: W_CUR,
        score: 569349274,
        session_id: 'GLORY-2026-W34',
      },
      { pseudo: 'Kassandra', guild: 'YARR', event_name: 'Glory', week_start: W_CUR, score: null, session_id: null },
      {
        pseudo: 'Kassandra',
        guild: 'YARR',
        event_name: 'Glory',
        week_start: W_PREV,
        score: 513905556,
        session_id: 'GLORY-2026-W33',
      },

      // Archangel has clean single row
      {
        pseudo: 'Archangel',
        guild: 'YARR',
        event_name: 'Glory',
        week_start: W_CUR,
        score: 182728890,
        session_id: 'GLORY-2026-W34',
      },
      {
        pseudo: 'Archangel',
        guild: 'YARR',
        event_name: 'Glory',
        week_start: W_PREV,
        score: 164804429,
        session_id: 'GLORY-2026-W33',
      },

      // Akastuki has only previous week score, no current row yet
      {
        pseudo: 'Akastuki',
        guild: 'YARR',
        event_name: 'Glory',
        week_start: W_PREV,
        score: 441077726,
        session_id: 'GLORY-2026-W33',
      },
    ];

    mockDb = {
      from: (table) => {
        if (table === 'guild_members') {
          return new MockBuilder(table, [
            { pseudo: 'Kassandra', guild: 'YARR' },
            { pseudo: 'Archangel', guild: 'YARR' },
            { pseudo: 'Akastuki', guild: 'YARR' },
          ]);
        }
        if (table === 'event_participants') {
          const b = new MockBuilder(table, mockParticipants);
          b.insert = (items) => {
            insertTracker.push(items);
            return Promise.resolve({ data: items, error: null });
          };
          return b;
        }
        return new MockBuilder(table, []);
      },
      rpc: vi.fn().mockResolvedValue({ data: [{ ok: true, error: null }], error: null }),
    };

    setDbClient(mockDb);
    // The view resolves the tenant through getActiveGuild() (typed import),
    // so set the real app state.
    previousGuild = getAppState().currentGuild;
    patchAppState({ currentGuild: 'YARR' });
  });

  afterEach(() => {
    if (containerEl && containerEl.parentNode) {
      containerEl.parentNode.removeChild(containerEl);
    }
    patchAppState({ currentGuild: previousGuild });
    resetSupabaseClient();
    vi.restoreAllMocks();
  });

  it('should load glory without raw un-sessioned insertions', async () => {
    await GLORY.load();

    // Must not insert ghost un-sessioned rows
    expect(insertTracker.length).toBe(0);
  });

  it('should correctly prioritize non-null scores over duplicate null rows', async () => {
    await GLORY.load();

    const kassandraInput = document.querySelector('input[data-pseudo="Kassandra"]');
    expect(kassandraInput).not.toBeNull();
    // Kassandra should display 569 349 274, not 0
    expect(kassandraInput.value).toBe(formatNumber(569349274));

    const archangelInput = document.querySelector('input[data-pseudo="Archangel"]');
    expect(archangelInput).not.toBeNull();
    expect(archangelInput.value).toBe(formatNumber(182728890));

    const akastukiInput = document.querySelector('input[data-pseudo="Akastuki"]');
    expect(akastukiInput).not.toBeNull();
    expect(akastukiInput.value).toBe('');
  });

  it('should invoke gm_upsert_player_glory with parsed numerical score on save', async () => {
    await GLORY.load();

    const akastukiInput = document.querySelector('input[data-pseudo="Akastuki"]');
    expect(akastukiInput).not.toBeNull();

    akastukiInput.value = '453 578 424';
    akastukiInput.dispatchEvent(new Event('input'));

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(mockDb.rpc).toHaveBeenCalledWith('gm_upsert_player_glory', {
      p_guild: 'YARR',
      p_pseudo: 'Akastuki',
      p_week_start: W_CUR,
      p_glory: 453578424,
    });
  });
});
