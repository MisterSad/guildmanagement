// Phase 8 — GDPR (finding H4).
//
// The audit found zero occurrences of `gdpr`, `consent`, `privacy`, `retention`
// or `erasure` anywhere in `src/`. But the worse problem was not the absence of a
// privacy policy: it was that `terms.html`, a legally binding published document,
// made two specific FACTUAL claims that the database contradicted.
//
//   - "Zero Personally Identifiable Information ... Stored data is limited to
//     publicly visible in-game pseudonyms, UTC timezone offsets, aggregate game
//     statistical values, and isolated synthetic authentication tokens."
//     The live column catalogue also holds sign-in IP addresses, Discord user
//     ids and usernames across six tables, Discord handles on guild requests,
//     in-game player UIDs, password hashes and reversibly-encrypted passwords,
//     and free-text ticket descriptions. An online identifier is personal data
//     under Art. 4(1), and so is an IP address.
//
//   - "when a guild administrator or user initiates account termination, all
//     corresponding foreign-key records, participation histories, and assigned
//     rosters are permanently purged via automated database cascades
//     (ON DELETE CASCADE)."
//     Only five auth-adjacent tables cascaded from `accounts`; the two wiki
//     tables were NO ACTION and would have BLOCKED the delete outright. And
//     participation and roster records have no foreign key to `accounts` at all
//     -- they key on (guild, pseudo) -- so deleting an account purged none of
//     them. There was also no account-termination flow to begin with.
//
// A false statement in a published legal document is worse than a missing one,
// so what this file pins is not prose but the correspondence between what the
// pages CLAIM and what the code and configuration actually DO.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(rootDir, p));
const stripComments = (s) =>
  s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const privacy = read('privacy.html');
const privacyText = stripComments(privacy);
const terms = stripComments(read('terms.html'));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

