// member-portal: validated actions, rate limit, and a caller resolved from
// the session only (audit ARC-03, BE-A-15).

import { assertEquals } from "jsr:@std/assert@1.0.14";
import { FakeSupabase, post, testEnv, uninstallFake } from "../_test/fake-supabase.ts";

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
