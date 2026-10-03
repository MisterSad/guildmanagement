// resolveCaller is the one place every Edge Function learns who is calling
// (audit ARC-03). These run it for real: they replace the regex checks that
// each function "imports validateCallerAuth" or "checks the status".

import { assertEquals } from "jsr:@std/assert@1.0.14";
import { FakeSupabase, testEnv, uninstallFake } from "../_test/fake-supabase.ts";

testEnv();
const { resolveCaller, officerAccountsForDiscord } = await import("./auth.ts");

/** A JWT-shaped token whose payload carries a session_version, like GoTrue's. */
function token(sessionVersion: number | null): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const meta = sessionVersion === null ? {} : { session_version: sessionVersion };
  return `${b64({ alg: "HS256" })}.${b64({ sub: "x", app_metadata: meta })}.sig`;
}

function req(jwt?: string) {
  return new Request("https://edge.test/x", { method: "POST", headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} });
}

function setup(account: Record<string, unknown>, jwt: string) {
  const fake = new FakeSupabase();
  fake.install();
  fake.table("guilds").push({ id: "TA", server_number: "9001" });
  fake.users[jwt] = { id: "auth-1" };
  fake.table("accounts").push({ id: "acc", auth_user_id: "auth-1", status: "active", session_version: 2, ...account });
  return fake;
}

Deno.test("no token, or a token GoTrue rejects: nobody", async () => {
  const fake = setup({ role: "guild_admin", guild: "TA" }, "known");
  try {
    assertEquals((await resolveCaller(req())).role, null);
    assertEquals((await resolveCaller(req("forged"))).role, null);
    assertEquals(fake.calls.some((c) => c.kind === "from" && c.name === "accounts"), false);
  } finally { uninstallFake(); }
});

Deno.test("an authentic token without an account is authenticated, authorised for nothing", async () => {
  const fake = new FakeSupabase();
  fake.install();
  fake.users["t"] = { id: "orphan" };
  try {
    const c = await resolveCaller(req("t"));
    assertEquals([c.authenticated, c.role], [true, null]);
  } finally { uninstallFake(); }
});

Deno.test("M14: a suspended or pending account gets no role, and the status says why", async () => {
  const t = token(2);
  setup({ role: "super_admin", status: "suspended" }, t);
  try {
    const c = await resolveCaller(req(t));
    assertEquals([c.role, c.active, c.status], [null, false, "suspended"]);
  } finally { uninstallFake(); }
});

Deno.test("C1: a token older than session_version is refused; the current one and a legacy one pass", async () => {
  const stale = token(1), current = token(2), legacy = token(null);
  const fake = setup({ role: "guild_admin", guild: "TA" }, stale);
  fake.users[current] = { id: "auth-1" };
  fake.users[legacy] = { id: "auth-1" };
  try {
    const s = await resolveCaller(req(stale));
    assertEquals([s.role, s.sessionRevoked], [null, true]);
    assertEquals((await resolveCaller(req(current))).role, "guild_admin");
    assertEquals((await resolveCaller(req(legacy))).role, "guild_admin");
  } finally { uninstallFake(); }
});

Deno.test("the role is normalised: a legacy rank grants nothing", async () => {
  const t = token(2);
  setup({ role: "R5", guild: "TA" }, t);
  try {
    assertEquals((await resolveCaller(req(t))).role, "member");
  } finally { uninstallFake(); }
});

Deno.test("the server is derived from the guild, and the UID is reported", async () => {
  const t = token(2);
  setup({ role: "member", guild: "TA", server_number: null, uid: "7000001" }, t);
  try {
    const c = await resolveCaller(req(t));
    assertEquals([c.serverNumber, c.uid, c.guild], ["9001", "7000001", "TA"]);
  } finally { uninstallFake(); }
});

Deno.test("officers for a Discord identity: active, above member, nothing else", async () => {
  const fake = new FakeSupabase();
  fake.install();
  fake.table("guilds").push({ id: "TA", server_number: "9001" });
  fake.table("discord_account_links").push(
    { discord_user_id: "d1", account_id: "officer" },
    { discord_user_id: "d1", account_id: "player" },
    { discord_user_id: "d1", account_id: "gone" },
  );
  fake.table("accounts").push(
    { id: "officer", role: "guild_admin", guild: "TA", status: "active" },
    { id: "player", role: "member", guild: "TA", status: "active" },
    { id: "gone", role: "guild_admin", guild: "TA", status: "suspended" },
  );
  try {
    const out = await officerAccountsForDiscord(fake.client(), "d1");
    assertEquals(out.map((o) => [o.id, o.role, o.serverNumber]), [["officer", "guild_admin", "9001"]]);
    assertEquals(await officerAccountsForDiscord(fake.client(), "nobody"), []);
  } finally { uninstallFake(); }
});
