import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('TICKET-17 [SEC-06]: Security Headers & Advanced CSP Audit', () => {
  const vercelJsonPath = path.resolve(__dirname, '../vercel.json');
  const vercelJson = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf-8'));
  const headersList = vercelJson.headers?.[0]?.headers || [];
  const headersMap = new Map(headersList.map((h) => [h.key, h.value]));

  it('verifies that vercel.json contains all 8 OWASP-recommended security headers', () => {
    const requiredHeaders = [
      'Content-Security-Policy',
      'Strict-Transport-Security',
      'X-Frame-Options',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Cross-Origin-Opener-Policy',
      'Cross-Origin-Resource-Policy',
      'Permissions-Policy',
    ];

    for (const header of requiredHeaders) {
      expect(headersMap.has(header), `Missing security header: ${header}`).toBe(true);
    }
  });

  it('enforces strict HSTS with max-age >= 1 year, subdomains and preload', () => {
    const hsts = headersMap.get('Strict-Transport-Security');
    expect(hsts).toBeDefined();
    expect(hsts).toContain('max-age=63072000');
    expect(hsts).toContain('includeSubDomains');
    expect(hsts).toContain('preload');
  });

  it('enforces frame denial and MIME-type sniffing protection', () => {
    expect(headersMap.get('X-Frame-Options')).toBe('DENY');
    expect(headersMap.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('enforces cross-origin isolation policies (COOP, CORP, Referrer-Policy)', () => {
    expect(headersMap.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(headersMap.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect(headersMap.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('restricts browser features via Permissions-Policy', () => {
    const pp = headersMap.get('Permissions-Policy');
    expect(pp).toBeDefined();
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('payment=()');
  });

  it('enforces strict Content-Security-Policy directives', () => {
    const csp = headersMap.get('Content-Security-Policy');
    expect(csp).toBeDefined();

    // Baseline confinement
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");

    // Transport hardening
    expect(csp).toContain('upgrade-insecure-requests');

    // Forbidden third-party CDNs
    expect(csp).not.toContain('unpkg.com');
    expect(csp).not.toContain('cdn.jsdelivr.net');

    // script-src must be exactly 'self': the app loads no external script.
    // AUDIT-2026-09-26 [M12]: a `https://*.supabase.co` wildcard in script-src
    // trusts every Supabase project on the internet, because any project can
    // serve attacker-controlled JS from a public Storage bucket. That turns an
    // otherwise inert HTML injection into script execution.
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toContain('*.supabase.co');

    // Allowed endpoints -- Supabase pinned to this project only.
    expect(csp).toContain('https://vgweufzwmfwplusskmuf.supabase.co');
    expect(csp).toContain('wss://vgweufzwmfwplusskmuf.supabase.co');
    // The browser never talks to Discord: webhooks go through the Edge proxy
    // (audit ARC-04), so connect-src must not let a direct POST through.
    expect(csp).not.toContain('https://discord.com');
    expect(csp).toContain('https://*.ingest.sentry.io');
    expect(csp).toContain('https://*.ingest.de.sentry.io');
  });
});
