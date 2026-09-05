/**
 * src/core/api/supabase.ts
 *
 * Supabase client accessor & REST helper wrappers.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function getSupabaseConfig(): { url: string; key: string } {
  const url = (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_SUPABASE_URL : undefined) || '';
  const key = (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_SUPABASE_ANON_KEY : undefined) || '';
  return { url, key };
}

export function validateSupabaseEnv(): { url: string; anonKey: string } {
  const { url, key } = getSupabaseConfig();
  if (!url || !key) {
    throw new Error(
      'Supabase initialization error: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variable.'
    );
  }
  return { url, anonKey: key };
}

export function resetSupabaseClient(): void {
  client = null;
}

export function getSupabaseClient(): SupabaseClient | null {
  if (client) return client;

  if (typeof window !== 'undefined' && (window as any).GM && (window as any).GM.db) {
    client = (window as any).GM.db;
    return client;
  }

  const { url, key } = getSupabaseConfig();

  if (!url || !key) {
    console.error(
      '[Supabase] Configuration error: Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables.'
    );
    return null;
  }

  try {
    if (typeof window !== 'undefined' && (window as any).supabase?.createClient) {
      client = (window as any).supabase.createClient(url, key);
      return client;
    }
    client = createClient(url, key);
    return client;
  } catch (e) {
    console.error('Supabase init error:', e);
    return null;
  }
}

// Must stay byte-for-byte equivalent to gm-utils.js's escapeHTML (legacy):
// window.GM.escapeHTML gets reassigned to this one on every page load
// (see main.ts), so any drift here is a silent, load-order-dependent
// regression for every legacy module reading window.GM.escapeHTML.
export function escapeHTML(str: any): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}
