/**
 * supabase/functions/_shared/pagination.ts
 *
 * Safe paginated user lookup helper for Supabase GoTrue admin client.
 * Replaces unpaginated listUsers() which only returned page 1 (50 users).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
