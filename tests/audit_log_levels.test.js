// Every literal level written to system_audit_logs must satisfy its CHECK.
//
//   CHECK (level = ANY (ARRAY['DEBUG','INFO','WARN','ERROR','FATAL']))
//
// gm_save_chest_tiers wrote 'info'. The INSERT is the function's LAST statement,
// after all validation, so the 23514 it raised rolled back the tiers too: saving
// chest tiers failed for every guild from 2026-09-15 to 2026-10-03, and
// event_chest_tiers held zero rows. Nothing caught it, because no test executes
// SQL and the error only fires on a successful save.
//
// This reads the LATEST definition of every function (a later migration's
// CREATE OR REPLACE supersedes the earlier one, which may legitimately still
// say 'info'), plus the literal levels the Edge Functions insert directly.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const ALLOWED = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);

/** name -> body of its last CREATE [OR REPLACE] FUNCTION, in migration order. */
function latestFunctionBodies() {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const latest = new Map();
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    let m;
    while ((m = re.exec(sql)) !== null) latest.set(m[1].toLowerCase(), { file: f, body: m[4] });
  }
  return latest;
}

/** The first VALUES literal of each INSERT INTO public.system_audit_logs, when `level` is the first column. */
function literalLevels(body) {
  const out = [];
  const re = /INSERT\s+INTO\s+public\.system_audit_logs\s*\(\s*level\b[\s\S]*?VALUES\s*\(\s*'([^']*)'/gi;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

describe('audit log levels', () => {
  it('the parser sees the functions that write audit lines', () => {
    const writers = [...latestFunctionBodies()].filter(([, v]) => /INSERT\s+INTO\s+public\.system_audit_logs/i.test(v.body));
    // gm_save_chest_tiers, gm_rename_guild, gm_erase_player ... : a vacuous scan proves nothing.
    expect(writers.length).toBeGreaterThanOrEqual(4);
    expect(writers.map(([n]) => n)).toContain('gm_save_chest_tiers');
  });

  it('every literal level in the current SQL functions is upper case', () => {
    const bad = [];
    for (const [name, { file, body }] of latestFunctionBodies()) {
      for (const lvl of literalLevels(body)) {
        if (!ALLOWED.has(lvl)) bad.push(`${name} (${file}): '${lvl}'`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('gm_save_chest_tiers now writes INFO', () => {
    const def = latestFunctionBodies().get('gm_save_chest_tiers');
    expect(literalLevels(def.body)).toEqual(['INFO']);
  });

  it('every literal level an Edge Function inserts directly is upper case', () => {
    const bad = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const src = fs.readFileSync(p, 'utf8');
          const re = /from\(["']system_audit_logs["']\)\s*\.insert\(\{[\s\S]*?level:\s*["']([^"']+)["']/g;
          let m;
          while ((m = re.exec(src)) !== null) {
            if (!ALLOWED.has(m[1])) bad.push(`${path.relative(root, p)}: '${m[1]}'`);
          }
        }
      }
    };
    walk(path.join(root, 'supabase', 'functions'));
    expect(bad).toEqual([]);
  });
});
