import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  getSupabaseClient,
  getSupabaseConfig,
  validateSupabaseEnv,
  resetSupabaseClient,
} from '../src/core/api/supabase.ts';

const supabaseApiPath = path.resolve(__dirname, '../src/core/api/supabase.ts');
const supabaseApiContent = fs.readFileSync(supabaseApiPath, 'utf-8');
const envExamplePath = path.resolve(__dirname, '../.env.example');
const envExampleContent = fs.readFileSync(envExamplePath, 'utf-8');

describe('Ticket 3.1: Static Containment - Absence of Sensitive Hardcoded Keys', () => {
  it('does not contain hardcoded Supabase project URL or project ref in src/core/api/supabase.ts', () => {
    expect(supabaseApiContent).not.toContain('vgweufzwmfwplusskmuf');
    expect(supabaseApiContent).not.toMatch(/const\s+SUPABASE_URL\s*=\s*['"]https:\/\/[^'"]+['"]/);
  });

  it('does not contain hardcoded publishable/anon key in src/core/api/supabase.ts', () => {
    expect(supabaseApiContent).not.toContain('sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo');
    expect(supabaseApiContent).not.toContain('sb_publishable_');
    expect(supabaseApiContent).not.toMatch(/const\s+SUPABASE_KEY\s*=\s*['"]sb_[^'"]+['"]/);
  });

  it('references VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY via import.meta.env', () => {
    expect(supabaseApiContent).toContain('import.meta.env.VITE_SUPABASE_URL');
    expect(supabaseApiContent).toContain('import.meta.env.VITE_SUPABASE_ANON_KEY');
  });

  it('exports required helper functions (getSupabaseConfig, validateSupabaseEnv, getSupabaseClient)', () => {
    expect(supabaseApiContent).toContain('export function getSupabaseConfig');
    expect(supabaseApiContent).toContain('export function validateSupabaseEnv');
    expect(supabaseApiContent).toContain('export function getSupabaseClient');
  });

  it('documents VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.example with dummy placeholders', () => {
    expect(envExampleContent).toContain('VITE_SUPABASE_URL=https://your-project.supabase.co');
    expect(envExampleContent).toContain('VITE_SUPABASE_ANON_KEY=your-anon-key-here');
  });
});

describe('Ticket 3.1: Runtime Environment Validation & Controlled Fallback', () => {
  const originalEnv = { ...import.meta.env };
  const originalGM = typeof window !== 'undefined' ? window.GM : undefined;

  beforeEach(() => {
    resetSupabaseClient();
  });

  afterEach(() => {
    // Restore environment
    Object.keys(import.meta.env).forEach((k) => delete import.meta.env[k]);
    Object.assign(import.meta.env, originalEnv);
    if (typeof window !== 'undefined') {
      window.GM = originalGM;
    }
    resetSupabaseClient();
  });

  it('validateSupabaseEnv throws explicit Error when environment variables are missing', () => {
    delete import.meta.env.VITE_SUPABASE_URL;
    delete import.meta.env.VITE_SUPABASE_ANON_KEY;

    expect(() => validateSupabaseEnv()).toThrow(
      /Supabase initialization error: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY/
    );
  });

  it('validateSupabaseEnv returns { url, anonKey } when environment variables are configured', () => {
    import.meta.env.VITE_SUPABASE_URL = 'https://custom-env.supabase.co';
    import.meta.env.VITE_SUPABASE_ANON_KEY = 'custom-anon-key-12345';

    const config = validateSupabaseEnv();
    expect(config.url).toBe('https://custom-env.supabase.co');
    expect(config.anonKey).toBe('custom-anon-key-12345');
  });

  it('getSupabaseConfig returns current Vite environment values', () => {
    import.meta.env.VITE_SUPABASE_URL = 'https://test-project.supabase.co';
    import.meta.env.VITE_SUPABASE_ANON_KEY = 'test-key-67890';

    const cfg = getSupabaseConfig();
    expect(cfg.url).toBe('https://test-project.supabase.co');
    expect(cfg.key).toBe('test-key-67890');
  });

  it('getSupabaseClient reuses window.GM.db as a safe controlled fallback', () => {
    const fakeDb = { from: vi.fn(), rpc: vi.fn(), auth: {} };
    if (typeof window !== 'undefined') {
      window.GM = { db: fakeDb };
    }

    const client = getSupabaseClient();
    expect(client).toBe(fakeDb);
  });

  it('getSupabaseClient logs explicit error and returns null when neither GM.db nor Vite env are present', () => {
    if (typeof window !== 'undefined' && window.GM) {
      window.GM.db = null;
    }
    delete import.meta.env.VITE_SUPABASE_URL;
    delete import.meta.env.VITE_SUPABASE_ANON_KEY;

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = getSupabaseClient();

    expect(client).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[Supabase] Configuration error: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY')
    );
    consoleSpy.mockRestore();
  });
});
