import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getValidatedEnv, ConfigurationError, } from '../supabase/functions/_shared/env.ts';

describe('Ticket 2.1: Zod Runtime Environment Validator (env.ts)', () => {
  const validBaseEnv = {
    SUPABASE_URL: 'https://example-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-9876543210',
    SUPABASE_ANON_KEY: 'test-anon-key-1234567890',
  };

  it('successfully parses valid environment variables with all fields', () => {
    const fullEnv = {
      ...validBaseEnv,
      GEMINI_API_KEY: 'AIzaSyFakeKey1234567890',
    };

    const env = getValidatedEnv(fullEnv);
    expect(env.SUPABASE_URL).toBe('https://example-project.supabase.co');
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe('test-service-role-key-9876543210');
    expect(env.SUPABASE_ANON_KEY).toBe('test-anon-key-1234567890');
    expect(env.GEMINI_API_KEY).toBe('AIzaSyFakeKey1234567890');
  });

  it('defaults GEMINI_API_KEY to empty string when not provided', () => {
    const env = getValidatedEnv(validBaseEnv);
    expect(env.GEMINI_API_KEY).toBe('');
    expect(env.SUPABASE_URL).toBe('https://example-project.supabase.co');
  });

  it('rejects invalid or missing SUPABASE_URL', () => {
    // Missing
    const missingUrl = { ...validBaseEnv };
    delete missingUrl.SUPABASE_URL;
    expect(() => getValidatedEnv(missingUrl)).toThrow(ConfigurationError);

    // Malformed URL
    const malformedUrl = { ...validBaseEnv, SUPABASE_URL: 'not-a-valid-url' };
    expect(() => getValidatedEnv(malformedUrl)).toThrow(ConfigurationError);

    // Empty string
    const emptyUrl = { ...validBaseEnv, SUPABASE_URL: '' };
    expect(() => getValidatedEnv(emptyUrl)).toThrow(ConfigurationError);
  });

  it('rejects missing or empty SUPABASE_SERVICE_ROLE_KEY', () => {
    // Missing
    const missingKey = { ...validBaseEnv };
    delete missingKey.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => getValidatedEnv(missingKey)).toThrow(ConfigurationError);

    // Empty string
    const emptyKey = { ...validBaseEnv, SUPABASE_SERVICE_ROLE_KEY: '' };
    expect(() => getValidatedEnv(emptyKey)).toThrow(ConfigurationError);
  });

  it('rejects missing or empty SUPABASE_ANON_KEY', () => {
    // Missing
    const missingKey = { ...validBaseEnv };
    delete missingKey.SUPABASE_ANON_KEY;
    expect(() => getValidatedEnv(missingKey)).toThrow(ConfigurationError);

    // Empty string
    const emptyKey = { ...validBaseEnv, SUPABASE_ANON_KEY: '' };
    expect(() => getValidatedEnv(emptyKey)).toThrow(ConfigurationError);
  });

  it('enforces non-empty GEMINI_API_KEY when requireGemini option is true', () => {
    // Missing when required
    expect(() => getValidatedEnv(validBaseEnv, { requireGemini: true })).toThrow(ConfigurationError);

    // Empty string when required
    expect(() => getValidatedEnv({ ...validBaseEnv, GEMINI_API_KEY: '' }, { requireGemini: true })).toThrow(ConfigurationError);

    // Success when provided
    const validWithGemini = { ...validBaseEnv, GEMINI_API_KEY: 'valid-gemini-key' };
    const env = getValidatedEnv(validWithGemini, { requireGemini: true });
    expect(env.GEMINI_API_KEY).toBe('valid-gemini-key');
  });

  it('formats explicit error messages and attaches Zod issues to ConfigurationError', () => {
    let capturedError = null;
    try {
      getValidatedEnv({ SUPABASE_URL: 'invalid', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_ANON_KEY: '' });
    } catch (err) {
      capturedError = err;
    }

    expect(capturedError).toBeInstanceOf(ConfigurationError);
    expect(capturedError.message).toContain('Environment configuration error:');
    expect(capturedError.message).toContain('SUPABASE_URL');
    expect(capturedError.issues).toBeDefined();
    expect(capturedError.issues.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Ticket 2.1: Static Containment - Edge Functions use getValidatedEnv', () => {
  it('auth-login/index.ts imports and uses getValidatedEnv without raw Deno.env calls', () => {
    const authLoginPath = path.resolve(__dirname, '../supabase/functions/auth-login/index.ts');
    const content = fs.readFileSync(authLoginPath, 'utf-8');

    expect(content).toContain('import { getValidatedEnv } from "../_shared/env.ts";');
    // Called for its cold-start validation; auth-login reads no variable itself.
    expect(content).toMatch(/^getValidatedEnv\(\);$/m);
    expect(content).not.toContain('Deno.env.get(');
  });

  it('ocr-guild-members/index.ts imports and uses getValidatedEnv without raw Deno.env calls', () => {
    const ocrPath = path.resolve(__dirname, '../supabase/functions/ocr-guild-members/index.ts');
    const content = fs.readFileSync(ocrPath, 'utf-8');

    expect(content).toContain('import { getValidatedEnv } from "../_shared/env.ts";');
    expect(content).toContain('const env = getValidatedEnv();');
    expect(content).not.toContain('Deno.env.get(');
    // Preserves required header interpolation for existing security tests
    expect(content).toContain('"x-goog-api-key": GEMINI_API_KEY');
  });
});
