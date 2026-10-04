/**
 * supabase/functions/_shared/clients.ts
 *
 * The one place an Edge Function gets a Supabase client (audit QA-01).
 *
 * Every function used to call `createClient(SUPABASE_URL, KEY, ...)` inline,
 * 28 times, which made a handler impossible to run under test without a live
 * project. Tests install a fake with `setClientFactoryForTests`; production
 * never calls it.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.2";
import type { AdminClient } from "./db.ts";

export type ClientKind = "service" | "anon";
type Factory = (kind: ClientKind, options?: Record<string, unknown>) => AdminClient;

let testFactory: Factory | null = null;

/** Tests only: route every client through a fake. Pass null to restore. */
export function setClientFactoryForTests(factory: Factory | null): void {
  testFactory = factory;
}

function make(kind: ClientKind, options?: Record<string, unknown>): AdminClient {
  if (testFactory) return testFactory(kind, options);
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = kind === "service" ? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! : Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, key, { auth: { persistSession: false }, ...(options ?? {}) });
}

/** Service-role client: bypasses RLS, so every caller must authorise first. */
export function serviceClient(): AdminClient {
  return make("service");
}

/** Anon-key client, optionally carrying the caller's JWT (global headers). */
export function anonClient(options?: Record<string, unknown>): AdminClient {
  return make("anon", options);
}
