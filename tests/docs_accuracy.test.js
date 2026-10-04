// Phase 9 — the documentation had drifted from the system it describes, in ways
// that actively misled whoever read it next:
//
//   - ARCHITECTURE.md quoted 13 guilds / ~1,540 members / ~33k participations.
//     The live figures were 26 / ~3,005 / ~55,760 — wrong by roughly a factor of
//     two, carried forward unchecked for months.
//   - It asserted in a warning box that `gm-revolut-webhook` did NOT exist and
//     should be kept out of deployment matrices. It existed, was ACTIVE with
//     `verify_jwt = false`, and had no source in this repository.
//   - README described paid subscriptions "from one month to lifetime" and
//     opt-in push notifications. Both features were dead; the price list it
//     documented belonged to the payment provider that had already been removed.
//   - AGENTS.md required a quality gate of "712+ tests" against a suite that had
//     long since passed 1,800.
//
// A document nobody re-checks becomes confidently wrong. What is enforceable
// from a test is pinned here; what is not (the live platform) is a runbook step
// recorded in ADR-017.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const arch = read('ARCHITECTURE.md');
const readme = read('README.md');
const agents = read('AGENTS.md');

describe('the docs do not describe features that were removed', () => {
  const removed = [
    [/plans from one month to lifetime/i, 'paid subscription plans (ADR-015)'],
    [/opt in to push notifications/i, 'Web Push opt-in (ADR-016)'],
    [/Add to Home Screen/i, 'the PWA install prompt (ADR-016)'],
  ];
  for (const [re, what] of removed) {
    it(`README no longer advertises ${what}`, () => {
      expect(readme, `README still advertises ${what}`).not.toMatch(re);
    });
  }

  it('README does not promise a subscription in its description of a guild space', () => {
    // The lede and the multi-guild section both ended "...settings, and
    // subscription" long after the app became free.
    expect(readme).not.toMatch(/settings,? and subscription/i);
  });

  it('ARCHITECTURE no longer lists dropped tables as live inventory', () => {
    // Scoped to the §4.1 inventory BULLETS, not to the whole file: the count
    // note beside them legitimately names the dropped tables while saying they
    // were dropped, and a whole-file search flags that as a failure. The first
    // version of this test did exactly that.
    const start = arch.indexOf('#### 4.1 Database Tables');
    const end = arch.indexOf('#### 4.2', start);
    expect(start, 'the §4.1 inventory is missing').toBeGreaterThan(0);
    const bullets = arch
      .slice(start, end > 0 ? end : start + 6000)
      .split('\n')
      .filter((l) => l.startsWith('- **'))
      .join('\n');
    expect(bullets.length, 'no inventory bullets parsed: the check would be vacuous').toBeGreaterThan(200);

    for (const gone of [
      'player_push_prefs',
      'push_subscriptions',
      'gm_payments',
      'diplomatic_treaties',
      'e2ee_messages',
    ]) {
      // Naming one is fine if the line says it is gone; listing it as present is not.
      const listed = bullets
        .split('\n')
        .filter((l) => l.includes('`' + gone + '`'))
        .filter((l) => !/dropped|removed|Phase [12]/i.test(l));
      expect(listed, `${gone} is still listed as a live table`).toEqual([]);
    }
  });
});

