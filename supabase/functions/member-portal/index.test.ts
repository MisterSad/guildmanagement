// member-portal: validated actions, rate limit, and a caller resolved from
// the session only (audit ARC-03, BE-A-15).

import { assertEquals } from "jsr:@std/assert@1.0.14";
import { FakeSupabase, post, seedAccount, testEnv, uninstallFake } from "../_test/fake-supabase.ts";

testEnv();
const { handler } = await import("./index.ts");

Deno.test("refuses a body without an action; an unknown action never runs", async () => {
  const fake = new FakeSupabase();
  fake.install();
  try {
    const noAction = await handler(post({}));
    assertEquals(noAction.status, 400);
    assertEquals((await noAction.json()).error, "missing_action");
    // Without a session the caller is refused first (401); either way it does not run.
    const unknown = (await handler(post({ action: "drop-tables" }))).status;
    assertEquals(unknown === 400 || unknown === 401, true);
  } finally {
    uninstallFake();
  }
});

Deno.test("refuses a caller without a session", async () => {
  const fake = new FakeSupabase();
  fake.install();
  try {
    const res = await handler(post({ action: "get-absences", payload: {} }));
    assertEquals(res.status, 401);
  } finally {
    uninstallFake();
  }
});

Deno.test("is rate-limited before the caller is even resolved", async () => {
  const fake = new FakeSupabase();
  fake.install();
  fake.rpcs["gm_check_ip_throttle"] = () => ({ data: [{ allowed: false, remaining: 0 }], error: null });
  try {
    assertEquals((await handler(post({ action: "get-absences", payload: {} }, "jwt-anything"))).status, 429);
    assertEquals(
      fake.calls.some((c) => c.kind === "auth"),
      false
    );
  } finally {
    uninstallFake();
  }
});

// SEC2-01: an account that claimed no player used to be treated as the player
// whose UID equals its account id. A guild admin of another guild, created
// with id "1917131", could then request that player's transfer into its own
// guild, and read their metrics and KPIs.
Deno.test("an account with no claimed player is no player, whatever its id (SEC2-01)", async () => {
  const fake = new FakeSupabase();
  fake.install();
  fake.table("guilds").push({ id: "TA", server_number: "9001" }, { id: "EVIL", server_number: "9001" });
  fake.table("guild_members").push({ guild: "TA", pseudo: "Victim", uid: "1917131", role: "R1" });
  const jwt = seedAccount(fake, { id: "1917131", role: "guild_admin", guild: "EVIL", server_number: "9001" });
  try {
    for (const body of [
      { action: "submit-transfer-request", payload: { targetGuild: "EVIL" } },
      { action: "get-metrics-history", payload: {} },
      { action: "get-personal-kpis", payload: {} },
    ]) {
      const res = await handler(post(body, jwt));
      assertEquals(res.status, 403, body.action);
      assertEquals((await res.json()).error, "player_not_linked", body.action);
    }
    assertEquals(fake.rpcCalls("request_guild_transfer").length, 0);
    assertEquals(fake.rpcCalls("gm_get_player_metrics_history").length, 0);
    assertEquals(fake.rpcCalls("gm_personal_kpis").length, 0);
  } finally {
    uninstallFake();
  }
});
