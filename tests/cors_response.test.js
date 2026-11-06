// Regression guard for the 2026-08-23 production CORS outage: responses from function code must always echo the request origin.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getCorsHeaders } from '../supabase/functions/_shared/cors.ts';
import { edgeSource } from './helpers/edge-source.js';

const CORS_BEARING_FUNCTIONS = [
  'admin-accounts',
  'member-portal',
  'auth-login',
  'player-register',
  'discord-webhook-proxy',
  'ocr-guild-members',
  'tickets',
];

describe('CORS Response Origin Echo & Closure Regression Suite (v125.3)', () => {
  describe('Static containment on edge function response patterns', () => {
    for (const fnName of CORS_BEARING_FUNCTIONS) {
      it(`enforces makeJson(req) closure and zero 3-arg json calls in ${fnName}`, () => {
        const filePath = path.resolve(__dirname, `../supabase/functions/${fnName}/index.ts`);
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, 'utf-8');

        // (a) Asserts makeJson(req) exists
        expect(content).toMatch(/function\s+makeJson\s*\(\s*req:\s*Request\s*\)/);

        // Asserts const json = makeJson(req) is invoked inside the serve handler
        expect(content).toMatch(/const\s+json\s*=\s*makeJson\s*\(\s*req\s*\)/);

        // (b) Asserts ZERO 3-arg json calls (regex `json\([^;]*,\s*req\s*\)` -> no match)
        const threeArgCalls = content.match(/json\([^;]*,\s*req\s*\)/g);
        expect(threeArgCalls).toBeNull();
      });
    }

    it('enforces makeJson(req) closure in event-reminders', () => {
      const content = edgeSource('event-reminders');
      expect(content).toMatch(/function\s+makeJson\s*\(\s*req:\s*Request\s*\)/);
      expect(content).toMatch(/const\s+json\s*=\s*makeJson\s*\(\s*req\s*\)/);
      const threeArgCalls = content.match(/json\([^;]*,\s*req\s*\)/g);
      expect(threeArgCalls).toBeNull();
    });
  });

  describe('CORS header semantics with getCorsHeaders', () => {
    it('echoes canonical production origin when present on request', () => {
      const req = new Request('https://api.test', {
        headers: { Origin: 'https://guildmanagement.vercel.app' },
      });
      const headers = getCorsHeaders(req);
      expect(headers['Access-Control-Allow-Origin']).toBe('https://guildmanagement.vercel.app');
      expect(headers['Vary']).toBe('Origin');
    });

    it('rejects disallowed origin and does NOT echo it', () => {
      const req = new Request('https://api.test', {
        headers: { Origin: 'https://evil.attacker.com' },
      });
      const headers = getCorsHeaders(req);
      expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      expect(headers['Access-Control-Allow-Origin']).not.toBe('https://evil.attacker.com');
      expect(headers['Vary']).toBe('Origin');
    });

    it('returns localhost fallback when req is undefined (documents the fail-closed outage mode eliminated by closure)', () => {
      const headers = getCorsHeaders(undefined);
      expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      expect(headers['Vary']).toBe('Origin');
    });
  });
});
