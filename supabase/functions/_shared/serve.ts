/**
 * supabase/functions/_shared/serve.ts
 *
 * Every Edge Function exports its `handler` and serves it through this, so a
 * test can import the module and call the handler directly (audit QA-01).
 * Under test (GM_EDGE_TEST set) nothing listens; in production it is
 * exactly Deno.serve.
 */

export function serveUnlessTest(handler: (req: Request) => Response | Promise<Response>): void {
  let underTest = false;
  try {
    underTest = Boolean(Deno.env.get("GM_EDGE_TEST"));
  } catch {
    /* no env permission: production */
  }
  if (underTest) return;
  Deno.serve(handler);
}
