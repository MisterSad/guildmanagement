/**
 * tests/event_reminders_trigger_fix.test.js
 *
 * P1 audit (RC4/RC5/RC6/RC7) — reminders that never fire:
 *   RC4 — gm_invoke_event_reminders() wrapper must evaluate its weekly slot
 *         table in UTC (timezone('utc', now())), never in the session timezone,
 *         and keep the Vault secret guard with an explicit warning.
 *   RC5 — standard-event matching is canonical (trim + case-insensitive).
 *   RC6 — SvS session detection is aligned on the current UTC calendar week
 *         (event_status start_at in-week, or a war_sessions SvS row of the
 *         week) instead of the fragile 7.5-day sliding window.
 *   RC7 — portal_5 / portal_open are gated by notify_svs_pvp only, detached
 *         from notify_svs_won_prep.
 */

import { describe, it, expect } from 'vitest';
import { edgeSource } from './helpers/edge-source.js';
import fs from 'fs';
import path from 'path';
import {
  normalizeEventName,
  isStandardEventName,
  isSvsEventName,
  eventPrefixForName,
  utcWeekStartMs,
  isTimestampInCurrentUtcWeek,
  isSvsActiveForWeek,
} from '../supabase/functions/_shared/reminder-rules';

const migrationPath = path.resolve(
  __dirname,
  '../supabase/migrations/20260914110000_fix_event_reminders_trigger_and_tz.sql'
);
const migrationContent = fs.readFileSync(migrationPath, 'utf-8');
const edgeContent = edgeSource('event-reminders');

/* ---------------------------------------------------------------------------
 * RC4 — guarded cron wrapper is timezone-independent
 * ------------------------------------------------------------------------- */

describe('RC4: gm_invoke_event_reminders() is UTC-pinned and keeps the Vault guard', () => {
  it("evaluates every slot extract against timezone('utc', now())", () => {
    expect(migrationContent).toContain("extract(dow FROM timezone('utc', now()))");
    expect(migrationContent).toContain("extract(hour FROM timezone('utc', now()))");
    expect(migrationContent).toContain("extract(minute FROM timezone('utc', now()))");
  });

  it('no longer extracts directly FROM now() (session-timezone dependent)', () => {
    expect(migrationContent).not.toContain('extract(dow FROM now())');
    expect(migrationContent).not.toContain('extract(hour FROM now())');
    expect(migrationContent).not.toContain('extract(minute FROM now())');
  });

  it('keeps the active-event due-window as a pure TIMESTAMPTZ comparison', () => {
    expect(migrationContent).toContain(
      "start_at BETWEEN now() - interval '5 minutes' AND now() + interval '35 minutes'"
    );
  });

  it('keeps the Vault secret guard and emits an explicit warning when missing', () => {
    expect(migrationContent).toContain('event_reminders_cron_secret not found in vault.decrypted_secrets');
    expect(migrationContent).toContain('RAISE WARNING');
  });

  it('redefines public.gm_invoke_event_reminders with SECURITY DEFINER and service_role EXECUTE only', () => {
    expect(migrationContent).toContain('CREATE OR REPLACE FUNCTION public.gm_invoke_event_reminders()');
    expect(migrationContent).toContain('SECURITY DEFINER');
    expect(migrationContent).toContain('GRANT EXECUTE ON FUNCTION public.gm_invoke_event_reminders() TO service_role');
  });
});

/* ---------------------------------------------------------------------------
 * RC4 — the Edge schedules and the SQL slot table stay in sync (SSOT drift guard)
 * ------------------------------------------------------------------------- */

