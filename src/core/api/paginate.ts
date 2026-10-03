/**
 * src/core/api/paginate.ts
 *
 * Reads every row of a query, page by page.
 *
 * PostgREST answers at most `max_rows` rows (1,000 here) per request and says
 * nothing when it stops there. A huge `.limit()` does not lift that cap: it
 * only asks for more than the server will send. A list that must be complete
 * has to page (audit PERF-04).
 *
 * The page is advanced by what actually came back and stops on an empty page,
 * so a server cap smaller than `pageSize` cannot end the read early. The query
 * must be ordered on a unique column, or rows can shift between pages.
 */

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

export async function fetchAllRows<T>(
  page: (from: number, to: number) => PageResult<T>,
  pageSize = 1000
): Promise<{ data: T[]; error: unknown | null }> {
  const all: T[] = [];
  let from = 0;
  // Hard stop far above any guild's history, so a misbehaving query cannot loop forever.
  for (let i = 0; i < 1000; i++) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { data: all, error };
    const rows = data || [];
    if (rows.length === 0) return { data: all, error: null };
    all.push(...rows);
    from += rows.length;
  }
  return { data: all, error: new Error('fetchAllRows: page limit reached') };
}
