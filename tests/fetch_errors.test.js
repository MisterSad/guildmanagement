// 2026-09-13 -- Phase 3 P3-01/P3-02: unified fetch-error classification and
// inline-retry / session-invalidation behavior.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mapFetchError,
  isAbortError,
  toastFetchError,
  configureFetchErrorRuntime
} from '../src/core/api/fetch-errors';

describe('mapFetchError', () => {
  it('classifies network failures (offline)', () => {
    expect(mapFetchError(new TypeError('Failed to fetch')).kind).toBe('offline');
    expect(mapFetchError({ message: 'Network Request Failed' }).kind).toBe('offline');
  });

  it('classifies gateway timeouts (504/502/503)', () => {
    expect(mapFetchError({ status: 504, message: 'Gateway Timeout' }).kind).toBe('gateway');
    expect(mapFetchError({ status: 502 }).kind).toBe('gateway');
    expect(mapFetchError({ message: '502 Bad Gateway' }).kind).toBe('gateway');
  });

  it('classifies rate limits (429 / message)', () => {
    expect(mapFetchError({ status: 429, message: 'Too Many Requests', code: 'PGRST' }).kind).toBe('rate_limited');
    expect(mapFetchError({ message: 'Too many requests, please retry later' }).kind).toBe('rate_limited');
  });

  it('classifies session invalidation (401 / jwt_expired / invalid refresh grant)', () => {
    expect(mapFetchError({ status: 401, message: 'JWT expired' }).kind).toBe('unauthorized');
    expect(mapFetchError({ message: 'Invalid Refresh Token: Refresh Token Not Found' }).kind).toBe('unauthorized');
    expect(mapFetchError({ status: 401 }).kind).toBe('unauthorized');
  });

  it('classifies generic 5xx as server', () => {
    expect(mapFetchError({ status: 500, message: 'Internal Server Error' }).kind).toBe('server');
    expect(mapFetchError({ status: 503, message: 'Service Unavailable' }).kind).toBe('gateway');
  });

  it('fails open to unknown for anything else', () => {
    const info = mapFetchError(new Error('boom'), 'members');
    expect(info.kind).toBe('unknown');
    expect(info.message).toBe('boom');
  });

  it('treats null/undefined as unknown', () => {
    expect(mapFetchError(null).kind).toBe('unknown');
    expect(mapFetchError(undefined).kind).toBe('unknown');
  });
});

describe('isAbortError', () => {
  it('recognizes DOM AbortError and aborted messages', () => {
    expect(isAbortError({ name: 'AbortError', message: 'The operation was aborted.' })).toBe(true);
    expect(isAbortError({ code: 'ABORT_ERR' })).toBe(true);
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});

describe('toastFetchError (with injected runtime)', () => {
  let toastSpy;
  let sessionSpy;
  let retryFn;

  beforeEach(() => {
    toastSpy = vi.fn();
    sessionSpy = vi.fn();
    retryFn = vi.fn();
    configureFetchErrorRuntime({ showToast: toastSpy, onSessionInvalid: sessionSpy });
    document.body.innerHTML = '';
  });

  afterEach(() => {
    configureFetchErrorRuntime({});
    document.body.innerHTML = '';
  });

  it('shows a warning toast and triggers session invalidation on 401', () => {
    toastFetchError({ status: 401, message: 'JWT expired' }, 'members');
    expect(sessionSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][1]).toBe('warning');
  });

  it('shows a warning toast on rate limiting (no session invalidation)', () => {
    toastFetchError({ status: 429 }, 'accounts');
    expect(sessionSpy).not.toHaveBeenCalled();
    expect(toastSpy.mock.calls[0][1]).toBe('warning');
  });

  it('shows an error toast with details on gateway/server failures', () => {
    toastFetchError({ status: 504, message: 'Gateway Timeout' }, 'stats');
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][1]).toBe('error');
    expect(String(toastSpy.mock.calls[0][0])).toContain('Gateway Timeout');
  });

  it('mounts an inline Retry banner and invokes the retry callback', () => {
    toastFetchError(new Error('boom'), 'members', retryFn);

    expect(document.querySelector('[data-fetch-retry]')).toBeTruthy();
    const retryBtn = document.querySelector('[data-fetch-retry-action="retry"]');
    expect(retryBtn).toBeTruthy();
    retryBtn.click();

    expect(retryFn).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-fetch-retry]')).toBeNull();
  });

  it('does not mount a banner when no retry callback is supplied', () => {
    toastFetchError({ status: 500 }, 'history');
    expect(document.querySelector('[data-fetch-retry]')).toBeNull();
  });
});