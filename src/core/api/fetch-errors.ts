/**
 * src/core/api/fetch-errors.ts
 *
 * Phase 3 (P3-01 / P3-02) -- unified error classification for PostgREST,
 * Edge Function and network failures, plus an inline-retry affordance and a
 * session-invalidation hook.
 *
 * Pure and dependency-injected: `mapFetchError` / `isAbortError` never touch
 * the DOM; the toast / session handlers are configured once at bootstrap via
 * configureFetchErrorRuntime() (main.ts), so unit tests can substitute fakes.
 */


// The one escaping boundary. Imported from utils/text rather than from
// ./supabase (which re-exports it) because supabase.ts imports mapFetchError
// from this module -- going through it would create an import cycle.
// This stays consistent with the "pure" contract above: escapeHTML is a pure
// string function and touches no DOM.
import { escapeHTML } from '../utils/text';
import { showToast } from '../dom/toast';

export type FetchErrorKind = 'offline' | 'gateway' | 'rate_limited' | 'unauthorized' | 'server' | 'unknown';

export interface FetchErrorInfo {
  kind: FetchErrorKind;
  message: string;
}

/** True for the synthetic abort error raised when a view-load request is cancelled. */
export function isAbortError(err: any): boolean {
  if (!err) return false;
  const name = String(err?.name || '');
  const code = String(err?.code || '');
  const msg = String(err?.message || '').toLowerCase();
  return (
    name === 'AbortError' ||
    code === 'ABORT_ERR' ||
    err?.name === 'CanceledError' ||
    msg.includes('abort') ||
    msg.includes('canceled')
  );
}

function errMessage(err: any): string {
  if (!err) return '';
  const m = err?.message ?? err?.error_description ?? err?.hint;
  if (typeof m === 'string' && m && !m.startsWith('[') && m !== '[object Object]') return m.slice(0, 180);
  if (err instanceof Error) return err.message.slice(0, 180);
  return '';
}

/**
 * Classifies an unknown error (from a Supabase/PostgREST/Edge/network call)
 * into one of the six Frontend-resilience buckets.
 *
 * Priority: abort/offline → 401/session → 429 → 5xx gateway (502/503/504) →
 * other 5xx → unknown. Both the numeric HTTP status (where the client exposes
 * it) and the message text are inspected, because PostgREST historically
 * surfaces JWT expiry and rate limits as message-only errors.
 */
export function mapFetchError(err: any, ctx = 'request'): FetchErrorInfo {
  if (!err) return { kind: 'unknown', message: ctx };

  if (isAbortError(err)) {
    return { kind: 'unknown', message: 'Request cancelled.' };
  }

  const status = Number(err?.status ?? err?.context?.status ?? err?.error?.status ?? 0);
  const code = String(err?.code || '');
  const rawMsg = errMessage(err);
  const msg = rawMsg.toLowerCase();

  const offline =
    typeof navigator !== 'undefined' && navigator.onLine === false;

  if (offline || /failed to fetch|network request failed|networkerror|load failed|fetch failed/.test(msg)) {
    return { kind: 'offline', message: rawMsg || ctx };
  }

  if (
    status === 401 ||
    code === 'PGRST301' ||
    /jwt expired|jwt_expired|token.*has expired|invalid refresh token|refresh token not found|session expired/.test(msg)
  ) {
    return { kind: 'unauthorized', message: rawMsg || ctx };
  }

  if (status === 429 || /too many requests|rate limit|too_many_attempts|rate limit exceeded/.test(msg)) {
    return { kind: 'rate_limited', message: rawMsg || ctx };
  }

  if (
    [502, 503, 504, 599].includes(status) ||
    /gateway|upstream|service unavailable|unexpected end of|timed out|timeout|cross-origin/.test(msg)
  ) {
    return { kind: 'gateway', message: rawMsg || ctx };
  }

  if (status >= 500 && status < 600) {
    return { kind: 'server', message: rawMsg || ctx };
  }

  return { kind: 'unknown', message: rawMsg || ctx };
}

function humanMessage(kind: FetchErrorKind): string {
  switch (kind) {
    case 'offline':
      return 'No internet connection.';
    case 'gateway':
      return 'The server is busy or unreachable. Please retry.';
    case 'rate_limited':
      return 'Too many requests. Please wait a moment and try again.';
    case 'unauthorized':
      return 'Your session has expired. Please log in again.';
    case 'server':
      return 'A server error occurred. Please try again shortly.';
    default:
      return 'The request failed.';
  }
}

