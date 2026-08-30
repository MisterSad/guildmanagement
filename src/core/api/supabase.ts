/**
 * src/core/api/supabase.ts
 *
 * Supabase client accessor & REST helper wrappers.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (client) return client;

  if (typeof window !== 'undefined' && (window as any).GM && (window as any).GM.db) {
    client = (window as any).GM.db;
    return client;
  }

  try {
    if (typeof window !== 'undefined' && (window as any).supabase?.createClient) {
      client = (window as any).supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      return client;
    }
    client = createClient(SUPABASE_URL, SUPABASE_KEY);
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
