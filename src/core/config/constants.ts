/**
 * src/core/config/constants.ts
 *
 * Shared application constants extracted from the legacy root `gm-utils.js`.
 */

/** Single source of truth for the user-facing app version (see AGENTS.md §6). */
export const APP_VERSION = 'V3.23.0';

export const SUPABASE_URL = 'https://vgweufzwmfwplusskmuf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_c79HkCPMv7FmNvi1wGwlIg_N3isrSKo';

/*
 * B1: `MAX_NUMERIC` used to be declared here as well as in `core/utils/text.ts`,
 * with the same value. This copy had ZERO importers -- every consumer, including
 * main.ts and gm-bridge.ts, takes it from `text.ts`, which is also where the only
 * code that uses it lives (formatNumber and parseNumber clamp against it). A
 * second declaration of a bound is a second thing to forget to change.
 */

/** Sentry DSN for client-side crash reporting & APM (optional). */
export const SENTRY_DSN: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SENTRY_DSN) ||
  (typeof window !== 'undefined' && (window as any).__SENTRY_DSN__) ||
  '';

