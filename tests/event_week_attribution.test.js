// ADR-023: an event counts in the ISO week (Monday, UTC) of its start date,
// whenever it is closed or its scores are typed. The database enforces it
// (supabase/tests/13_event_week_attribution.sql); these tests run the browser
// side: starting and ending go through the server functions, the start dialog
// shows the week before confirming, and a reschedule keeps a same-day id.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { setVerifiedRole } from '../src/core/auth/roles';
import { getClient, setDbClient, resetSupabaseClient } from '../src/core/api/supabase';
import { GuildWriteError } from '../src/core/api/guild-rpc';
import { EventsService, sessionWriteMessage } from '../src/modules/events/events.service';
import { rescheduledSessionId } from '../src/core/config/events';
import { pickEventStart, startWeekLabel } from '../src/core/dom/ui';

function useDb(answer) {
  const calls = [];
  setDbClient({
    calls,
    rpc: vi.fn(async (name, args) => {
      calls.push({ name, args });
      return answer;
    }),
  });
}

beforeEach(() => {
  localStorage.setItem('gm_current_guild', 'ALPHA');
  setVerifiedRole('super_admin', 't_super');
});
afterEach(() => {
  localStorage.clear();
  resetSupabaseClient();
  document.body.innerHTML = '';
});

describe('starting and ending a session', () => {
  it('starts through gm_start_event_session with the picked start, and returns the server id and week', async () => {
    useDb({ data: { ok: true, session_id: 'DTR-20261101-1', week_start: '2026-10-26' }, error: null });
    const res = await EventsService.startSession('Defend Trade Route', null, '2026-11-01T23:30:00.000Z');
    expect(getClient().calls).toEqual([
      {
        name: 'gm_start_event_session',
        args: {
          p_guild: 'ALPHA',
          p_event_name: 'Defend Trade Route',
          p_stage: null,
          p_start_at: '2026-11-01T23:30:00.000Z',
        },
      },
    ]);
    expect(res.week_start).toBe('2026-10-26');
  });

  it('ends through gm_end_event_session with the session the tab shows', async () => {
    useDb({ data: { ok: true, session_id: 'ARA-20261103-1' }, error: null });
    await EventsService.endSession('ARMS RACE STAGE A', 'ARA-20261103-1');
    expect(getClient().calls[0]).toEqual({
      name: 'gm_end_event_session',
      args: { p_guild: 'ALPHA', p_event_name: 'ARMS RACE STAGE A', p_session_id: 'ARA-20261103-1' },
    });
  });

  it('turns a refusal into the message the officer can act on', async () => {
    useDb({ data: { ok: false, error: 'stale_session' }, error: null });
    const err = await EventsService.endSession('GvG', 'GVG-2026-W44').catch((e) => e);
    expect(err).toBeInstanceOf(GuildWriteError);
    expect(sessionWriteMessage(err)).toMatch(/another tab/);
    expect(sessionWriteMessage(new GuildWriteError('start_required'))).toMatch(/start date/);
    expect(sessionWriteMessage(new GuildWriteError('session_exists'))).toMatch(/already uses that date/);
    expect(sessionWriteMessage(new Error('boom'))).toMatch(/boom/);
  });

  it('no view writes event_status directly any more', () => {
    for (const f of [
      'src/modules/events/views/EventsView.ts',
      'src/modules/armsrace/views/ArmsRaceView.ts',
      'src/modules/shadowfront/views/ShadowfrontView.ts',
    ]) {
      const src = fs.readFileSync(path.resolve(__dirname, '..', f), 'utf-8');
      expect(src, f).toContain('EventsService.startSession(');
      expect(src, f).toContain('EventsService.endSession(');
      expect(src, f).not.toMatch(/upsertEventStatus|upsertStageStatus|upsertActiveSquadStatus/);
    }
  });
});

describe('the week a start counts in', () => {
  it('a Sunday 23:30 UTC belongs to the week that began the Monday before', () => {
    expect(startWeekLabel('2026-11-01T23:30:00Z')).toBe('W44 (26/10 → 01/11/2026)');
    expect(startWeekLabel('2026-11-02T00:00:00Z')).toBe('W45 (02/11 → 08/11/2026)');
  });

  it('crosses a year the ISO way', () => {
    expect(startWeekLabel('2027-01-01T12:00:00Z')).toBe('W53 (28/12 → 03/01/2027)');
  });

  it('the start dialog shows the week live, before the officer confirms', () => {
    const cb = vi.fn();
    pickEventStart({ eventLabel: 'GvG', defaultVal: '2026-11-01T23:30:00Z' }, cb);
    const hint = document.getElementById('evt-start-week');
    expect(hint.textContent).toBe('Counts in week W44 (26/10 → 01/11/2026)');

    const date = document.getElementById('evt-start-date');
    date.value = '2026-11-04';
    date.dispatchEvent(new Event('input'));
    expect(hint.textContent).toBe('Counts in week W45 (02/11 → 08/11/2026)');
  });
});

describe('rescheduling keeps a same-day session its id', () => {
  it('a move within the day keeps the id, even for the second session of the day', () => {
    expect(rescheduledSessionId('Defend Trade Route', 'DTR-20261103-2', '2026-11-03T21:00:00Z')).toBe('DTR-20261103-2');
  });

  it("a move to another day takes that day's first id", () => {
    expect(rescheduledSessionId('Defend Trade Route', 'DTR-20261103-2', '2026-11-02T21:00:00Z')).toBe('DTR-20261102-1');
  });

  it('SvS/GvG keep the id within the week and change it across weeks', () => {
    expect(rescheduledSessionId('SvS', 'SVS-2026-W45', '2026-11-05T19:00:00Z')).toBe('SVS-2026-W45');
    expect(rescheduledSessionId('SvS', 'SVS-2026-W45', '2026-11-01T19:00:00Z')).toBe('SVS-2026-W44');
  });
});
