// Phase 4 — finding H2: the hardcoded 'ALPHA' tenant fallback.
//
// ADR-003 invariant #1 forbids any specific-tenant branch in frontend or backend
// logic. There were 32 `'ALPHA'` literals in src/, of four different kinds:
//
//   A. ~18 guild RESOLVERS ending in `|| 'ALPHA'`, re-implemented in four
//      independent places, so a failure to resolve the tenant was
//      indistinguishable from "the tenant is ALPHA" -- a real, populated guild.
//   B. 7 row-level coercions `m.guild || 'ALPHA'`, which did not "fall back" at
//      all: they RE-LABELLED rows with no guild into a real tenant.
//   C. a display tag built as `'[' + (g || 'ALPHA') + ']'`.
//   D. one comment, describing a fallback that had already been removed.
//
// RLS contained the damage for a `guild_admin` -- they read an empty set. It did
// not contain it for a `super_admin` or an in-scope `server_admin`, whose rights
// cover ALPHA: an unresolved guild meant reading, and potentially writing,
// another tenant's data with no error anywhere.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getActiveGuild, canWriteGuild } from '../src/core/auth/roles.ts';
import { patchAppState } from '../src/core/state/app-state';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (e.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

beforeEach(() => {
  localStorage.clear();
  patchAppState({ currentGuild: null, currentGuildRestriction: null, guildsData: {} });
});
afterEach(() => {
  localStorage.clear();
  patchAppState({ currentGuild: null, currentGuildRestriction: null, guildsData: {} });
});

describe('H2 — the resolver reports failure instead of inventing a tenant', () => {
  it('returns null when nothing resolves', () => {
    expect(getActiveGuild()).toBe(null);
  });

  it('treats blank and whitespace as unresolved, not as a guild id', () => {
    patchAppState({ currentGuild: '   ' });
    expect(getActiveGuild()).toBe(null);
    patchAppState({ currentGuild: '' });
    localStorage.setItem('gm_current_guild', '  ');
    expect(getActiveGuild()).toBe(null);
  });

  it('keeps the documented precedence: restriction → current → localStorage', () => {
    localStorage.setItem('gm_current_guild', 'STORED');
    expect(getActiveGuild()).toBe('STORED');
    patchAppState({ currentGuild: 'CURRENT' });
    expect(getActiveGuild()).toBe('CURRENT');
    patchAppState({ currentGuildRestriction: 'RESTRICTED' });
    expect(getActiveGuild()).toBe('RESTRICTED');
  });

  it('trims, so a stray space cannot create a second tenant', () => {
    patchAppState({ currentGuild: '  OMEGA  ' });
    expect(getActiveGuild()).toBe('OMEGA');
  });
});

describe("H2 — an unresolved tenant blocks writes, including a super_admin's", () => {
  it('refuses a super_admin when no guild is resolved', () => {
    // This is the load-bearing line of the finding. `canWriteGuild` returns true
    // unconditionally for a super_admin, so without an explicit guard the null
    // guild would reach db-guard and be stamped onto the row -- or, before H2,
    // silently addressed to ALPHA.
    localStorage.setItem('gm_role', 'super_admin');
    expect(getActiveGuild()).toBe(null);
    expect(canWriteGuild()).toBe(false);
  });

  it('still allows a super_admin once a guild IS resolved', () => {
    localStorage.setItem('gm_role', 'super_admin');
    patchAppState({ currentGuild: 'OMEGA' });
    expect(canWriteGuild()).toBe(true);
  });

  it('refuses an explicitly blank guild argument', () => {
    localStorage.setItem('gm_role', 'super_admin');
    patchAppState({ currentGuild: 'OMEGA' });
    // '' is falsy, so it falls through to the resolver rather than being taken
    // as a tenant named empty-string.
    expect(canWriteGuild('')).toBe(true);
    patchAppState({ currentGuild: null });
    expect(canWriteGuild('')).toBe(false);
  });

  it('keeps the guild_admin doctrine that predates this finding', () => {
    // The guild_admin branch always refused to fall back to a default guild.
    // H2 extends that doctrine to every role.
    localStorage.setItem('gm_role', 'guild_admin');
    patchAppState({ currentGuild: 'OMEGA' });
    expect(canWriteGuild()).toBe(false); // no restriction set ⇒ blocked
    patchAppState({ currentGuildRestriction: 'OMEGA' });
    expect(canWriteGuild()).toBe(true);
  });
});

describe('H2 — db-guard turns an unresolved tenant into a visible refusal', () => {
  const guard = read('src/core/api/db-guard.ts');

  it('guards all four write verbs on the resolved guild', () => {
    const src = stripComments(guard);
    const guards = src.match(/if \(!currentG \|\| !canWriteGuild\(currentG\)\) return readOnlyResult\(\);/g) || [];
    expect(guards.length, 'delete, update, insert and upsert must all guard').toBe(4);
  });

  it('surfaces the refusal rather than swallowing it', () => {
    expect(guard).toContain('READ_ONLY_MESSAGE');
    expect(guard).toContain('a write stamped `guild: null`');
  });
});

describe('H2 — no tenant name survives in logic', () => {
  it('has no ALPHA literal anywhere in src/ outside comments', () => {
    const offenders = [];
    for (const f of walk('src')) {
      const code = stripComments(read(f));
      code.split('\n').forEach((line, i) => {
        if (/['"]ALPHA['"]/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `tenant literals left in logic:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no longer coerces a row with no guild into a tenant', () => {
    // guild_members holds 3005 rows and ZERO with a null or blank guild, so
    // these coercions were dead -- except in `accounts`, where the single real
    // super_admin row has guild NULL by design and was being displayed as an
    // ALPHA member.
    for (const f of [
      'src/modules/app/members/members.render.ts',
      'src/modules/app/admin/accounts.render.ts',
      'src/modules/app/admin/guild-requests.controller.ts',
    ]) {
      expect(stripComments(read(f)), f).not.toMatch(/\|\|\s*['"]ALPHA['"]/);
    }
  });

  it('keeps the hardcoded tag table deleted', () => {
    const cfg = read('src/core/config/guild-config.ts');
    expect(stripComments(cfg)).not.toContain('DEFAULT_GUILD_TAGS');
    // And says where the tags actually live, so nobody re-adds the table.
    expect(cfg).toContain('guild_config');
  });
});

describe('H2 — one resolver, not four', () => {
  const duplicated = [
    'src/modules/app/members/members.controller.ts',
    'src/modules/app/members/members.render.ts',
    'src/modules/app/members/banned.controller.ts',
    'src/modules/app/admin/accounts.controller.ts',
  ];

  it('collapses the four independent fallback chains into the canonical one', () => {
    // Each of these re-implemented `restriction → current → localStorage →
    // ALPHA` locally, so any one of them could disagree with the others.
    for (const f of duplicated) {
      const code = stripComments(read(f));
      expect(code, `${f} must not re-read gm_current_guild itself`).not.toContain(
        "localStorage.getItem('gm_current_guild')"
      );
      expect(read(f), `${f} must use the canonical resolver`).toContain("from '../../../core/auth/roles'");
    }
  });

  it('stops probing the window bridge for the resolver in every view', () => {
    for (const f of walk('src/modules')) {
      const code = stripComments(read(f));
      expect(code, `${f}: the bridge probe must not reintroduce a tenant default`).not.toMatch(
        /getActiveGuild === 'function' \? [^:]+ : ['"]ALPHA['"]/
      );
    }
  });
});

describe("H2 — the user is told, rather than shown someone else's guild", () => {
  it('has a message for it', () => {
    const dict = read('src/core/i18n/i18n.dictionary.ts');
    expect(dict).toContain('guild_unresolved');
  });

  it('renders a badge that cannot be mistaken for a guild name', () => {
    expect(read('src/modules/shell/views/ShellView.ts')).toContain('gm-sidebar-guild-badge--unresolved');
    expect(read('shell.css')).toContain('.gm-sidebar-guild-badge--unresolved');
  });

  it('refuses the writes that would otherwise land in the wrong tenant', () => {
    // Each of these is a write path that used to accept an unresolved tenant.
    const writePaths = {
      'src/modules/events/chest-settings.ts': 2,
      'src/modules/events/views/EventsView.ts': 3,
      'src/modules/history/views/HistoryView.ts': 1,
      'src/modules/armsrace/views/ArmsRaceView.ts': 1,
    };
    for (const [f, min] of Object.entries(writePaths)) {
      const hits = (read(f).match(/guild_unresolved/g) || []).length;
      expect(hits, `${f} must surface the unresolved tenant`).toBeGreaterThanOrEqual(min);
    }
  });
});