/* ---------------------------------------------------------------------------
 * Runtime dependencies (wired once in main.ts)
 * ------------------------------------------------------------------------- */

export interface FetchErrorRuntime {
  showToast?: (message: unknown, type?: 'success' | 'error' | 'warning') => void;
  onSessionInvalid?: () => void;
}

function defaultToast(message: unknown): void {
  showToast(message, 'error');
}

let runtime: Required<FetchErrorRuntime> = {
  showToast: defaultToast,
  onSessionInvalid: () => { /* no-op */ },
};

/** Injects the toast renderer and session-invalidation handler (main.ts). */
export function configureFetchErrorRuntime(cfg: FetchErrorRuntime): void {
  runtime = {
    showToast: cfg.showToast || defaultToast,
    onSessionInvalid: cfg.onSessionInvalid || (() => { /* no-op */ }),
  };
}

export function getFetchErrorRuntime(): Required<FetchErrorRuntime> {
  return runtime;
}

/* ---------------------------------------------------------------------------
 * Inline retry banner (single, non-blocking, body-level)
 * ------------------------------------------------------------------------- */

// Delegates to the single escaping boundary. The previous local version omitted
// the apostrophe, which made it correct only inside double-quoted attributes --
// an implicit contract every future caller would have had to know about.
// escapeHTML covers both quote styles, so it is safe in any attribute context.
function escapeAttr(value: unknown): string {
  return escapeHTML(value);
}

let retryBannerEl: HTMLElement | null = null;

function ensureRetryBanner(retryFn: () => void, label: string): void {
  if (typeof document === 'undefined') return;
  if (retryBannerEl && document.body.contains(retryBannerEl)) {
    retryBannerEl.remove();
    retryBannerEl = null;
  }

  const banner = document.createElement('div');
  banner.id = 'gm-fetch-retry-banner';
  banner.dataset.fetchRetry = '1';
  banner.style.cssText =
    'position:fixed; bottom:1rem; left:1rem; z-index:9600; max-width:340px; ' +
    'background:var(--bg-soft, #1a1a24); border:1px solid rgba(251,191,36,0.45); ' +
    'border-radius:12px; padding:.8rem .9rem; display:flex; align-items:center; gap:.6rem; ' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.4);';

  banner.innerHTML =
    '<div style="flex:1; font-size:var(--fs-sm); line-height:1.35;">' +
      '<span style="font-weight:700;">Failed to load ' + escapeAttr(label) + '.</span> ' +
      '<span style="opacity:.85;">Please retry when the network allows.</span>' +
    '</div>' +
    '<button type="button" data-fetch-retry-action="retry" class="gm-btn gm-btn-primary gm-btn-sm" style="flex-shrink:0;">Retry</button>' +
    '<button type="button" data-fetch-retry-action="dismiss" class="gm-btn gm-btn-ghost gm-btn-sm" style="flex-shrink:0;" aria-label="Dismiss">&times;</button>';

  document.body.appendChild(banner);

  banner.querySelector<HTMLElement>('[data-fetch-retry-action="retry"]')?.addEventListener('click', () => {
    banner.remove();
    retryBannerEl = null;
    try { retryFn(); } catch (e) { console.error('fetch retry failed', e); }
  });
  banner.querySelector<HTMLElement>('[data-fetch-retry-action="dismiss"]')?.addEventListener('click', () => {
    banner.remove();
    retryBannerEl = null;
  });

  retryBannerEl = banner;
}

/**
 * Toast-feedback helper for tab loaders. Classifies `err`, shows a non-blocking
 * toast (warning for rate-limits, error otherwise), triggers the session
 * invalidation hook on 401/jwt-expiry, and -- when `retryFn` is provided --
 * mounts a body-level Retry banner.
 */
export function toastFetchError(err: any, ctx = 'request', retryFn?: () => void): FetchErrorInfo {
  const info = mapFetchError(err, ctx);

  if (info.kind === 'unauthorized') {
    runtime.onSessionInvalid();
    runtime.showToast(humanMessage('unauthorized'), 'warning');
    return info;
  }

  const detail = info.kind === 'server' || info.kind === 'gateway' || info.kind === 'unknown'
    ? (info.message ? ' (' + info.message.slice(0, 140) + ')' : '')
    : '';

  runtime.showToast(humanMessage(info.kind) + detail, info.kind === 'rate_limited' ? 'warning' : 'error');

  if (typeof retryFn === 'function') {
    ensureRetryBanner(retryFn, ctx);
  }

  return info;
}