describe('the counts in ARCHITECTURE match the repository', () => {
  it('states the same number of Edge Functions as `supabase/functions/` contains', () => {
    // The directory is the authority for the repo half; ADR-017 covers the
    // platform half, which no test can see.
    const dirs = fs
      .readdirSync(path.join(rootDir, 'supabase/functions'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_')).length;
    const m = arch.match(/Edge Functions \(`supabase\/functions\/`\) — (\d+) live/);
    expect(m, 'the Edge Function count line is missing from ARCHITECTURE.md').toBeTruthy();
    expect(Number(m[1]), `ARCHITECTURE says ${m && m[1]}, the repo has ${dirs}`).toBe(dirs);
  });

  it('every documented function directory actually exists', () => {
    // Catches the other direction: a function renamed or deleted while the
    // diagram still lists it by name.
    const listed = [...arch.matchAll(/├─ `([a-z0-9-]+)`:/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(8);
    const missing = listed.filter((name) => !fs.existsSync(path.join(rootDir, 'supabase/functions', name)));
    expect(missing, `documented but absent: ${missing.join(', ')}`).toEqual([]);
  });

  it('dates its volumetrics instead of stating them as timeless fact', () => {
    // The fix for a number that goes stale is not a better number, it is a
    // date beside it and an instruction to re-measure.
    expect(arch).toMatch(/counted (live |against production )?(on )?2026-\d\d-\d\d/i);
    expect(arch).toMatch(/Re-measure/i);
  });
});

describe('the agent instructions match the project', () => {
  it('does not hardcode a test count that goes stale on the next test', () => {
    // "712+ tests" was the previous version of this mistake. A command is
    // durable; a number is a countdown.
    expect(agents).not.toMatch(/\d{3,}\+? tests/);
    expect(read('.agents/skills/fgf-quality-gate/SKILL.md')).not.toMatch(/\d{3,}\+? (tests|green)/);
  });

  it('names the four roles, not three', () => {
    for (const role of ['super_admin', 'server_admin', 'guild_admin', 'member']) {
      expect(agents).toContain(role);
    }
    expect(read('.agents/skills/fgf-rls-security/SKILL.md')).toContain('server_admin');
  });

  it('requires the e2e suite, which is the only check that sees the real bundle', () => {
    expect(agents).toMatch(/playwright/i);
    expect(read('.agents/skills/fgf-quality-gate/SKILL.md')).toMatch(/playwright/i);
  });

  it('no longer points agents at modules that were deleted', () => {
    const skills = ['fgf-saas-architect', 'fgf-rls-security', 'fgf-quality-gate', 'fgf-memory-keeper']
      .map((n) => read(`.agents/skills/${n}/SKILL.md`))
      .join('\n');
    // store.ts was deleted in phase 3; pointing an agent at it produces a
    // confident edit to a file that does not exist.
    expect(skills).not.toMatch(/Store state in `src\/core\/store\/store\.ts`/);
    expect(skills).not.toMatch(/src\/modules\/push\/PushService/);
  });

  it('does not enumerate the tenants, which is the anti-pattern it warns about', () => {
    // The architect skill listed 13 guild ids by name while telling the reader
    // never to hardcode a tenant. There are 26 now, and the list was stale the
    // day a guild was created.
    const architect = read('.agents/skills/fgf-saas-architect/SKILL.md');
    expect(architect).toMatch(/never enumerate the tenants/i);
    expect((architect.match(/`(ALPHA|OMEGA|BABE|IMK|YARR|CLAW|SEN|TWILIGHT)`/g) || []).length).toBe(0);
  });
});

describe('the ADRs record the decisions the phases made', () => {
  const index = read('docs/adr/README.md');
  const required = [
    ['ADR-015', /permanently[- ]free/i, 'the app is free'],
    ['ADR-016', /pwa-and-web-push-retirement/, 'the PWA and push are gone'],
    ['ADR-017', /deployed-edge-functions-must-be-versioned/, 'every deployed function has source here'],
    ['ADR-018', /gdpr-data-inventory-retention-and-erasure/, 'GDPR'],
  ];
  for (const [id, file, what] of required) {
    it(`${id} exists, is indexed, and covers ${what}`, () => {
      expect(index, `${id} missing from the ADR index`).toContain(id);
      const m = index.match(new RegExp(`\\[${id}\\]\\(\\./([^)]+)\\)`));
      expect(m, `${id} has no link in the index`).toBeTruthy();
      expect(m[1]).toMatch(file);
      expect(fs.existsSync(path.join(rootDir, 'docs/adr', m[1])), `${m && m[1]} does not exist`).toBe(true);
    });
  }

  it('records that ADR-012 described a cache that was not deployed', () => {
    // The ADR was accepted, tested and consuming Gemini quota while the code was
    // absent from the deployed binary. An ADR that silently becomes fiction is
    // worse than no ADR.
    const adr = read('docs/adr/ADR-012-sha256-ocr-deduplication-cache.md');
    expect(adr).toMatch(/did not exist in production/i);
    expect(adr).toMatch(/finding H1/);
  });

  it('keeps ADR-001 marked as superseded rather than reading as current', () => {
    expect(read('docs/adr/ADR-001-three-role-zero-trust-access-model.md')).toMatch(/Superseded by ADR-006/);
  });
});

describe('the unused agent definitions are gone', () => {
  it('has no .kilo/ directory', () => {
    // 11 agent definitions nothing read, describing a three-role model and a
    // paid product.
    expect(fs.existsSync(path.join(rootDir, '.kilo'))).toBe(false);
  });
});
