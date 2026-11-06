// Short-term plan, phase 5: Edge Functions deploy from CI, after every check is
// green, through scripts/deploy-edge-functions.sh. The pre-push hook used to do
// it from a laptop before CI had run, so a red build could already be live.
//
// The protections the hook had earned the hard way move with the deploy:
//   - never `--no-verify-jwt` (finding M1: it made admin-accounts public);
//   - functions enumerated from the filesystem, never a hand-kept list (a stale
//     name blocked releases, a missing one never shipped);
//   - fail visibly when the deploy cannot run (ADR-017: silent skips are how
//     the deployed code drifted from the repository).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
// Absence assertions must not be defeated by the comment explaining the absence.
const stripHashComments = (s) => s.replace(/^\s*#.*$/gm, '');

const script = read('scripts/deploy-edge-functions.sh');
const code = stripHashComments(script);
const hook = stripHashComments(read('scripts/hooks/pre-push'));
const ci = read('.github/workflows/ci.yml');

describe('the deploy script', () => {
  it('never passes --no-verify-jwt, so config.toml decides', () => {
    expect(code).not.toContain('--no-verify-jwt');
    const deploys = code.match(/supabase functions deploy [^\n]*/g) || [];
    expect(deploys.length).toBeGreaterThanOrEqual(2);
    for (const d of deploys) {
      expect(d).not.toMatch(/--(no-)?verify-jwt/);
      expect(d).toContain('--project-ref "$SUPABASE_PROJECT_REF"');
    }
    expect(script).toMatch(/do not add `--no-verify-jwt` back/i);
  });

  it('enumerates the function directories and skips _shared', () => {
    expect(code).toContain('find "${FUNCTIONS_DIR}" -mindepth 1 -maxdepth 1 -type d');
    expect(code).toMatch(/\[\[ "\$fn" == _\* \]\] && continue/);
  });

  it('redeploys everything when shared code or config.toml changes', () => {
    expect(code).toContain('"${FUNCTIONS_DIR}/_shared/"*');
    expect(code).toContain('"supabase/config.toml"');
  });

  it('deploys a function when ANY of its files changes, not only index.ts', () => {
    expect(code).toContain('"${FUNCTIONS_DIR}/"*/*');
    expect(code).not.toMatch(/\*\/index\.ts\b/);
  });

  it('fails visibly without its token, and on any failed deploy', () => {
    expect(code).toContain('SUPABASE_ACCESS_TOKEN is not set: nothing was deployed');
    // The token check exits before anything is enumerated or deployed.
    expect(script.indexOf('nothing was deployed')).toBeLessThan(script.indexOf('ALL_FUNCTIONS=()'));
    expect(code).toContain('::error::Deploy failed for:');
  });

  it('never prints the token', () => {
    expect(code).not.toMatch(/echo[^\n]*SUPABASE_ACCESS_TOKEN\}/);
    expect(code).not.toMatch(/echo[^\n]*\$SUPABASE_ACCESS_TOKEN/);
  });
});

describe('the pre-push hook no longer deploys', () => {
  it('runs no deploy command', () => {
    expect(hook).not.toMatch(/functions deploy/);
    expect(hook).not.toMatch(/npx supabase/);
  });

  it('still reads git stdin in the order git writes it, keyed on the remote ref', () => {
    expect(hook).toContain('while read local_ref local_sha remote_ref remote_sha; do');
    expect(hook).toContain('if [[ "$remote_ref" == "refs/heads/main" ]]; then');
  });
});

describe('the CI pipeline', () => {
  it('is read-only by default (SEC-24)', () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it('replays the migrations and compares the schema with production', () => {
    expect(ci).toContain('image: postgres:17');
    expect(ci).toContain('bash scripts/replay-migrations.sh');
    expect(ci).toContain('tests/fixtures/schema_fingerprint.txt');
  });

  it('type-checks the Edge Functions with Deno', () => {
    expect(ci).toContain('deno check --no-config --node-modules-dir=none supabase/functions/*/index.ts');
  });

  it('runs the Edge handlers and the SQL tests, not only their text (QA-01)', () => {
    expect(ci).toContain(
      'deno test --no-config --node-modules-dir=none --allow-env --allow-net --allow-read supabase/functions/'
    );
    expect(ci).toContain('bash scripts/sql-tests.sh');
    const fns = fs
      .readdirSync(path.join(root, 'supabase/functions'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name);
    for (const fn of fns) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, fn).toMatch(/export async function handler\(/);
      expect(src, fn).toContain('serveUnlessTest(handler);');
      expect(src, fn).not.toMatch(/createClient\(/);
    }
  });

  it('deploys only from main, only after every other job, with the token as a secret', () => {
    const job = ci.slice(ci.indexOf('  deploy-edge-functions:'));
    expect(job).toContain('needs: [build-and-test, migrations-replay, deno-check]');
    expect(job).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(job).toContain('SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}');
    expect(job).toContain('bash scripts/deploy-edge-functions.sh');
  });
});

describe('config.toml stays the single declaration of verify_jwt', () => {
  const toml = read('supabase/config.toml');
  const block = (fn) => {
    const b = toml.slice(toml.indexOf(`[functions.${fn}]`));
    const next = b.indexOf('\n[', 1);
    return next > 0 ? b.slice(0, next) : b;
  };

  it('declares verify_jwt for every function directory', () => {
    const dirs = fs
      .readdirSync(path.join(root, 'supabase/functions'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name);
    const missing = dirs.filter(
      (d) => !toml.includes(`[functions.${d}]`) || !/verify_jwt\s*=\s*(true|false)/.test(block(d))
    );
    expect(missing).toEqual([]);
  });

  it('keeps the six JWT-gated functions gated', () => {
    for (const fn of [
      'admin-accounts',
      'member-portal',
      'guild-data-export',
      'discord-webhook-proxy',
      'ocr-guild-members',
      'tickets',
    ]) {
      expect(block(fn), `${fn} must stay verify_jwt = true`).toMatch(/verify_jwt\s*=\s*true/);
    }
  });
});

describe('the deploy script, run', () => {
  // Runs the real script with a stand-in `supabase` that only records what it
  // was asked to deploy. d089916 (M3) changed four functions and _test/, and
  // the deploy job failed trying to deploy `_test` as a function.
  function deployedBetween(base, head) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-deploy-'));
    const log = path.join(bin, 'deployed.log');
    fs.writeFileSync(path.join(bin, 'supabase'), `#!/usr/bin/env bash\necho "$3" >> "${log}"\n`, { mode: 0o755 });
    execFileSync('bash', ['scripts/deploy-edge-functions.sh', base, head], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SUPABASE_ACCESS_TOKEN: 'test',
        SUPABASE_PROJECT_REF: 'test-ref',
      },
      stdio: 'pipe',
    });
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').sort() : [];
  }

  const hasCommit = (sha) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };

  it.runIf(hasCommit('b68ed4b') && hasCommit('d089916'))(
    'deploys the functions a push changed, never a `_` directory',
    () => {
      expect(deployedBetween('b68ed4b', 'd089916')).toEqual([
        'admin-accounts',
        'auth-discord',
        'event-reminders',
        'member-portal',
      ]);
    }
  );
});
