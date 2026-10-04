// The migration directory matches production's history (audit DB-02, INF-02,
// REC-02). Production is the history of record: every version it recorded has
// its file, under that exact name, and every file is either recorded or newer
// than the snapshot (written, not yet applied). See supabase/migrations/README.md.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'supabase/migrations');
const snapshot = JSON.parse(
  fs.readFileSync(path.join(root, 'tests/fixtures/migration_history.json'), 'utf-8')
).migrations;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.slice(0, -4))
  .sort();

// Production sometimes stored the old file name as the migration name
// ("20260926180000_drop_payments"); the file is named after the version.
const expectedName = (m) => `${m.version}_${m.name.replace(/^\d{14}_/, '')}`;

describe('supabase/migrations matches the production history', () => {
  it('has a file for every migration production recorded, under its recorded version', () => {
    const missing = snapshot.map(expectedName).filter((n) => !files.includes(n));
    expect(missing).toEqual([]);
  });

  it('has no file that production neither recorded nor could still be waiting to apply', () => {
    const recorded = new Set(snapshot.map(expectedName));
    const latest = snapshot
      .map((m) => m.version)
      .sort()
      .at(-1);
    const unexplained = files.filter((f) => !recorded.has(f) && f.slice(0, 14) <= latest);
    expect(unexplained).toEqual([]);
  });

  it('names every file with a real timestamp', () => {
    for (const f of files) {
      const m = f.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9_]+$/);
      expect(m, f).not.toBeNull();
      const [, , mo, d, h, mi, s] = m.map(Number);
      expect(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 59, f).toBe(true);
    }
  });

  it('keeps the snapshot ordered and free of duplicates', () => {
    const versions = snapshot.map((m) => m.version);
    expect([...versions].sort()).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('tells the next person never to db push', () => {
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf-8');
    expect(readme).toContain('Never use `supabase db push`');
    expect(readme).toContain('apply_migration');
  });
});
