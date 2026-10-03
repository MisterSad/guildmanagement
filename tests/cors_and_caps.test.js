import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isAllowedOrigin, getCorsHeaders } from '../supabase/functions/_shared/cors.ts';

describe('CORS Origin Matching & Security Caps (GAP 4)', () => {
  it('correctly matches valid origins and rejects malicious bypass attempts', () => {
    // 1. Allowed localhost & production origins
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
    expect(isAllowedOrigin('https://fgf-guild-management.vercel.app')).toBe(true);

    // 2. Official project Vercel preview deployments
      // FINDING M13, and these expectations are what locked it in.
      //
      // Vercel always ends a deployment host with the owning scope:
      //   <project>-<hash>-<scope>        deployment
      //   <project>-git-<branch>-<scope>  branch preview
      //   <project>-<scope>               project alias
      // The scope-less forms this file used to accept are precisely the ones
      // ANYONE can register, which is what made the old pattern a bypass.
    expect(isAllowedOrigin('https://guildmanagement-mistersads-projects.vercel.app')).toBe(true);
    expect(isAllowedOrigin('https://guildmanagement-abc123def-mistersads-projects.vercel.app')).toBe(true);
    expect(isAllowedOrigin('https://guildmanagement-git-feature-branch-mistersads-projects.vercel.app')).toBe(true);
    // Scope-less: registrable by anyone, therefore refused.
    expect(isAllowedOrigin('https://guildmanagement-preview-123.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://guildmanagement-git-feature.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://guildmanagement-evil.vercel.app')).toBe(false);
    // A subdomain is not a Vercel deployment shape at all.
    expect(isAllowedOrigin('https://preview.guildmanagement.vercel.app')).toBe(false);
    // A real-looking hash under someone else's scope.
    expect(isAllowedOrigin('https://guildmanagement-abc123def-attacker-projects.vercel.app')).toBe(false);

    // 3. guildmgmt.app is not owned by the project: never trusted
    expect(isAllowedOrigin('https://app.guildmgmt.app')).toBe(false);
    expect(isAllowedOrigin('https://api.guildmgmt.app')).toBe(false);

    // 4. Malicious bypass attempts & arbitrary third-party Vercel apps - MUST BE DENIED
    expect(isAllowedOrigin('https://malicious-project.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://foo-bar.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://preview-123.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://evil-project.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://evil-guildmgmt.app.attacker.com')).toBe(false);
    expect(isAllowedOrigin('https://guildmgmt.app.attacker.com')).toBe(false);
    expect(isAllowedOrigin('http://guildmgmt.app')).toBe(false); // Insecure HTTP
    expect(isAllowedOrigin('http://app.guildmgmt.app')).toBe(false); // Insecure HTTP
    expect(isAllowedOrigin('https://evil.vercel.app.evil.com')).toBe(false);
    expect(isAllowedOrigin('https://evilvercel.app')).toBe(false);
    expect(isAllowedOrigin('https://notvercel.app')).toBe(false);
    expect(isAllowedOrigin('null')).toBe(false);
    expect(isAllowedOrigin('')).toBe(false);
  });

  it('getCorsHeaders returns Vary: Origin and appropriate Allow-Origin', () => {
    const validReq = new Request('https://api.test', {
      headers: { Origin: 'https://guildmanagement-abc123def-mistersads-projects.vercel.app' }
    });
    const headers = getCorsHeaders(validReq);
    expect(headers['Access-Control-Allow-Origin']).toBe('https://guildmanagement-abc123def-mistersads-projects.vercel.app');
    expect(headers['Vary']).toBe('Origin');

    const invalidReq = new Request('https://api.test', {
      headers: { Origin: 'https://malicious-project.vercel.app' }
    });
    const invalidHeaders = getCorsHeaders(invalidReq);
    expect(invalidHeaders['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(invalidHeaders['Vary']).toBe('Origin');
  });

  it('containment: cors.ts does not use substring includes matching for domains', () => {
    const corsContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/_shared/cors.ts'), 'utf-8');
    expect(corsContent).not.toContain('includes("guildmgmt.app")');
    expect(corsContent).not.toContain('endsWith(".vercel.app")');
    expect(corsContent).toContain('Vary');
  });

  it('containment: ocr-guild-members enforces image count and payload size caps', () => {
    const ocrContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/ocr-guild-members/index.ts'), 'utf-8');
    expect(ocrContent).toContain('too_many_images');
    expect(ocrContent).toContain('payload_too_large');
    expect(ocrContent).toContain('body.images.length > 5');
    expect(ocrContent).toContain('8 * 1024 * 1024');
  });

  it('containment: discord-webhook-proxy enforces redirect: error', () => {
    const discordContent = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/discord-webhook-proxy/index.ts'), 'utf-8');
    expect(discordContent).toContain('redirect: "error"');
  });
});
