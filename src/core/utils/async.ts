/**
 * src/core/utils/async.ts
 *
 * Async helpers extracted from the legacy root `gm-utils.js`.
 */

/**
 * Runs `worker` over `items` in parallel batches of `chunkSize` (instead of one
 * request at a time). Batches keep concurrency bounded for per-row Supabase
 * calls. Returns the flattened results.
 */
export async function runInChunks<T, R>(items: T[], chunkSize: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  let results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(worker));
    results = results.concat(chunkResults);
  }
  return results;
}

/**
 * Delays invoking `fn` until `wait` ms have elapsed since the last call.
 * Preserves the last call's `this` and arguments.
 */
export function debounce<F extends (...args: any[]) => void>(fn: F, wait: number): (...args: Parameters<F>) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return function (this: unknown, ...args: Parameters<F>): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn.apply(this, args);
    }, wait);
  };
}
