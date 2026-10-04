/**
 * supabase/functions/_test/characterize.ts
 *
 * Helpers for characterization tests (medium-term plan, M3): run a handler
 * with a frozen clock and record what it did -- every table read and write,
 * every RPC, every GoTrue admin call -- in a form that is identical from one
 * run to the next, so it can be pinned with assertSnapshot before a refactor
 * and compared after it.
 */

import type { FakeSupabase } from "./fake-supabase.ts";

const RealDate = Date;

/** Freezes `new Date()` and `Date.now()` at `iso`. Returns the restore function. */
export function freezeClock(iso: string): () => void {
  const fixed = new RealDate(iso).getTime();
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(fixed);
      // deno-lint-ignore no-explicit-any
      else super(...(args as [any]));
    }
    static override now() {
      return fixed;
    }
  }
  globalThis.Date = FrozenDate as DateConstructor;
  return () => {
    globalThis.Date = RealDate;
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function scrub(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v ?? null).replace(UUID, "<uuid>"));
}

/** A row EdgeLogger writes: logging, not behaviour, and never twice the same. */
function isLoggerRow(c: { kind: string; name: string; args?: unknown }): boolean {
  return (
    c.kind === "from" &&
    c.name === "system_audit_logs" &&
    !!c.args &&
    typeof c.args === "object" &&
    "correlation_id" in (c.args as Record<string, unknown>)
  );
}

/**
 * The calls a handler made, in order. EdgeLogger's own rows are left out:
 * they carry a random correlation id and a duration. Audit rows a handler
 * writes on purpose (an unlink, an invitation) are kept. Random ids are
 * replaced by "<uuid>".
 */
export function recordedCalls(fake: FakeSupabase): unknown[] {
  return fake.calls
    .filter((c) => !isLoggerRow(c))
    .map((c) => scrub({ kind: c.kind, name: c.name, op: c.op, args: c.args, filters: c.filters }));
}

/** A response, as status + parsed body, with random ids replaced. */
export async function recordedResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return scrub({ status: res.status, body });
}

/**
 * Makes crypto.getRandomValues deterministic (a fixed linear sequence), so
 * generated passwords and codes are the same on every run. Returns the
 * restore function. Never used outside tests.
 */
export function freezeRandom(): () => void {
  const real = crypto.getRandomValues.bind(crypto);
  let n = 7;
  // deno-lint-ignore no-explicit-any
  (crypto as any).getRandomValues = <T extends ArrayBufferView | null>(arr: T): T => {
    const bytes = new Uint8Array(
      (arr as unknown as ArrayBufferView).buffer,
      (arr as unknown as ArrayBufferView).byteOffset,
      (arr as unknown as ArrayBufferView).byteLength
    );
    for (let i = 0; i < bytes.length; i++) {
      n = (n * 73 + 41) % 251;
      bytes[i] = n;
    }
    return arr;
  };
  // deno-lint-ignore no-explicit-any
  return () => {
    (crypto as any).getRandomValues = real;
  };
}

/** Replaces fetch with a recorder answering `status`; returns the log and the restore function. */
export function stubFetch(status = 204): { sent: Array<{ url: string; body: unknown }>; restore: () => void } {
  const real = globalThis.fetch;
  const sent: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    let body: unknown = init?.body ?? null;
    try {
      body = JSON.parse(String(init?.body));
    } catch {
      /* keep raw */
    }
    sent.push({ url: String(url), body });
    return Promise.resolve(new Response(status === 204 ? null : "{}", { status }));
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}
