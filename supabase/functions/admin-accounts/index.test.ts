// Runs the admin-accounts handler for real, against an in-memory Supabase
// (audit QA-01). These replace regex checks of the source with checks of what
// the function actually answers and writes.

import { assertEquals } from "jsr:@std/assert@1.0.14";
import { FakeSupabase, post, seedAccount, testEnv, uninstallFake } from "../_test/fake-supabase.ts";

testEnv();
const { handler } = await import("./index.ts");

function setup() {
  const fake = new FakeSupabase();
  fake.install();
  fake
    .table("guilds")
    .push(
      { id: "TA", server_number: "9001" },
      { id: "TB", server_number: "9001" },
      { id: "TC", server_number: "9002" }
    );
  const jwt = {
    super: seedAccount(fake, { id: "t_super", role: "super_admin" }),
    server: seedAccount(fake, { id: "t_server", role: "server_admin", server_number: "9001" }),
    adminA: seedAccount(fake, { id: "t_admin_a", role: "guild_admin", guild: "TA", server_number: "9001" }),
    member: seedAccount(fake, { id: "t_member_a", role: "member", guild: "TA", server_number: "9001" }),
    pending: seedAccount(fake, {
      id: "t_pending",
      role: "guild_admin",
      guild: "TB",
      server_number: "9001",
      status: "pending",
    }),
  };
  // gm_admin_upsert creates the row the rest of provisioning reads back.
  fake.rpcs["gm_admin_upsert"] = (a) => {
    fake.table("accounts").push({ id: a.p_id, role: a.p_role, guild: a.p_guild, status: "active", session_version: 0 });
    return { data: null, error: null };
  };
  return { fake, jwt };
}

async function call(body: unknown, jwt?: string) {
  const res = await handler(post(body, jwt));
  return { status: res.status, body: await res.json().catch(() => null) };
}

Deno.test("refuses a caller with no token, an unknown token, a member, or an inactive account", async () => {
  const { jwt } = setup();
  try {
    assertEquals((await call({ action: "list" })).status, 403);
    assertEquals((await call({ action: "list" }, "jwt-forged")).status, 403);
    assertEquals((await call({ action: "list" }, jwt.member)).status, 403);
    assertEquals((await call({ action: "list" }, jwt.pending)).status, 403);
  } finally {
    uninstallFake();
  }
});

Deno.test("answers 429 when the IP budget is spent, before reading the caller", async () => {
  const { fake, jwt } = setup();
  fake.rpcs["gm_check_ip_throttle"] = () => ({ data: [{ allowed: false, remaining: 0 }], error: null });
  try {
    assertEquals((await call({ action: "list" }, jwt.super)).status, 429);
    assertEquals(
      fake.calls.some((c) => c.kind === "auth" && c.name === "getUser"),
      false
    );
  } finally {
    uninstallFake();
  }
});

Deno.test("fails closed when the rate limiter cannot answer", async () => {
  const { fake, jwt } = setup();
  fake.rpcs["gm_check_ip_throttle"] = () => ({ data: null, error: { message: "db down" } });
  try {
    assertEquals((await call({ action: "list" }, jwt.super)).status, 429);
  } finally {
    uninstallFake();
  }
});

Deno.test("rejects an unknown action and a malformed body", async () => {
  const { jwt } = setup();
  try {
    assertEquals((await call({ action: "drop-everything" }, jwt.super)).body?.error, "unknown_action");
    assertEquals((await call({ action: "create" }, jwt.super)).body?.error, "missing_fields");
  } finally {
    uninstallFake();
  }
});

Deno.test("a guild admin can only create a guild admin of its own guild, whatever it asks for", async () => {
  const { fake, jwt } = setup();
  try {
    const r = await call({ action: "create", id: "new_officer", role: "super_admin", guild: "TB" }, jwt.adminA);
    assertEquals(r.status, 200);
    assertEquals(r.body?.ok, true);
    const upsert = fake.rpcCalls("gm_admin_upsert")[0];
    assertEquals(upsert.p_role, "guild_admin");
    assertEquals(upsert.p_guild, "TA");
  } finally {
    uninstallFake();
  }
});

Deno.test("a server admin cannot create an account for a guild of another server", async () => {
  const { fake, jwt } = setup();
  try {
    const r = await call({ action: "create", id: "outsider", role: "guild_admin", guild: "TC" }, jwt.server);
    assertEquals(r.status, 403);
    assertEquals(fake.rpcCalls("gm_admin_upsert").length, 0);
  } finally {
    uninstallFake();
  }
});

Deno.test("a server admin asking for super_admin gets a guild admin", async () => {
  const { fake, jwt } = setup();
  try {
    const r = await call({ action: "create", id: "elevated", role: "super_admin", guild: "TB" }, jwt.server);
    assertEquals(r.status, 200);
    assertEquals(fake.rpcCalls("gm_admin_upsert")[0].p_role, "guild_admin");
  } finally {
    uninstallFake();
  }
});

Deno.test("a guild admin lists only its own guild's accounts", async () => {
  const { fake, jwt } = setup();
  // gm_admin_list returns every account; the handler must narrow it.
  fake.rpcs["gm_admin_list"] = () => ({
    data: fake.table("accounts").map((a) => ({ id: a.id, role: a.role, guild: a.guild })),
    error: null,
  });
  try {
    const r = await call({ action: "list" }, jwt.adminA);
    const guilds = new Set((r.body?.accounts ?? []).map((a: { guild: string }) => a.guild));
    assertEquals([...guilds], ["TA"]);
  } finally {
    uninstallFake();
  }
});

Deno.test("a server admin lists the accounts of its server's guilds only", async () => {
  const { fake, jwt } = setup();
  fake
    .table("accounts")
    .push({ id: "t_admin_c", role: "guild_admin", guild: "TC", status: "active", session_version: 0 });
  fake.rpcs["gm_admin_list"] = () => ({
    data: fake
      .table("accounts")
      .map((a) => ({ id: a.id, role: a.role, guild: a.guild, server_number: a.server_number })),
    error: null,
  });
  try {
    const r = await call({ action: "list" }, jwt.server);
    const ids: string[] = (r.body?.accounts ?? []).map((a: { id: string }) => a.id);
    assertEquals(ids.includes("t_admin_c"), false);
    assertEquals(ids.includes("t_admin_a"), true);
  } finally {
    uninstallFake();
  }
});
