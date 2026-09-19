/**
 * src/core/config/constants.ts
 *
 * Shared application constants extracted from the legacy root `gm-utils.js`.
 */

/** Single source of truth for the user-facing app version (see AGENTS.md §6). */
export const APP_VERSION = 'V3.20.0';

export const SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';

/** Upper bound for parsed/displayed numeric metrics. */
export const MAX_NUMERIC = 9999999999;

/** Sentry DSN for client-side crash reporting & APM (optional). */
export const SENTRY_DSN: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SENTRY_DSN) ||
  (typeof window !== 'undefined' && (window as any).__SENTRY_DSN__) ||
  '';

