/**
 * supabase/functions/_shared/db.ts
 *
 * The one type every Edge Function uses for a Supabase client it is handed.
 *
 * `ReturnType<typeof createClient>` used to be written inline in 28 places.
 * Without a Database generic, supabase-js 2.117 resolves every table and RPC
 * of that type to `never`, so `deno check` reported 121 errors and the CI could
 * not type-check the Edge code at all. The schema stays untyped here on
 * purpose: the generated types live in src/ for the front end, and importing
 * them into the Deno bundle is a separate piece of work.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";

// deno-lint-ignore no-explicit-any
export type AdminClient = SupabaseClient<any, any, any>;
