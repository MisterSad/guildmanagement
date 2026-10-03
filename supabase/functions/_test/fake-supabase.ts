/**
 * supabase/functions/_test/fake-supabase.ts
 *
 * An in-memory stand-in for the Supabase client, enough to RUN an Edge
 * Function handler under `deno test` (audit QA-01). Tables are arrays of rows;
 * a query applies its eq/neq/in/is filters, then select/insert/update/delete/
 * upsert, and resolves like PostgREST ({ data, error }). RPCs and GoTrue calls
 * are scripted per test. Every call is recorded in `calls`, so a test can
 * assert what the handler did, not only what it answered.
 *
 * Not deployed: `_test` is not a function directory (it starts with `_`).
 */

import type { AdminClient } from "../_shared/db.ts";
import { setClientFactoryForTests } from "../_shared/clients.ts";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };
export type RpcHandler = (args: Record<string, unknown>) => Result | Promise<Result>;

export interface Call {
  kind: "from" | "rpc" | "auth";
  name: string;
  op?: string;
  args?: unknown;
  filters?: Array<[string, string, unknown]>;
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {};
  rpcs: Record<string, RpcHandler> = {};
  /** jwt -> GoTrue user */
  users: Record<string, { id: string; email?: string; app_metadata?: Row }> = {};
  calls: Call[] = [];
  /** When set, signInWithPassword fails with this message. */
  signInError: string | null = null;

  constructor() {
    // Rate limits allow by default; a test that wants a 429 overrides it.
    this.rpcs["gm_check_ip_throttle"] = () => ({ data: [{ allowed: true, remaining: 99 }], error: null });
  }

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  rpcCalls(name: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.kind === "rpc" && c.name === name).map((c) => c.args as Record<string, unknown>);
  }

  client(): AdminClient {
    const fake = this;
    const client = {
      from: (name: string) => new Query(fake, name),
      rpc: (name: string, args: Record<string, unknown> = {}) => {
        fake.calls.push({ kind: "rpc", name, args });
        const h = fake.rpcs[name];
        const run = async (): Promise<Result> => (h ? await h(args) : { data: null, error: null });
        return thenable(run);
      },
      auth: {
        getUser: async (jwt: string) => {
          fake.calls.push({ kind: "auth", name: "getUser" });
          const user = fake.users[jwt];
          return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
        },
        // A shadow-session sign-in always succeeds unless a test scripts otherwise.
        signInWithPassword: async (creds: { email: string }) => {
          fake.calls.push({ kind: "auth", name: "signInWithPassword", args: { email: creds.email } });
          if (fake.signInError) return { data: { session: null }, error: { message: fake.signInError } };
          return { data: { session: { access_token: "access-test", refresh_token: "refresh-test", expires_at: 1790000000 } }, error: null };
        },
        admin: new Proxy({}, {
          get: (_t, method: string) => async (...args: unknown[]) => {
            fake.calls.push({ kind: "auth", name: `admin.${method}`, args });
            if (method === "createUser") return { data: { user: { id: crypto.randomUUID() } }, error: null };
            return { data: {}, error: null };
          },
        }),
      },
      storage: { from: () => new Proxy({}, { get: () => async () => ({ data: null, error: null }) }) },
      functions: { invoke: async () => ({ data: null, error: null }) },
    };
    return client as unknown as AdminClient;
  }

  /** Every createClient in the handler now returns this fake. */
  install(): void {
    setClientFactoryForTests(() => this.client());
  }
}

export function uninstallFake(): void {
  setClientFactoryForTests(null);
}

function thenable(run: () => Promise<Result>) {
  let p: Promise<Result> | null = null;
  const get = () => (p ??= run());
  const t = {
    then: (ok: (r: Result) => unknown, ko?: (e: unknown) => unknown) => get().then(ok, ko),
    single: () => thenable(async () => { const r = await get(); const d = Array.isArray(r.data) ? r.data[0] ?? null : r.data; return { data: d, error: d == null ? { message: "no rows" } : r.error }; }),
    maybeSingle: () => thenable(async () => { const r = await get(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; }),
    select: () => t,
  };
  return t;
}

/** A SQL LIKE pattern as PostgreSQL reads it: `%`, `_`, and `\` escaping either. */
function likeToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "is");
}

class Query {
  private op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: unknown = null;
  private filters: Array<[string, string, unknown]> = [];
  private one: "single" | "maybe" | null = null;
  private limitN: number | null = null;
  private wantCount = false;

