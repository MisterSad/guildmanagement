/**
 * supabase/functions/_shared/pagination.ts
 *
 * Safe pagination helpers -- both the GoTrue admin user lookup below, and a
 * generic Postgres table pager for tables that can grow past PostgREST's
 * default row cap (event_participants and player_metrics_history in
 * particular are unbounded, append-only ledgers for a real guild).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

/**
 * Searches for a GoTrue user by email across all pages.
 * Handles pagination up to 10,000 users safely.
 */
export async function findUserByEmail(
  admin: ReturnType<typeof createClient>,
  email: string
): Promise<{ id: string; email?: string; app_metadata?: Record<string, unknown> } | null> {
  if (!email) return null;
  const targetEmail = email.trim().toLowerCase();

  let page = 1;
  const perPage = 100;
  const maxPages = 100; // Safeguard up to 10,000 users

  while (page <= maxPages) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data?.users || data.users.length === 0) {
      break;
    }

    const found = data.users.find(
      (u) => u.email && u.email.trim().toLowerCase() === targetEmail
    );

    if (found) {
      return {
        id: found.id,
        email: found.email,
        app_metadata: found.app_metadata as Record<string, unknown>,
      };
    }

    if (data.users.length < perPage) {
      // Reached the last page
      break;
    }

    page++;
  }

  return null;
}

const TABLE_PAGE_SIZE = 1000;

/**
 * Fetches every row of a table matching a filter, paging through in blocks
 * of 1000 regardless of table size -- cheap for a small table, and the
 * only thing that prevents a silent truncation on a large one (PostgREST's
 * default row cap otherwise applies transparently to a plain .select()).
 */
export async function fetchAllRows(
  admin: ReturnType<typeof createClient>,
  table: string,
  columns: string,
  applyFilter: (query: any) => any
): Promise<Record<string, unknown>[]> {
  let all: Record<string, unknown>[] = [];
  let from = 0;
  while (true) {
    const query = applyFilter(admin.from(table).select(columns)).range(from, from + TABLE_PAGE_SIZE - 1);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to fetch ${table}: ${error.message}`);
    const rows = (data as Record<string, unknown>[]) || [];
    all = all.concat(rows);
    if (rows.length < TABLE_PAGE_SIZE) break;
    from += TABLE_PAGE_SIZE;
  }
  return all;
}