const migrations = walk('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .map((f) => read(f))
  .join('\n');

describe('the privacy policy exists and is reachable', () => {
  it('ships as a page, styled by the shared legal stylesheet', () => {
    expect(exists('privacy.html')).toBe(true);
    expect(privacy).toContain('legal.css');
    // Not a Vite entry point: see the header of legal.css for why.
    expect(privacy).not.toContain('/src/main.ts');
  });

  it('shares one stylesheet with the terms page instead of duplicating it', () => {
    expect(exists('legal.css')).toBe(true);
    expect(read('terms.html')).toContain('legal.css');
    // Neither page may drift back to an inline block, which is how 270 lines of
    // CSS came to exist in one page in the first place.
    for (const page of ['terms.html', 'privacy.html']) {
      expect(read(page), `${page} must not inline its styles`).not.toMatch(/^\s*<style>\s*$/m);
    }
  });

  it('is copied into dist by the build, like the terms page', () => {
    // build.js copies root files by EXTENSION and excludes the app's own CSS.
    // `legal.css` must NOT be in that exclusion list or the pages ship unstyled.
    const build = read('scripts/build.js');
    expect(build).toMatch(/'\.html'/);
    expect(build).toMatch(/'\.css'/);
    const excluded = build.slice(build.indexOf('EXCLUDED_FILES'), build.indexOf('EXCLUDED_FILES') + 500);
    expect(excluded, 'legal.css must not be excluded from dist').not.toContain("'legal.css'");
  });

  it('is linked from the login footer, the app shell and the terms page', () => {
    const index = read('index.html');
    expect((index.match(/privacy\.html/g) || []).length, 'both index.html footers').toBeGreaterThanOrEqual(2);
    expect((read('src/modules/shell/views/ShellView.ts').match(/privacy\.html/g) || []).length)
      .toBeGreaterThanOrEqual(2);
    expect(read('terms.html')).toContain('privacy.html');
    // The label goes through i18n like every other footer link.
    expect(read('src/core/i18n/i18n.dictionary.ts')).toContain('footer_privacy');
  });
});

describe('the terms page no longer states what the database contradicts', () => {
  it('has withdrawn the "Zero PII" claim', () => {
    expect(terms).not.toMatch(/Zero Personally Identifiable Information \(Zero PII\)/);
    expect(terms).not.toMatch(/Stored data is limited to publicly visible in-game pseudonyms/);
  });

  it('no longer attributes erasure to ON DELETE CASCADE', () => {
    // The withdrawal is allowed to NAME the old claim while correcting it, so
    // this asserts on the claim's grammar rather than the words in isolation.
    expect(terms).not.toMatch(/are permanently purged via automated database cascades/);
  });

  it('acknowledges that personal data is processed, and points at the policy', () => {
    expect(terms).toMatch(/does<\/strong> process personal data/);
    expect(terms).toMatch(/Article 4\(1\) GDPR/);
    expect(terms).toContain('privacy.html');
  });
});

describe('every host the browser is allowed to reach is disclosed as a processor', () => {
  // The enforceable version of "keep the processor list current": the CSP
  // `connect-src` in vercel.json is the authoritative list of third parties the
  // page can talk to. Add one without disclosing it and this fails.
  const csp = JSON.parse(read('vercel.json')).headers
    .flatMap((h) => h.headers)
    .find((h) => h.key === 'Content-Security-Policy').value;
  const connectSrc = csp.slice(csp.indexOf('connect-src'), csp.indexOf(';', csp.indexOf('connect-src')));

  // Which disclosed name covers which host. A host absent from this map is an
  // undisclosed third party, and the test says so by name.
  const DISCLOSED = [
    [/supabase\.co/, 'Supabase'],
    [/discord\.com/, 'Discord'],
    [/sentry\.io/, 'Sentry']
  ];

  it('parses a non-empty connect-src, so the check cannot be vacuous', () => {
    expect(connectSrc).toContain('connect-src');
    expect(connectSrc.split(/\s+/).length).toBeGreaterThan(3);
  });

  it('names a processor for every external host in connect-src', () => {
    const hosts = connectSrc
      .split(/\s+/)
      .filter((t) => /^(https?|wss?):\/\//.test(t))
      .filter((t) => !t.includes("'self'"));
    expect(hosts.length).toBeGreaterThan(0);

    const undisclosed = [];
    for (const host of hosts) {
      const match = DISCLOSED.find(([re]) => re.test(host));
      if (!match) { undisclosed.push(`${host} (no entry in DISCLOSED)`); continue; }
      if (!privacyText.includes(match[1])) undisclosed.push(`${host} -> "${match[1]}" not in privacy.html`);
    }
    expect(undisclosed, `undisclosed third parties:\n${undisclosed.join('\n')}`).toEqual([]);
  });

  it('also discloses the processors called server-side, which no CSP can reveal', () => {
    // Gemini and Render are never contacted by the browser, so connect-src says
    // nothing about them. They are disclosed because the code calls them.
    expect(privacyText).toMatch(/Gemini/);
    expect(privacyText).toMatch(/Render/);
    expect(privacyText).toMatch(/Vercel/);
  });

  it('discloses Sentry, which IS live in production even though a local build has no DSN', () => {
    // SENTRY_DSN falls back to '' and initSentry() returns false without one, so
    // a local `npm run build` contains no Sentry host and it looks inert. The
    // DEPLOYED bundle carries an `ingest.de.sentry.io` DSN injected at build
    // time, so it is a real processor. Checking the local build would have
    // concluded the opposite.
    expect(privacyText).toMatch(/Sentry/);
    expect(privacyText).toMatch(/European/);
  });
});

describe('no consent banner is required, and the reason is verifiable', () => {
  it('sets no cookies anywhere in src/', () => {
    const offenders = walk('src')
      .filter((f) => f.endsWith('.ts') && /document\s*\.\s*cookie/.test(stripComments(read(f))));
    expect(offenders).toEqual([]);
  });

  it('embeds no analytics, tag manager or tracking pixel', () => {
    const banned = /googletagmanager|google-analytics|gtag\(|connect\.facebook\.net|hotjar|plausible\.io|posthog|mixpanel|segment\.com|clarity\.ms/;
    const offenders = [...walk('src'), 'index.html', 'terms.html', 'privacy.html']
      .filter((f) => /\.(ts|html)$/.test(f) && banned.test(stripComments(read(f))));
    expect(offenders, `tracker found in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('says so on the page, with the exemption it relies on', () => {
    expect(privacyText).toMatch(/no cookies/i);
    expect(privacyText).toMatch(/Article 5\(3\)/);
  });
});

describe('the retention periods on the page are the ones the database enforces', () => {
  it('has a migration that creates the retention job and schedules it', () => {
    expect(migrations).toContain('gm_apply_data_retention');
    expect(migrations).toMatch(/cron\.schedule\(\s*'daily-data-retention'/);
  });

  it('enforces each period the page publishes', () => {
    // Page says 12 months for the audit trail and the pseudonym history, 90 days
    // for a closed request's Discord handle, 24 hours for IP addresses.
    expect(privacyText).toMatch(/Administrative audit log — 12 months/);
    expect(privacyText).toMatch(/Pseudonym-change history — 12 months/);
    expect(privacyText).toMatch(/24 hours/);

    expect(migrations).toMatch(/c_audit_log_months\s+constant integer :=\s*12/);
    expect(migrations).toMatch(/c_name_history_months\s+constant integer :=\s*12/);
    expect(migrations).toMatch(/c_closed_request_days\s+constant integer :=\s*90/);
    expect(migrations).toMatch(/login_throttle WHERE window_start < now\(\) - interval '24 hours'/);
  });

  it('closes the OCR cache gap rather than leaving a function nobody calls', () => {
    // gm_cleanup_expired_ocr_cache() existed and was revoked from anon, but no
    // cron ever invoked it, so expired transcribed player names accumulated.
    expect(migrations).toMatch(/DELETE FROM public\.ocr_cache WHERE expires_at <= now\(\)/);
  });

  it('refuses to apply a window that would delete a backlog on its first run', () => {
    // A retention mechanism going live by destroying data nobody looked at is the
    // failure mode worth preventing, so the migration asserts it deletes nothing.
    expect(migrations).toMatch(/Retention windows would delete existing rows on first run/);
  });
});

describe('erasure matches what the policy promises', () => {
  it('exists as an authorised RPC for a player and for an account', () => {
    expect(migrations).toContain('gm_erase_player');
    expect(migrations).toContain('gm_erase_account');
    // Reuses the tenant write check rather than inventing a rule for this path.
    expect(migrations).toMatch(/NOT public\.check_user_guild_write_access\(p_guild\)/);
    // Account erasure is stricter than peer management deliberately.
    expect(migrations).toMatch(/gm_erase_account: super_admin only/);
  });

  it('anonymises by renaming the roster row, which the cascade propagates', () => {
    // The correction that testing forced: deleting the roster row cascades the
    // seven (guild, pseudo) children away, so a delete-then-anonymise ordering
    // silently anonymised nothing. The rename is the whole operation.
    expect(migrations).toMatch(/SET pseudo = v_token, uid = NULL, timezone = NULL, timezone_offset = NULL/);
    expect(privacyText).toMatch(/unattributable placeholder/);
  });

  it('unblocks account deletion, which the wiki foreign keys made impossible', () => {
    expect(migrations).toMatch(/migration_wiki_pages_created_by_account_id_fkey[\s\S]{0,200}ON DELETE SET NULL/);
    expect(migrations).toMatch(/a foreign key to accounts still uses NO ACTION/);
  });

  it('discloses the ban-record exception instead of applying it silently', () => {
    expect(privacyText).toMatch(/kept intact/);
    expect(privacyText).toMatch(/Article 17\(3\)/);
    expect(migrations).toMatch(/banned_players/);
  });

  it('logs the erasure without recording what was erased', () => {
    // An audit entry naming the erased pseudonym would defeat the erasure.
    expect(migrations).toMatch(/Player data erased under GDPR Art\. 17/);
    expect(migrations).toMatch(/jsonb_build_object\('token', v_token/);
  });
});

describe('the policy states the things a GDPR notice must state', () => {
  const required = [
    [/André Vieira/, 'the controller'],
    [/fgfwiki@gmail\.com/, 'a contact address'],
    [/Article 6\(1\)\(b\)/, 'contract as a legal basis'],
    [/Article 6\(1\)\(f\)/, 'legitimate interests as a legal basis'],
    [/Standard Contractual Clauses/, 'the transfer mechanism'],
    [/one month/, 'the response deadline'],
    [/CNIL/, 'the supervisory authority'],
    [/Article 33 GDPR/, 'breach notification'],
    [/Article 22 GDPR/, 'the position on automated decision-making'],
    [/not directed at children/, 'the position on children']
  ];
  for (const [re, what] of required) {
    it(`states ${what}`, () => {
      expect(privacyText, `${what} is missing from privacy.html`).toMatch(re);
    });
  }
});
