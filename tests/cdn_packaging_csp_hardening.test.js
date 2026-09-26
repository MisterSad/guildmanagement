import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const rootDir = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const vercelJson = fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const mainTs = fs.readFileSync(path.join(rootDir, 'src/main.ts'), 'utf8');

describe('TICKET-08 [SEC-04]: CDN Packaging & CSP Hardening', () => {
  it('verifies that index.html contains zero external CDN references', () => {
    expect(indexHtml).not.toContain('cdn.jsdelivr.net');
    expect(indexHtml).not.toContain('unpkg.com');
  });

  it('verifies that vercel.json Content-Security-Policy excludes CDN domains', () => {
    const config = JSON.parse(vercelJson);
    const headers = config.headers?.[0]?.headers || [];
    const cspHeader = headers.find((h) => h.key === 'Content-Security-Policy');

    expect(cspHeader).toBeDefined();
    const csp = cspHeader.value;

    expect(csp).not.toContain('cdn.jsdelivr.net');
    expect(csp).not.toContain('unpkg.com');

    // Retains required services -- pinned to the exact project, never a wildcard.
    // AUDIT-2026-09-26 [M12]: `https://*.supabase.co` used to be asserted here,
    // which locked the weakness in. Any Supabase project can serve arbitrary JS
    // from a public Storage bucket, so a wildcard in script-src trusts every
    // Supabase project on the internet.
    expect(csp).toContain('https://vgweufzwmfwplusskmuf.supabase.co');
    expect(csp).not.toContain('*.supabase.co');
    expect(csp).toContain('https://discord.com');
    expect(csp).toContain('https://*.ingest.sentry.io');
  });

  it('verifies package.json dependencies include local packages', () => {
    expect(packageJson.dependencies['@phosphor-icons/web']).toBeDefined();
    expect(packageJson.dependencies['@supabase/supabase-js']).toBeDefined();
  });

  it('verifies that src/main.ts imports Phosphor icon styles and bridges window.supabase', () => {
    expect(mainTs).toContain("import '@phosphor-icons/web/regular';");
    // The duotone family was dropped: 231 KB of CSS and a 164 KB woff2 for the
    // 56 icons that used it, all of which exist in the regular set.
    expect(mainTs).not.toContain("@phosphor-icons/web/duotone");
    expect(mainTs).toContain('wAny.supabase = wAny.supabase || { createClient };');
  });
});
