/**
 * src/core/monitoring/sentry.ts
 *
 * Client-side APM & crash reporting via @sentry/browser.
 * Features conditional initialization, strict PII & token scrubbing,
 * and tenant context tagging.
 *
 * M5: @sentry/browser (about a fifth of the old entry bundle) is its own chunk,
 * imported by initSentry() rather than parsed before the first paint. Errors
 * thrown while it downloads are held (up to MAX_EARLY_ERRORS) and reported
 * once it is up, so the boot is not a blind spot.
 */

import type * as SentryNS from '@sentry/browser';
import { SENTRY_DSN, APP_VERSION } from '../config/constants';

let isInitialized = false;
let sdk: typeof import('./sentry-sdk') | null = null;
let loading: Promise<boolean> | null = null;

const MAX_EARLY_ERRORS = 20;
let earlyErrors: unknown[] = [];
let detachEarlyListeners: (() => void) | null = null;

function holdEarlyErrors(): void {
  if (typeof window === 'undefined' || detachEarlyListeners) return;
  const onError = (e: ErrorEvent) => {
    if (earlyErrors.length < MAX_EARLY_ERRORS) earlyErrors.push(e.error || e.message);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (earlyErrors.length < MAX_EARLY_ERRORS) earlyErrors.push(e.reason);
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  detachEarlyListeners = () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    detachEarlyListeners = null;
  };
}

const SENSITIVE_KEYS = new Set([
  'password',
  'secret',
  'gotrue_secret',
  'token',
  'authorization',
  'apikey',
  'key',
  'p_secret',
  'p_password',
  'credential',
  'access_token',
  'refresh_token',
]);

const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{10,}\b/gi, // Secret keys
  /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi,
  /\b(password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
];

export function scrubText(text: string): string {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

export function scrubData(data: unknown, depth = 0): unknown {
  if (depth > 6) return '[MAX_DEPTH]';
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') return scrubText(data);
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map((item) => scrubData(item, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      SENSITIVE_KEYS.has(lower) ||
      lower.includes('password') ||
      lower.includes('secret') ||
      lower.includes('token')
    ) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = scrubData(value, depth + 1);
    } else if (typeof value === 'string') {
      sanitized[key] = scrubText(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function scrubSentryEvent(event: SentryNS.ErrorEvent): SentryNS.ErrorEvent | null {
  if (!event) return null;

  // Scrub main event message
  if (event.message) {
    event.message = scrubText(event.message);
  }

  // Scrub exception values and stack traces
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = scrubText(ex.value);
      if (ex.stacktrace?.frames) {
        for (const frame of ex.stacktrace.frames) {
          if (frame.vars) {
            frame.vars = scrubData(frame.vars) as Record<string, unknown>;
          }
        }
      }
    }
  }

  // Scrub breadcrumbs
  if (event.breadcrumbs) {
    for (const b of event.breadcrumbs) {
      if (b.message) b.message = scrubText(b.message);
      if (b.data) b.data = scrubData(b.data) as Record<string, unknown>;
    }
  }

  // Scrub extra context
  if (event.extra) {
    event.extra = scrubData(event.extra) as Record<string, unknown>;
  }

  // Ensure tags include app_version and active tenant if available
  event.tags = event.tags || {};
  event.tags.app_version = APP_VERSION;
  if (typeof localStorage !== 'undefined') {
    const guild = localStorage.getItem('gm_current_guild');
    if (guild) event.tags.guild = guild;
  }

  return event;
}

export interface SentryInitOptions {
  dsn?: string;
  release?: string;
  environment?: string;
  sampleRate?: number;
}

/**
 * Starts Sentry when a DSN is configured. Resolves true once the SDK is loaded
 * and initialised, false when there is no DSN or it could not start. Safe to
 * call repeatedly: every call shares the first one's outcome.
 */
export function initSentry(options?: SentryInitOptions): Promise<boolean> {
  if (isInitialized) return Promise.resolve(true);
  if (loading) return loading;

  const dsn = options && 'dsn' in options ? options.dsn : SENTRY_DSN;
  if (!dsn || typeof dsn !== 'string' || !dsn.trim()) {
    // Sentry is disabled when no DSN is provided
    return Promise.resolve(false);
  }

  holdEarlyErrors();
  loading = import('./sentry-sdk')
    .then((Sentry) => {
      Sentry.init({
        dsn: dsn.trim(),
        release: options?.release || APP_VERSION,
        environment:
          options?.environment ||
          (typeof import.meta !== 'undefined' && (import.meta as any).env?.MODE) ||
          'production',
        sampleRate: options?.sampleRate ?? 1.0,
        beforeSend: (event) => scrubSentryEvent(event as SentryNS.ErrorEvent),
        sendDefaultPii: false,
      });
      sdk = Sentry;
      isInitialized = true;
      // Sentry's own global handlers take over from here; report what came first.
      if (detachEarlyListeners) detachEarlyListeners();
      const held = earlyErrors;
      earlyErrors = [];
      for (const err of held) {
        try {
          Sentry.captureException(err);
        } catch (_) {
          /* never let reporting throw */
        }
      }
      return true;
    })
    .catch(() => {
      // Silent fail: invalid DSN format, or the chunk could not be downloaded.
      if (detachEarlyListeners) detachEarlyListeners();
      earlyErrors = [];
      loading = null;
      return false;
    });
  return loading;
}

export function captureException(error: unknown, context?: Record<string, unknown>): string | undefined {
  if (!isInitialized || !sdk) return undefined;
  try {
    const safeContext = context ? (scrubData(context) as Record<string, unknown>) : undefined;
    return sdk.captureException(error, safeContext ? { extra: safeContext } : undefined);
  } catch (_) {
    return undefined;
  }
}

export function isSentryInitialized(): boolean {
  return isInitialized;
}

/** Reset initialized state for test harnesses. */
export function _resetSentryForTesting(): void {
  isInitialized = false;
  sdk = null;
  loading = null;
  earlyErrors = [];
  if (detachEarlyListeners) detachEarlyListeners();
}
