// A `super_admin` may legitimately also hold a guild on their account.
//
// HawkEye is the admin of ALPHA as well as the platform owner, so
// `accounts.guild = 'ALPHA'` was set for him on 2026-09-27 (owner decision).
// That is a data change, but it is only safe because of a CODE invariant:
//
//   **A super_admin is never scoped by their own `accounts.guild`.**
//
// If it ever were, the effect would be quiet and severe: the tenant switcher
// renders only when `isSuperAdmin && !restriction`, so a restriction set from
// the account row would remove the dropdown and pin the platform owner to a
// single guild — with no error, no console message, and nothing failing.
//
// The guard is in the branching: the restriction lookup is keyed on
// `role === 'guild_admin'`, the server lookup on `server_admin`, and everything
// else falls through to a branch that explicitly nulls both. This file pins
// that shape, because "we only read accounts.guild for guild admins" is exactly
// the kind of thing a later refactor simplifies away.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');

const authCtrl = stripComments(read('src/modules/app/auth/auth.controller.ts'));
const authService = stripComments(read('src/modules/app/auth/auth.service.ts'));
const roles = stripComments(read('src/core/auth/roles.ts'));
const shell = stripComments(read('src/modules/shell/views/ShellView.ts'));

describe('a super_admin is never scoped by their own accounts.guild', () => {
  it('never lets an accounts.guild read set a RESTRICTION outside a guild_admin branch', () => {
    // The first version of this test said "every accounts.guild lookup must be
    // gated on guild_admin", and it caught its own author: the fix for the
    // empty Command Center reads accounts.guild for a super_admin on purpose.
    //
    // That read is safe, and the distinction is the point. Setting
    // `currentGuild` is a SELECTION, which is what the tenant dropdown does and
    // what every loader needs. Setting `currentGuildRestriction` is a LIMIT,
    // and it is what would remove the switcher and pin the owner to one guild.
    // So the rule is about the restriction, not about the read.
    // The accounts.guild reads are built in auth.service.ts since M4b; the
    // controller calls them, and the branching that matters is still here.
    expect(authService).toMatch(/fetchAccountGuild\([\s\S]*?from\('accounts'\)\s*\.select\('guild'\)/);
    expect(authService).toMatch(
      /fetchAccountGuildAndServer\([\s\S]*?from\('accounts'\)\s*\.select\('guild, server_number'\)/
    );
    const lookups = [...authCtrl.matchAll(/fetchAccountGuild(?:AndServer)?\(client,[^\n]*/g)];
    expect(lookups.length, 'no account-guild lookup found: the check would be vacuous').toBeGreaterThanOrEqual(2);

    for (const m of lookups) {
      // Look at the 900 characters after the lookup: whatever it feeds.
      const after = authCtrl.slice(m.index, m.index + 900);
      const setsRestriction = /currentGuildRestriction:\s*guild\b/.test(after);
      if (!setsRestriction) continue; // feeds a selection only: fine.

      const before = authCtrl.slice(Math.max(0, m.index - 600), m.index);
      expect(
        /role\s*===\s*'guild_admin'|info\.role\s*===\s*'guild_admin'/.test(before),
        'an accounts.guild read sets currentGuildRestriction outside a guild_admin branch'
      ).toBe(true);
    }
  });

  it('picks a starting tenant without ever restricting the caller to it', () => {
    // The empty-Command-Center fix. It must set the selection and nothing else.
    const fn = authCtrl.slice(authCtrl.indexOf('async function ensureInitialGuildSelection'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body.length, 'ensureInitialGuildSelection not found').toBeGreaterThan(200);
    expect(body).toMatch(/patchAppState\(\{ currentGuild: guild \}\)/);
    expect(body, 'it must not set a restriction: that removes the tenant switcher').not.toMatch(
      /currentGuildRestriction/
    );
    // And it must not invent a tenant when none is visible.
    expect(body).toMatch(/if \(!guild\) return;/);
  });

  it('clears the restriction for every role that is not guild_admin or server_admin', () => {
    // The fall-through branch is what makes super_admin unrestricted, so it
    // must null BOTH restrictions rather than leaving whatever was there.
    expect(authCtrl).toMatch(
      /else\s*\{\s*patchAppState\(\{\s*currentGuildRestriction:\s*null,\s*currentServerRestriction:\s*null\s*\}\)/
    );
  });

  it('refuses to back-fill a restriction for a super_admin', () => {
    // ensureGuildRestriction() is the defensive re-fetch. It must bail before
    // touching accounts when the caller is a super_admin.
    const fn = roles.slice(roles.indexOf('export async function ensureGuildRestriction'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/if\s*\(role\s*===\s*'super_admin'\)\s*return null/);
    // And the bail must come before the database read, not after it.
    expect(body.indexOf("'super_admin'")).toBeLessThan(body.indexOf("from('accounts')"));
  });

  it('renders the tenant switcher on super_admin AND no restriction', () => {
    // This is the surface that would silently disappear. Pinning the condition
    // makes the dependency visible to whoever edits either side of it.
    expect(shell).toMatch(/if\s*\(isSuperAdmin\s*&&\s*!restriction\)/);
  });

  it('does not infer guild_admin from a restriction when the verified role is known', () => {
    // roles.ts infers `guild_admin` from a stored restriction, but only when the
    // stored role is `member`. It must stay behind the verified-role
    // short-circuit, or a stray restriction could demote the platform owner.
    //
    // Scoped to `roleFromStorage`. A whole-file search finds `normalizeRole`'s
    // `if (s === 'guild_admin') return 'guild_admin'` first -- a pure string
    // mapping that has nothing to do with inference -- and compares against the
    // wrong position. The first version of this test did exactly that.
    const start = roles.indexOf('export function roleFromStorage');
    expect(start, 'roleFromStorage not found').toBeGreaterThan(0);
    const body = roles.slice(start, roles.indexOf('\nexport ', start + 10));

    const verifiedFirst = body.indexOf('if (verifiedRole !== null)');
    const inference = body.indexOf('currentGuildRestriction');
    expect(verifiedFirst, 'the verified-role short-circuit is missing').toBeGreaterThan(-1);
    expect(inference, 'the restriction-based inference is missing').toBeGreaterThan(-1);
    expect(verifiedFirst, 'the verified-role short-circuit must come first').toBeLessThan(inference);
    // And the inference is reachable only when the STORED role is `member`.
    expect(body).toMatch(/if\s*\(role\s*===\s*'member'\)/);
  });
});