  constructor(private fake: FakeSupabase, private name: string) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.wantCount = true;
    return this;
  }
  insert(v: unknown) { this.op = "insert"; this.payload = v; return this; }
  upsert(v: unknown) { this.op = "upsert"; this.payload = v; return this; }
  update(v: unknown) { this.op = "update"; this.payload = v; return this; }
  delete() { this.op = "delete"; return this; }

  eq(c: string, v: unknown) { this.filters.push([c, "eq", v]); return this; }
  neq(c: string, v: unknown) { this.filters.push([c, "neq", v]); return this; }
  in(c: string, v: unknown[]) { this.filters.push([c, "in", v]); return this; }
  is(c: string, v: unknown) { this.filters.push([c, "is", v]); return this; }
  ilike(c: string, v: string) { this.filters.push([c, "ilike", v]); return this; }
  gt(c: string, v: unknown) { this.filters.push([c, "gt", v]); return this; }
  gte(c: string, v: unknown) { this.filters.push([c, "gte", v]); return this; }
  lt(c: string, v: unknown) { this.filters.push([c, "lt", v]); return this; }
  lte(c: string, v: unknown) { this.filters.push([c, "lte", v]); return this; }
  // Accepted and recorded, not interpreted: the tests do not depend on them.
  like() { return this; }
  or() { return this; }
  not() { return this; }
  match(m: Row) { for (const [c, v] of Object.entries(m)) this.eq(c, v); return this; }
  order() { return this; }
  range() { return this; }
  limit(n: number) { this.limitN = n; return this; }
  single() { this.one = "single"; return this; }
  maybeSingle() { this.one = "maybe"; return this; }

  private matches(row: Row): boolean {
    return this.filters.every(([c, op, v]) => {
      const x = row[c];
      switch (op) {
        case "eq": return x === v;
        case "neq": return x !== v;
        case "in": return (v as unknown[]).includes(x);
        case "is": return x === v || (v === null && x === undefined);
        case "ilike": return likeToRegExp(String(v)).test(String(x ?? ""));
        case "gt": return (x as number) > (v as number);
        case "gte": return (x as number) >= (v as number);
        case "lt": return (x as number) < (v as number);
        case "lte": return (x as number) <= (v as number);
        default: return true;
      }
    });
  }

  private run(): Result {
    this.fake.calls.push({ kind: "from", name: this.name, op: this.op, args: this.payload, filters: this.filters });
    const rows = this.fake.table(this.name);
    let data: Row[] = [];
    if (this.op === "select") {
      data = rows.filter((r) => this.matches(r));
    } else if (this.op === "insert" || this.op === "upsert") {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      for (const it of items) rows.push({ ...it });
      data = items;
    } else if (this.op === "update") {
      data = rows.filter((r) => this.matches(r));
      for (const r of data) Object.assign(r, this.payload as Row);
    } else {
      data = rows.filter((r) => this.matches(r));
      this.fake.tables[this.name] = rows.filter((r) => !data.includes(r));
    }
    if (this.limitN != null) data = data.slice(0, this.limitN);
    const count = this.wantCount ? data.length : null;
    if (this.one === "single") return { data: data[0] ?? null, error: data.length ? null : { message: "no rows", code: "PGRST116" }, count };
    if (this.one === "maybe") return { data: data[0] ?? null, error: null, count };
    return { data, error: null, count };
  }

  then(ok: (r: Result) => unknown, ko?: (e: unknown) => unknown) {
    return Promise.resolve().then(() => this.run()).then(ok, ko);
  }
}

/** A POST with a JSON body and, optionally, a bearer token. */
export function post(body: unknown, jwt?: string, headers: Record<string, string> = {}): Request {
  return new Request("https://edge.test/fn", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://guildmanagement.vercel.app",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** Sets the environment every function reads at import time. */
export function testEnv(extra: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    GM_EDGE_TEST: "1",
    SUPABASE_URL: "https://fake.supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
    SUPABASE_ANON_KEY: "anon-test-key",
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
}

/** Seeds one account with its GoTrue identity; returns the JWT to use. */
export function seedAccount(fake: FakeSupabase, a: { id: string; role: string; guild?: string | null; server_number?: string | null; status?: string }): string {
  const authId = crypto.randomUUID();
  const jwt = `jwt-${a.id}`;
  fake.users[jwt] = { id: authId, app_metadata: { account_id: a.id, session_version: 0 } };
  fake.table("accounts").push({
    id: a.id, role: a.role, guild: a.guild ?? null, server_number: a.server_number ?? null,
    status: a.status ?? "active", session_version: 0, auth_user_id: authId,
  });
  return jwt;
}
