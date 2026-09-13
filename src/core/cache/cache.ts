/**
 * src/core/cache/cache.ts
 *
 * In-memory freshness tracker (port of the legacy `GM.cache`). Lives only in
 * memory: a full page reload always starts cold. A short TTL is used as a
 * safety net so stale data can never persist indefinitely if an invalidate()
 * call site is ever missed.
 */

const timestamps: Record<string, number> = {};

export function isFresh(key: string, ttlMs: number): boolean {
  const t = timestamps[key];
  return !!t && (Date.now() - t) < ttlMs;
}

export function markFresh(key: string): void {
  timestamps[key] = Date.now();
}

export function invalidate(key?: string | null): void {
  if (key) {
    delete timestamps[key];
  } else {
    Object.keys(timestamps).forEach((k) => { delete timestamps[k]; });
  }
}

export function clear(): void {
  invalidate();
}

export const cache = { isFresh, markFresh, invalidate, clear };
export default cache;
