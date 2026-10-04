// Medium-term plan, M2 (audit ARC-03): every role decision in an Edge Function
// goes through the predicates of _shared/admin-authz.ts. An inline
// `role === "guild_admin"` is how the functions drifted apart before -- one
// list of admin roles forgot server_admin -- so a new one fails here.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const fnDir = path.resolve(__dirname, '../supabase/functions');
const ROLE_LITERAL_COMPARISON =
  /[=!]==\s*["'](super_admin|server_admin|guild_admin|member)["']|["'](super_admin|server_admin|guild_admin|member)["']\s*[=!]==/;
const ROLE_LIST = /\[\s*["'](super_admin|server_admin|guild_admin)["']\s*,[^\]]*\]\s*\.includes\(/;

function sources() {
  const out = [];
  for (const dir of fs.readdirSync(fnDir)) {
    const full = path.join(fnDir, dir);
    if (!fs.statSync(full).isDirectory() || dir === '_test') continue;
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('.ts') && !f.endsWith('.test.ts')) out.push(path.join(dir, f));
    }
  }
  return out;
}

describe('role decisions go through admin-authz predicates', () => {
  it('no Edge Function source compares a role to a literal outside admin-authz.ts', () => {
    const offenders = [];
    for (const rel of sources()) {
      if (rel === path.join('_shared', 'admin-authz.ts')) continue;
      const lines = fs.readFileSync(path.join(fnDir, rel), 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (ROLE_LITERAL_COMPARISON.test(l) || ROLE_LIST.test(l) || /\bADMIN_ROLES\b/.test(l))
          offenders.push(`${rel}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('admin-authz.ts exports the predicates', () => {
    const src = fs.readFileSync(path.join(fnDir, '_shared/admin-authz.ts'), 'utf8');
    for (const fn of ['isSuperAdmin', 'isServerAdmin', 'isGuildAdmin', 'isMember', 'isAdminRole']) {
      expect(src, fn).toContain(`export function ${fn}(`);
    }
  });
});

describe('the shadow-user helpers exist once (M2)', () => {
  it('emailFor and randomSecret are defined only in _shared/shadow-session.ts', () => {
    const defs = [];
    for (const rel of sources()) {
      const src = fs.readFileSync(path.join(fnDir, rel), 'utf8');
      if (/function\s+(emailFor|randomSecret)\s*\(/.test(src)) defs.push(rel);
    }
    expect(defs).toEqual([path.join('_shared', 'shadow-session.ts')]);
  });
});