describe('RC4: Edge weekly schedules are fully covered by the SQL slot table', () => {
  function sqlSlots() {
    const slots = new Set();
    const re = /\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/g;
    let m;
    while ((m = re.exec(migrationContent)) !== null) {
      slots.add(`${m[1]}-${m[2]}-${m[3]}`);
    }
    return slots;
  }

  function edgeSlots() {
    const slots = new Set();
    // GVG_SCHEDULE, SVS_SCHEDULE, CALAMITY_SCHEDULE literal entries.
    const re = /\{ day: (\d+), hour: (\d+), minute: (\d+)/g;
    let m;
    while ((m = re.exec(edgeContent)) !== null) {
      slots.add(`${m[1]}-${m[2]}-${m[3]}`);
    }
    // Implicit GvG daily tasks window (Monday-Saturday 00:01) handled directly
    // by the Edge function and mirrored as (1..6, 0, 1, 5) in SQL.
    for (let day = 1; day <= 6; day++) slots.add(`${day}-0-1`);
    return slots;
  }

  it('every Edge schedule slot exists in the SQL VALUES table', () => {
    const sql = sqlSlots();
    const edge = edgeSlots();
    const missing = [...edge].filter((k) => !sql.has(k));
    expect(missing).toEqual([]);
  });

  it('the SQL slot table contains no slot the Edge function cannot emit', () => {
    const sql = sqlSlots();
    const edge = edgeSlots();
    const extra = [...sql].filter((k) => !edge.has(k));
    expect(extra).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * RC5 — canonical event-name matching
 * ------------------------------------------------------------------------- */

describe('RC5: canonical standard-event name matching', () => {
  it('matches standard events regardless of case and surrounding whitespace', () => {
    expect(isStandardEventName('ARMS RACE STAGE A')).toBe(true);
    expect(isStandardEventName('arms race stage a')).toBe(true);
    expect(isStandardEventName('  DEFEND TRADE ROUTE  ')).toBe(true);
    expect(isStandardEventName('Shadowfront Squad 2')).toBe(true);
  });

  it('rejects non-standard event labels', () => {
    expect(isStandardEventName('SvS')).toBe(false);
    expect(isStandardEventName('GvG')).toBe(false);
    expect(isStandardEventName('Calamity Befalls')).toBe(false);
    expect(isStandardEventName(undefined)).toBe(false);
  });

  it('normalizeEventName trims and upper-cases', () => {
    expect(normalizeEventName('  Defend Trade Route ')).toBe('DEFEND TRADE ROUTE');
    expect(normalizeEventName(null)).toBe('');
  });

  it('eventPrefixForName maps canonical names to config prefixes', () => {
    expect(eventPrefixForName('ARMS RACE STAGE B')).toBe('armsrace');
    expect(eventPrefixForName('Defend Trade Route')).toBe('dtr');
    expect(eventPrefixForName('Shadowfront Squad 1')).toBe('shadowfront');
    expect(eventPrefixForName('Calamity Befalls')).toBe('calamity');
    expect(eventPrefixForName('GvG')).toBe('gvg');
    expect(eventPrefixForName('SvS')).toBe('svs');
    expect(eventPrefixForName('Unknown Event')).toBe('');
  });

  it('isSvsEventName matches the SvS session row leniently', () => {
    expect(isSvsEventName('SvS')).toBe(true);
    expect(isSvsEventName(' svs ')).toBe(true);
    expect(isSvsEventName('SvS Week 1')).toBe(true);
    expect(isSvsEventName('GvG')).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * RC6 — SvS session aligned on the current UTC calendar week
 * ------------------------------------------------------------------------- */

describe('RC6: SvS calendar-week session detection', () => {
  // 2026-09-14 is a Monday (UTC).
  const nowMs = Date.UTC(2026, 8, 14, 12, 0, 0);
  const thisWeekFriday = Date.UTC(2026, 8, 18, 14, 0, 0);
  const lastWeek = Date.UTC(2026, 8, 7, 14, 0, 0);
  const nextWeek = Date.UTC(2026, 8, 21, 14, 0, 0);

  it('utcWeekStartMs returns Monday 00:00 UTC for any day of the week', () => {
    expect(utcWeekStartMs(nowMs)).toBe(Date.UTC(2026, 8, 14));
    expect(utcWeekStartMs(Date.UTC(2026, 8, 19, 23, 59, 59))).toBe(Date.UTC(2026, 8, 14));
    expect(utcWeekStartMs(Date.UTC(2026, 8, 20, 0, 0, 0))).toBe(Date.UTC(2026, 8, 14)); // Sunday still same week
    expect(utcWeekStartMs(Date.UTC(2026, 8, 21, 0, 0, 0))).toBe(Date.UTC(2026, 8, 21));
  });

  it('isTimestampInCurrentUtcWeek respects the Monday-Sunday boundary', () => {
    expect(isTimestampInCurrentUtcWeek(nowMs, thisWeekFriday)).toBe(true);
    expect(isTimestampInCurrentUtcWeek(nowMs, Date.UTC(2026, 8, 20))).toBe(true); // Sunday
    expect(isTimestampInCurrentUtcWeek(nowMs, lastWeek)).toBe(false);
    expect(isTimestampInCurrentUtcWeek(nowMs, nextWeek)).toBe(false);
    expect(isTimestampInCurrentUtcWeek(nowMs, null)).toBe(false);
  });

  it('active event_status SvS with start_at in the current week is active', () => {
    expect(
      isSvsActiveForWeek(nowMs, { eventActive: true, eventStartAtMs: thisWeekFriday, warSessionTimestampsMs: [] })
    ).toBe(true);
  });

  it('an active SvS row without start_at remains active (fallback)', () => {
    expect(isSvsActiveForWeek(nowMs, { eventActive: true, eventStartAtMs: null, warSessionTimestampsMs: [] })).toBe(
      true
    );
  });

  it('a stale start_at from a previous week is NOT active (no more 7.5-day window)', () => {
    expect(isSvsActiveForWeek(nowMs, { eventActive: true, eventStartAtMs: lastWeek, warSessionTimestampsMs: [] })).toBe(
      false
    );
    expect(isSvsActiveForWeek(nowMs, { eventActive: true, eventStartAtMs: nextWeek, warSessionTimestampsMs: [] })).toBe(
      false
    );
  });

  it('falls back to a durable war_sessions SvS row of the current week', () => {
    expect(
      isSvsActiveForWeek(nowMs, { eventActive: false, eventStartAtMs: null, warSessionTimestampsMs: [thisWeekFriday] })
    ).toBe(true);
    expect(
      isSvsActiveForWeek(nowMs, { eventActive: false, eventStartAtMs: null, warSessionTimestampsMs: [lastWeek] })
    ).toBe(false);
    expect(isSvsActiveForWeek(nowMs, { eventActive: false, eventStartAtMs: null, warSessionTimestampsMs: [] })).toBe(
      false
    );
  });
});

/* ---------------------------------------------------------------------------
 * RC6/RC7 — Edge function static guards
 * ------------------------------------------------------------------------- */

describe('RC6/RC7: Edge function SvS wiring', () => {
  it('uses the calendar-week helper and the war_sessions fallback, never the 7.5-day window', () => {
    expect(edgeContent).toContain('isSvsActiveForWeek(');
    expect(edgeContent).toContain(".from('war_sessions')");
    expect(edgeContent).not.toContain('const ageDays');
  });

  it('portal battle notifications are detached from notify_svs_won_prep (RC7)', () => {
    expect(edgeContent).not.toContain('!isSvsPvpEnabled || !wonPrep');
    expect(edgeContent).toContain('portal battle notifications are detached from won_prep');
  });

  it('standard-event matching and prefixes are canonical (RC5)', () => {
    expect(edgeContent).toContain('isStandardEventName(event.event_name)');
    expect(edgeContent).toContain('eventPrefixForName(event.event_name)');
    expect(edgeContent).not.toContain("event.event_name === 'ARMS RACE STAGE A'");
  });
});
