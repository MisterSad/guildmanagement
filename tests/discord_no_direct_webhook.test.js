// Regression guard for audit finding ARC-04 (2026-10-03): when the
// discord-webhook-proxy said no -- including its 429 rate limit -- the browser
// POSTed straight to the Discord webhook. That bypassed the proxy's
// server-side webhook resolution, its guild scoping and its rate limit, and
// broke AGENTS.md rule 5.
//
// Two layers now keep it shut: no front-end code calls Discord, and the CSP
// would block it if some did.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|js)$/.test(e.name) ? [p] : [];
  });
}

describe('the browser never posts to Discord', () => {
  const files = walk(path.join(root, 'src'));

  it('every fetch() in src/ targets Supabase or the app itself', () => {
    const allowed = [/^fetch\(SUPABASE_URL \+/, /^fetch\('\/version\.json'/];
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      for (const m of src.matchAll(/\bfetch\([^,)]*/g)) {
        if (!allowed.some((re) => re.test(m[0]))) offenders.push(`${path.relative(root, f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no front-end code names a Discord webhook endpoint', () => {
    for (const f of files) {
      expect(fs.readFileSync(f, 'utf-8'), path.relative(root, f)).not.toMatch(/discord(app)?\.com\/api\/webhooks/);
    }
  });

  it('the dead roster-share helper, which prompted for a webhook URL and saved it from the browser, is gone', () => {
    for (const f of files) {
      expect(fs.readFileSync(f, 'utf-8'), path.relative(root, f)).not.toContain('shareMatchupRosterToDiscord');
    }
  });

  it('sendDiscordWebhookDetailed fails closed when the proxy cannot be reached', () => {
    const src = read('src/core/integrations/discord.ts');
    expect(src).toContain("return { ok: false, error: 'proxy_unavailable' };");
  });

  it('the CSP gives the browser no route to discord.com', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const csp = vercel.headers.flatMap((h) => h.headers).find((h) => h.key === 'Content-Security-Policy').value;
    const connectSrc = csp.slice(csp.indexOf('connect-src'), csp.indexOf(';', csp.indexOf('connect-src')));
    expect(connectSrc).not.toMatch(/discord/);
  });
});
