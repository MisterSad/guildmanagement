import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isAllowedOrigin, getCorsHeaders, ALLOWED_ORIGINS } from '../supabase/functions/_shared/cors.ts';

describe('Ticket 1.4: CORS Hardening & Vercel Origin Restriction', () => {
  const corsPath = path.resolve(__dirname, '../supabase/functions/_shared/cors.ts');
  const corsContent = fs.readFileSync(corsPath, 'utf-8');

  describe('1. Static Code Analysis on Regex Patterns', () => {
    it('does not contain generic permissive Vercel regex allowing arbitrary projects', () => {
      // The old insecure regex allowed any *.vercel.app
      expect(corsContent).not.toMatch(/\^https:\\\/\\\/\[a-z0-9\]\[a-z0-9-\]\*\\\.vercel\\\.app/);
      expect(corsContent).not.toContain('^https://[a-z0-9][a-z0-9-]*\\.vercel\\.app');
    });

    it('enforces restricted official project Vercel deployment regex', () => {
      expect(corsContent).toContain('VERCEL_OFFICIAL_REGEX');
      expect(corsContent).toMatch(/guildmanagement/);
    });

    it('retains Vary: Origin and Content-Disposition headers', () => {
      expect(corsContent).toContain('"Vary": "Origin"');
      expect(corsContent).toContain('"Access-Control-Expose-Headers": "Content-Disposition"');
    });
  });

  describe('2. isAllowedOrigin - Strict Domain Whitelisting', () => {
    it('accepts canonical production and localhost development origins', () => {
      expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
      expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
      expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
      expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
      expect(isAllowedOrigin('https://guildmanagement.vercel.app')).toBe(true);
    });

    it('accepts legitimate official project preview deployments', () => {
      expect(isAllowedOrigin('https://guildmanagement-preview-123.vercel.app')).toBe(true);
      expect(isAllowedOrigin('https://guildmanagement-git-feature-branch.vercel.app')).toBe(true);
      expect(isAllowedOrigin('https://guildmanagement-mistersads-projects.vercel.app')).toBe(true);
      expect(isAllowedOrigin('https://preview.guildmanagement.vercel.app')).toBe(true);
      expect(isAllowedOrigin('https://fgf-guild-management.vercel.app')).toBe(true);
    });

    it('accepts verified guildmgmt.app custom domain subdomains', () => {
      expect(isAllowedOrigin('https://app.guildmgmt.app')).toBe(true);
      expect(isAllowedOrigin('https://api.guildmgmt.app')).toBe(true);
      expect(isAllowedOrigin('https://auth.guildmgmt.app')).toBe(true);
    });

    it('formally rejects arbitrary and malicious third-party Vercel apps', () => {
      expect(isAllowedOrigin('https://malicious-project.vercel.app')).toBe(false);
      expect(isAllowedOrigin('https://foo-bar.vercel.app')).toBe(false);
      expect(isAllowedOrigin('https://preview-123.vercel.app')).toBe(false);
      expect(isAllowedOrigin('https://evil-project.vercel.app')).toBe(false);
      expect(isAllowedOrigin('https://attacker.vercel.app')).toBe(false);
      expect(isAllowedOrigin('https://notguildmanagement.vercel.app')).toBe(false);
    });

    it('rejects spoofing, subdomain injection, and insecure HTTP attempts', () => {
      expect(isAllowedOrigin('https://evilguildmanagement.vercel.app')).toBe(false);
      expect(isAllowedOrigin('https://guildmanagement.vercel.app.attacker.com')).toBe(false);
      expect(isAllowedOrigin('https://attacker.com?origin=https://guildmanagement.vercel.app')).toBe(false);
      expect(isAllowedOrigin('http://guildmanagement.vercel.app')).toBe(false);
      expect(isAllowedOrigin('http://app.guildmgmt.app')).toBe(false);
      expect(isAllowedOrigin('null')).toBe(false);
      expect(isAllowedOrigin('')).toBe(false);
      expect(isAllowedOrigin(null)).toBe(false);
      expect(isAllowedOrigin(undefined)).toBe(false);
    });
  });

  describe('3. getCorsHeaders - Origin Reflection Semantics', () => {
    it('echoes authorized preview deployment origin', () => {
      const req = new Request('https://api.test', {
        headers: { Origin: 'https://guildmanagement-preview-123.vercel.app' }
      });
      const headers = getCorsHeaders(req);
      expect(headers['Access-Control-Allow-Origin']).toBe('https://guildmanagement-preview-123.vercel.app');
      expect(headers['Vary']).toBe('Origin');
    });

    it('falls back to default localhost:5173 when origin is unauthorized (e.g. malicious Vercel project)', () => {
      const req = new Request('https://api.test', {
        headers: { Origin: 'https://malicious-project.vercel.app' }
      });
      const headers = getCorsHeaders(req);
      expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      expect(headers['Access-Control-Allow-Origin']).not.toBe('https://malicious-project.vercel.app');
      expect(headers['Vary']).toBe('Origin');
    });

    it('returns default origin when request or origin header is missing', () => {
      expect(getCorsHeaders(undefined)['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      const emptyReq = new Request('https://api.test');
      expect(getCorsHeaders(emptyReq)['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    });
  });
});
