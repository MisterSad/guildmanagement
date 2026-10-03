import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { edgeSource } from './helpers/edge-source.js';

const migrationPath = path.resolve(
  __dirname,
  '../supabase/migrations/20260920120000_reschedule_event_reminders_cron.sql'
);
const edgePath = path.resolve(__dirname, '../supabase/functions/event-reminders/index.ts');

describe('TICKET-06 [PERF-01]: Event Reminders Cron Reschedule to 5 Minutes', () => {
  it('validates that the migration file exists and reschedules pg_cron to */5 * * * *', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf8');

    // Unschedule previous job
    expect(sql).toContain("cron.unschedule('fgf-event-reminders')");

    // Reschedule at 5 minutes
    expect(sql).toContain("cron.schedule(");
    expect(sql).toContain("'fgf-event-reminders'");
    expect(sql).toContain("'*/5 * * * *'");
    expect(sql).toContain("'SELECT public.gm_invoke_event_reminders();'");
  });

  it('validates gm_invoke_event_reminders() definition in the new migration', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.gm_invoke_event_reminders()');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain("SET search_path TO ''");
    expect(sql).toContain("SET lock_timeout = '1s'");
    expect(sql).toContain("SET statement_timeout = '3s'");

    // GvG daily tasks window widened to 6 minutes for 5-min cron resilience
    expect(sql).toContain('(1, 0, 1, 6)');
    expect(sql).toContain('(6, 0, 1, 6)');

    // Grants
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.gm_invoke_event_reminders() FROM public, anon, authenticated;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.gm_invoke_event_reminders() TO service_role;');
  });

  it('validates that Edge Function trigger windows are calibrated for 5-minute cron ticks', () => {
    expect(fs.existsSync(edgePath)).toBe(true);
    const code = edgeSource('event-reminders');

    // Standard event windows: 6m for 30m, 5m for 5m, 6m for start
    expect(code).toContain('roundedMins <= 30 && roundedMins >= 25');
    expect(code).toContain('roundedMins <= 5 && roundedMins >= 1');
    expect(code).toContain('roundedMins <= 0 && roundedMins >= -5');

    // GvG daily tasks window: 6m
    expect(code).toContain('diff >= 0 && diff <= 6');
  });

  it('verifies all Edge schedule slots are covered by the SQL VALUES table in the new migration', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    const edge = edgeSource('event-reminders');

    // Extract SQL slots
    const sqlSlots = new Set();
    const sqlRe = /\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/g;
    let m;
    while ((m = sqlRe.exec(sql)) !== null) {
      sqlSlots.add(`${m[1]}-${m[2]}-${m[3]}`);
    }

    // Extract Edge slots
    const edgeSlots = new Set();
    const edgeRe = /\{ day: (\d+), hour: (\d+), minute: (\d+)/g;
    while ((m = edgeRe.exec(edge)) !== null) {
      edgeSlots.add(`${m[1]}-${m[2]}-${m[3]}`);
    }
    // GvG daily tasks Monday-Saturday (1..6) at 00:01
    for (let day = 1; day <= 6; day++) {
      edgeSlots.add(`${day}-0-1`);
    }

    const missing = [...edgeSlots].filter((k) => !sqlSlots.has(k));
    expect(missing).toEqual([]);
  });
});
