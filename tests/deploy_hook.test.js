// The pre-push hook deploys Edge Functions on every push to `main`. Two defects
// were found in it while preparing the first release of the audit branch, and
// both would have done damage on that very push.
//
//  1. **It passed `--no-verify-jwt` on every deploy.** That forces
//     `verify_jwt = false` onto every function regardless of what
//     `supabase/config.toml` declares. This is the root cause of finding M1 —
//     `admin-accounts`, the role provisioner, ran publicly while both the config
//     and ARCHITECTURE.md described it as JWT-gated. Seven functions are declared
//     `verify_jwt = true`; the flag would have made all seven public again, with
//     no error and nothing in CI able to see it.
//
//  2. **Its list of functions was hand-maintained, and the installed copy had
//     gone stale.** It still named `gm-create-order`, `gm-order-status` and
//     `gm-stripe-webhook` — deleted in phase 1 — and did not know about
//     `auth-discord`. Deploying a function whose directory is gone fails, and a
//     failure in this hook BLOCKS the push, so a stale list does not degrade
//     gracefully: it stops releases until someone reads the hook.
//
// Neither is visible to `tsc`, to the unit suite, or to CI — CI cannot see the
// platform at all. A test on the hook's source is the only cheap guard.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const hook = fs.readFileSync(path.join(rootDir, 'scripts/hooks/pre-push'), 'utf8');
const stripComments = (s) => s.replace(/^\s*#.*$/gm, '');
const code = stripComments(hook);

describe('the deploy hook does not override verify_jwt', () => {
  it('never passes --no-verify-jwt', () => {
    expect(
      code,
      'the hook forces every function public, overriding config.toml — see finding M1'
    ).not.toContain('--no-verify-jwt');
  });

  it('deploys plainly, so the CLI reads verify_jwt from config.toml', () => {
    const deploys = code.match(/supabase functions deploy [^\n]*/g) || [];
    expect(deploys.length, 'no deploy command found: the check would be vacuous')
      .toBeGreaterThanOrEqual(2);
    for (const d of deploys) {
      expect(d, `deploy command carries a flag that overrides config.toml: ${d}`)
        .not.toMatch(/--(no-)?verify-jwt/);
    }
  });

  it('keeps the reason in the hook itself, where the next editor will look', () => {
    expect(hook).toMatch(/do not add `--no-verify-jwt` back/i);
    expect(hook).toMatch(/M1/);
  });
});

describe('the deploy hook fires for every push that reaches main', () => {
  it('reads git\'s stdin fields in the order git writes them', () => {
    // git sends "<local-ref> <local-sha> <remote-ref> <remote-sha>". Reading
    // sha-first swapped every pair, so the branch guard compared a SHA with
    // "refs/heads/main", never matched, and the hook exited 0 having deployed
    // nothing -- on every push since it was written.
    expect(hook).toContain('while read local_ref local_sha remote_ref remote_sha; do');
    expect(hook).not.toContain('while read local_sha local_ref remote_sha remote_ref; do');
  });

  it('decides on the remote ref, not the local branch name', () => {
    // `git push origin HEAD:main` sends local_ref = "HEAD". Keying the guard
    // off the local name skipped the deploy for it, and for every push made
    // from a worktree branch -- which is how most of this work is pushed.
    expect(hook).toContain('if [[ "$remote_ref" != "refs/heads/${MAIN_BRANCH}" ]]; then');
    expect(hook).not.toContain('if [[ "$local_ref" != "refs/heads/${MAIN_BRANCH}" ]]; then');
  });
});

describe('the deploy hook cannot drift from the functions that exist', () => {
  it('enumerates the function directories instead of hardcoding them', () => {
    expect(code).toMatch(/find "\$\{FUNCTIONS_DIR\}"/);
    // A literal list would reintroduce exactly the stale-entry failure.
    expect(code).not.toMatch(/ALL_FUNCTIONS=\(\s*\n\s+[a-z][a-z-]+\s*\n/);
  });

  it('skips the _shared directory, which is not a function', () => {
    expect(code).toMatch(/\[\[ "\$fn" == _\* \]\] && continue/);
  });

  it('names no function that does not exist', () => {
    // Catches a literal slipping back in, and catches a renamed directory.
    const existing = new Set(
      fs.readdirSync(path.join(rootDir, 'supabase/functions'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
        .map((e) => e.name)
    );
    const named = [...code.matchAll(/^\s{4}([a-z][a-z0-9-]{3,})\s*$/gm)].map((m) => m[1]);
    const ghosts = named.filter((n) => n.includes('-') && !existing.has(n));
    expect(ghosts, `the hook names functions that do not exist: ${ghosts.join(', ')}`).toEqual([]);
  });
});

describe('config.toml stays the single declaration of verify_jwt', () => {
  const toml = fs.readFileSync(path.join(rootDir, 'supabase/config.toml'), 'utf8');

  it('declares verify_jwt for every function directory', () => {
    const dirs = fs
      .readdirSync(path.join(rootDir, 'supabase/functions'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name);

    const missing = dirs.filter((d) => {
      const block = toml.slice(toml.indexOf(`[functions.${d}]`));
      if (!block.startsWith(`[functions.${d}]`)) return true;
      const next = block.indexOf('\n[', 1);
      return !/verify_jwt\s*=\s*(true|false)/.test(next > 0 ? block.slice(0, next) : block);
    });
    expect(missing, `no verify_jwt declared for: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the seven JWT-gated functions gated', () => {
    // These are the ones the blanket flag would have silently opened.
    for (const fn of [
      'admin-accounts', 'member-portal', 'guild-data-export', 'discord-webhook-proxy',
      'ocr-guild-members', 'tickets', 'migration-summary'
    ]) {
      const block = toml.slice(toml.indexOf(`[functions.${fn}]`));
      const next = block.indexOf('\n[', 1);
      const decl = next > 0 ? block.slice(0, next) : block;
      expect(decl, `${fn} must stay verify_jwt = true`).toMatch(/verify_jwt\s*=\s*true/);
    }
  });
});
