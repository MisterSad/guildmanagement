// tickets: admins only, bounded input, rate-limited creation (audit BE-A-15).

import { assertEquals } from "jsr:@std/assert@1.0.14";
import { FakeSupabase, post, seedAccount, testEnv, uninstallFake } from "../_test/fake-supabase.ts";

testEnv();
const { handler } = await import("./index.ts");

function setup() {
  const fake = new FakeSupabase();
  fake.install();
  const admin = seedAccount(fake, { id: "t_admin_a", role: "guild_admin", guild: "TA", server_number: "9001" });
  const member = seedAccount(fake, { id: "t_member_a", role: "member", guild: "TA", server_number: "9001" });
  fake.rpcs["gm_create_ticket"] = () => ({ data: [{ ticket_number: 1, id: 1, status: "waiting" }], error: null });
  return { fake, admin, member };
}

const valid = { action: "create", title: "Broken", description: "It broke", category: "bug", severity: "low" };

Deno.test("refuses anyone who is not an administrator", async () => {
  const { member } = setup();
  try {
    assertEquals((await handler(post(valid))).status, 403);
    assertEquals((await handler(post(valid, member))).status, 403);
  } finally {
    uninstallFake();
  }
});

Deno.test("refuses an oversized or malformed ticket before writing anything", async () => {
  const { fake, admin } = setup();
  try {
    assertEquals((await handler(post({ ...valid, title: "x".repeat(301) }, admin))).status, 400);
    assertEquals((await handler(post({ ...valid, description: "" }, admin))).status, 400);
    assertEquals(
      (await handler(post({ ...valid, attachments: Array(11).fill("data:image/png;base64,AA") }, admin))).status,
      400
    );
    assertEquals(fake.rpcCalls("gm_create_ticket").length, 0);
  } finally {
    uninstallFake();
  }
});

Deno.test("creation is rate-limited", async () => {
  const { fake, admin } = setup();
  fake.rpcs["gm_check_ip_throttle"] = () => ({ data: [{ allowed: false, remaining: 0 }], error: null });
  try {
    assertEquals((await handler(post(valid, admin))).status, 429);
    assertEquals(fake.rpcCalls("gm_create_ticket").length, 0);
  } finally {
    uninstallFake();
  }
});

Deno.test("a ticket cannot name its own reporter: the schema is strict", async () => {
  const { fake, admin } = setup();
  try {
    assertEquals((await handler(post({ ...valid, reporter_account_id: "someone_else" }, admin))).status, 400);
    assertEquals(fake.rpcCalls("gm_create_ticket").length, 0);
  } finally {
    uninstallFake();
  }
});

Deno.test("a valid ticket is created with the caller as reporter", async () => {
  const { fake, admin } = setup();
  try {
    const res = await handler(post(valid, admin));
    assertEquals(res.status, 200);
    const args = fake.rpcCalls("gm_create_ticket")[0];
    assertEquals(args.p_reporter_account_id, "t_admin_a");
  } finally {
    uninstallFake();
  }
});
