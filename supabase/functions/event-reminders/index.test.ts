// event-reminders is a machine endpoint: only the cron secret or the service
// role may run it (audit SEC-06). Runs the handler for real.

import { assertEquals } from "jsr:@std/assert@1.0.14";
import { FakeSupabase, testEnv, uninstallFake } from "../_test/fake-supabase.ts";

testEnv({ CRON_SECRET: "cron-test-secret" });
const { handler } = await import("./index.ts");

function req(headers: Record<string, string>) {
  return new Request("https://edge.test/event-reminders", { method: "POST", headers, body: "{}" });
}

Deno.test("refuses a call without the cron secret, with a wrong one, or with a user JWT", async () => {
  const fake = new FakeSupabase();
  fake.install();
  try {
    assertEquals((await handler(req({}))).status, 401);
    assertEquals((await handler(req({ "x-cron-secret": "guess" }))).status, 401);
    assertEquals((await handler(req({ Authorization: "Bearer some.user.jwt" }))).status, 401);
    // Nothing was read before the refusal.
    assertEquals(fake.calls.filter((c) => c.kind === "from").length, 0);
  } finally { uninstallFake(); }
});

Deno.test("runs for the cron secret, and for the service role", async () => {
  const fake = new FakeSupabase();
  fake.install();
  try {
    assertEquals((await handler(req({ "x-cron-secret": "cron-test-secret" }))).status, 200);
    assertEquals((await handler(req({ Authorization: "Bearer service-role-test-key" }))).status, 200);
  } finally { uninstallFake(); }
});
