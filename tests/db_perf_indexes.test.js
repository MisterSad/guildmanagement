import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('TICKET-16 [PERF-04]: Database Performance & FK Index Optimization', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../supabase/migrations/20260920140000_fk_indexes_and_perf_optimizations.sql'
  );

  it('verifies migration file exists and is non-empty', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const content = fs.readFileSync(migrationPath, 'utf-8');
    expect(content.length).toBeGreaterThan(100);
  });

  it('defines composite FK covering indexes on high-volume tables with IF NOT EXISTS', () => {
    const content = fs.readFileSync(migrationPath, 'utf-8');

    // 1. event_participants(guild, pseudo) (SEV-06)
    expect(content).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_event_participants_guild_pseudo\s+ON\s+public\.event_participants\s*\(\s*guild\s*,\s*pseudo\s*\)/i
    );

    // 2. shadowfront_squads(guild, pseudo) (SEV-06)
    expect(content).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_shadowfront_squads_guild_pseudo\s+ON\s+public\.shadowfront_squads\s*\(\s*guild\s*,\s*pseudo\s*\)/i
    );

    // 3. sanctions(guild, pseudo) (SEV-06)
    expect(content).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_sanctions_guild_pseudo\s+ON\s+public\.sanctions\s*\(\s*guild\s*,\s*pseudo\s*\)/i
    );

    // 4. guild_transfers(source_guild, target_guild, resolved_by) (SEV-06)
    expect(content).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_guild_transfers_fkeys\s+ON\s+public\.guild_transfers\s*\(\s*source_guild\s*,\s*target_guild\s*,\s*resolved_by\s*\)/i
    );
  });

  it('drops redundant index and constraint on event_status with IF EXISTS', () => {
    const content = fs.readFileSync(migrationPath, 'utf-8');

    // ALTER TABLE public.event_status DROP CONSTRAINT IF EXISTS event_status_guild_event_name_key
    expect(content).toMatch(
      /ALTER\s+TABLE\s+public\.event_status\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+event_status_guild_event_name_key/i
    );

    // DROP INDEX IF EXISTS public.event_status_guild_event_name_key
    expect(content).toMatch(/DROP\s+INDEX\s+IF\s+EXISTS\s+public\.event_status_guild_event_name_key/i);
  });

  it('notifies PostgREST to reload schema cache at the end of the migration', () => {
    const content = fs.readFileSync(migrationPath, 'utf-8');
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'));

    const lastStatement = lines[lines.length - 1];
    expect(lastStatement.toLowerCase()).toBe("notify pgrst, 'reload schema';");
  });
});
