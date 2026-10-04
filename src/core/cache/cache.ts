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
  return !!t && Date.now() - t < ttlMs;
}

export function markFresh(key: string): void {
  timestamps[key] = Date.now();
}

export function invalidate(key?: string | null): void {
  if (key) {
    delete timestamps[key];
  } else {
    Object.keys(timestamps).forEach((k) => {
      delete timestamps[k];
    });
  }
}

export function clear(): void {
  invalidate();
}

/**
 * Keys of the views whose content is *derived* from tenant data: Stats and
 * History both aggregate `event_participants`, `weekly_scores`, `sanctions` and
 * the war tables, so any write to those invalidates what they are showing.
 *
 * `StatsView` and `HistoryView` are the only two readers of this cache, and
 * they key it exactly this way (`'stats:' + guild`, `'history:' + guild`).
 */
export function derivedViewKeys(guild: string): string[] {
  return ['stats:' + guild, 'history:' + guild];
}

/**
 * Invalidates the Stats and History freshness markers for one guild.
 *
 * Called from `installDbWriteGuard` on every tenant write rather than from each
 * mutation site: there are 55 write call sites across EventsView,
 * ShadowfrontView, ArmsRaceView and SanctionsView, and **none of them
 * invalidated anything**. Editing a war score and switching to Stats within the
 * 15s TTL showed the pre-edit numbers with no indication they were stale.
 * Wiring 55 sites by hand would have drifted; the write guard cannot be
 * bypassed, so the invalidation cannot be forgotten.
 */
export function invalidateGuildViews(guild: string): void {
  derivedViewKeys(guild).forEach((k) => invalidate(k));
}

export const cache = { isFresh, markFresh, invalidate, clear, invalidateGuildViews };
export default cache;
