import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EventsView } from '../src/modules/events/views/EventsView';
import { renderWarStatusBadge } from '../src/components/ui/Badge';
import { setDbClient } from '../src/core/api/supabase';

const SESSION = '2026-08-03';

function chained(data) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: data[0] || null, error: null })),
    then: (resolve) => Promise.resolve({ data, error: null }).then(resolve)
  };
  return query;
}

let rpcMock;
let currentTables;

function installDb() {
  rpcMock = vi.fn(async (name, params) => {
    if (name === 'gm_upsert_war_session') {
      return {
        data: {
          ok: true,
          session: {
            guild: 'ALPHA',
            event_name: 'SvS',
            session_id: SESSION,
            ...(params.p_daily_results ? {
              day1_result: params.p_daily_results.day1 !== undefined ? params.p_daily_results.day1 : null
            } : {})
          }
        },
        error: null
      };
    }
    return { data: 0, error: null };
  });
  setDbClient({ from: (table) => chained(currentTables[table] || []), rpc: rpcMock });
}

function mount() {
  const panel = (id) =>
    '<main id="' + id + '">' +
      '<div class="event-status-badge"></div><div class="gm-event-actions"></div>' +
      '<div class="war-banner"></div>' +
      '<div class="event-card-container"></div>' +
      '<div class="event-table-container"></div>' +
    '</main>';
  document.body.innerHTML = panel('event-svs') + panel('event-gvg');
}

describe('War Day Results Toggle & Badge Cycling', () => {
  beforeEach(() => {
    currentTables = {
      event_status: [{ event_name: 'SvS', guild: 'ALPHA', is_active: true, session_id: SESSION, stage: null, start_at: '2026-08-03' }],
      event_participants: []
    };
    installDb();
    mount();
  });

  it('renders renderWarStatusBadge in neutral mode with default tone and dash label', () => {
    const badgeHtml = renderWarStatusBadge('neutral');
    expect(badgeHtml).toContain('gm-ui-badge-default');
    expect(badgeHtml).toContain('—');
    expect(badgeHtml).not.toContain('gm-ui-badge-warning');
  });

  it('renders renderWarStatusBadge in won mode with success tone and W', () => {
    const badgeHtml = renderWarStatusBadge('W');
    expect(badgeHtml).toContain('gm-ui-badge-success');
    expect(badgeHtml).toContain('W');
  });

  it('renders renderWarStatusBadge in lost mode with danger tone and L', () => {
    const badgeHtml = renderWarStatusBadge('L');
    expect(badgeHtml).toContain('gm-ui-badge-danger');
    expect(badgeHtml).toContain('L');
  });

  it('initializes all days to neutral by default', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    const toggles = document.querySelectorAll('#event-svs .war-day-toggle');
    expect(toggles.length).toBe(6);

    toggles.forEach((btn, idx) => {
      const day = idx + 1;
      expect(btn.className).toContain('war-day-neutral');
      expect(btn.className).not.toContain('war-day-won');
      expect(btn.className).not.toContain('war-day-lost');
      expect(btn.getAttribute('data-result')).toBe('neutral');
      expect(btn.getAttribute('title')).toBe(`Day ${day} : Neutral (Click: Won)`);
      expect(btn.querySelector('.war-day-state').innerHTML).toContain('gm-ui-badge-default');
      expect(btn.querySelector('.war-day-state').innerHTML).toContain('—');
    });
  });

  it('cycles 3 states on click: Neutral -> Won -> Lost -> Neutral', async () => {
    const view = new EventsView();
    await view.loadEvent('SvS');

    const d2 = document.querySelector('#event-svs .war-day-toggle[data-day="2"]');

    // Initial state: Neutral
    expect(d2.getAttribute('data-result')).toBe('neutral');
    expect(d2.getAttribute('title')).toBe('Day 2 : Neutral (Click: Won)');

    // 1st click -> Won
    d2.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(d2.className).toContain('war-day-won');
    expect(d2.getAttribute('data-result')).toBe('won');
    expect(d2.getAttribute('title')).toBe('Day 2 : Won (Click: Lost)');
    expect(d2.querySelector('.war-day-state').innerHTML).toContain('gm-ui-badge-success');

    // 2nd click -> Lost
    d2.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(d2.className).toContain('war-day-lost');
    expect(d2.getAttribute('data-result')).toBe('lost');
    expect(d2.getAttribute('title')).toBe('Day 2 : Lost (Click: Neutral)');
    expect(d2.querySelector('.war-day-state').innerHTML).toContain('gm-ui-badge-danger');

    // 3rd click -> Neutral (null)
    d2.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(d2.className).toContain('war-day-neutral');
    expect(d2.className).not.toContain('war-day-won');
    expect(d2.className).not.toContain('war-day-lost');
    expect(d2.getAttribute('data-result')).toBe('neutral');
    expect(d2.getAttribute('title')).toBe('Day 2 : Neutral (Click: Won)');
    expect(d2.querySelector('.war-day-state').innerHTML).toContain('gm-ui-badge-default');

    // 4th click -> Won again
    d2.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(d2.className).toContain('war-day-won');
    expect(d2.getAttribute('data-result')).toBe('won');
  });

  it('works identically in GvG', async () => {
    currentTables.event_status = [{ event_name: 'GvG', guild: 'ALPHA', is_active: true, session_id: SESSION, stage: null, start_at: '2026-08-03' }];
    const view = new EventsView();
    await view.loadEvent('GvG');

    const d6 = document.querySelector('#event-gvg .war-day-toggle[data-day="6"]');
    expect(d6.getAttribute('data-result')).toBe('neutral');

    // Click 1: Won
    d6.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(d6.className).toContain('war-day-won');

    // Click 2: Lost
    d6.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(d6.className).toContain('war-day-lost');

    // Click 3: Neutral
    d6.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(d6.className).toContain('war-day-neutral');
  });
});

describe('Database Migration 20260915130000 — Day Results Clear Fix', () => {
  const migPath = path.resolve(__dirname, '../supabase/migrations/20260915130000_fix_war_session_day_results_clear.sql');
  const migContent = fs.readFileSync(migPath, 'utf-8');

  it('re-defines gm_upsert_war_session without COALESCE blocking NULL resets', () => {
    expect(migContent).toContain('CREATE OR REPLACE FUNCTION public.gm_upsert_war_session');
    // Verifies CASE WHEN p_daily_results ? dayX THEN v_dX ELSE war_sessions.dayX_result END
    for (let d = 1; d <= 6; d++) {
      expect(migContent).toContain(`day${d}_result       = CASE WHEN p_daily_results IS NOT NULL AND p_daily_results ? 'day${d}'`);
      expect(migContent).toContain(`THEN v_d${d} ELSE war_sessions.day${d}_result END`);
    }
  });

  it('preserves RLS, search_path and execution privileges', () => {
    expect(migContent).toContain("SECURITY DEFINER");
    expect(migContent).toContain("SET search_path TO ''");
    expect(migContent).toContain('REVOKE ALL ON FUNCTION public.gm_upsert_war_session');
    expect(migContent).toContain('GRANT EXECUTE ON FUNCTION public.gm_upsert_war_session');
  });
});
