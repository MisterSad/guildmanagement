// tests/force_rls_coverage.test.js
// Regression test: Asserts 100% of active public tables have both
// ENABLE ROW LEVEL SECURITY and FORCE ROW LEVEL SECURITY.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('FORCE ROW LEVEL SECURITY coverage', () => {
  const migDir = path.resolve(__dirname, '../supabase/migrations');
  const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();

  const createdTables = new Set();
  const droppedTables = new Set();
  const rlsEnabledTables = new Set();
  const rlsForcedTables = new Set();

  for (const f of migFiles) {
    const content = fs.readFileSync(path.join(migDir, f), 'utf-8');

    // CREATE TABLE
    const cRegex = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?([a-zA-Z0-9_]+)/gi;
    let m;
    while ((m = cRegex.exec(content)) !== null) {
      const name = m[1].toLowerCase();
      if (name !== 'if') createdTables.add(name);
    }

    // DROP TABLE
    const dRegex = /DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+(?:public\.)?([a-zA-Z0-9_]+)/gi;
    while ((m = dRegex.exec(content)) !== null) {
      droppedTables.add(m[1].toLowerCase());
    }

    // ENABLE RLS
    const eRegex = /ALTER\s+TABLE(?:\s+ONLY)?\s+(?:public\.)?([a-zA-Z0-9_]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
    while ((m = eRegex.exec(content)) !== null) {
      rlsEnabledTables.add(m[1].toLowerCase());
    }

    // FORCE RLS
    const fRegex = /ALTER\s+TABLE(?:\s+ONLY)?\s+(?:public\.)?([a-zA-Z0-9_]+)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
    while ((m = fRegex.exec(content)) !== null) {
      rlsForcedTables.add(m[1].toLowerCase());
    }
  }

  // Active tables are created and not dropped
  const activeTables = Array.from(createdTables).filter((t) => !droppedTables.has(t));

  it('contains migration 20260920100000_force_rls_all_tables.sql', () => {
    const targetMig = path.join(migDir, '20260920100000_force_rls_all_tables.sql');
    expect(fs.existsSync(targetMig)).toBe(true);
    const content = fs.readFileSync(targetMig, 'utf-8');
    expect(content).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('ensures all active tables have ENABLE ROW LEVEL SECURITY', () => {
    const missingEnable = activeTables.filter((t) => !rlsEnabledTables.has(t));
    expect(missingEnable).toEqual([]);
  });

  it('ensures all active tables have FORCE ROW LEVEL SECURITY', () => {
    // Check tables explicitly forced or covered by the DO $$ loop in 20260920100000
    const targetMig = fs.readFileSync(path.join(migDir, '20260920100000_force_rls_all_tables.sql'), 'utf-8');
    const missingForce = activeTables.filter((t) => {
      if (rlsForcedTables.has(t)) return false;
      // Check if present in the DO $$ array
      return !targetMig.includes(`'${t}'`);
    });
    expect(missingForce).toEqual([]);
  });
});
