// ARC-04: the set-webhook action is the only writer of webhook URLs. Runs the
// handler against the in-memory Supabase.

import { assertEquals } from "jsr:@std/assert@1.0.14";
import { FakeSupabase, post, seedAccount, testEnv, uninstallFake } from "../_test/fake-supabase.ts";

testEnv();
const { handler, isWebhookKey } = await import("./index.ts");

const GOOD = "https://discord.com/api/webhooks/123456789/abc_DEF-ghi";

function setup() {
  const fake = new FakeSupabase();
  fake.install();
  fake.table("guilds").push({ id: "TA", server_number: "9001" }, { id: "TB", server_number: "9001" }, { id: "TC", server_number: "9002" });
  const jwt = {
    super: seedAccount(fake, { id: "t_super", role: "super_admin" }),
    server: seedAccount(fake, { id: "t_server", role: "server_admin", server_number: "9001" }),
    adminA: seedAccount(fake, { id: "t_admin_a", role: "guild_admin", guild: "TA", server_number: "9001" }),
    member: seedAccount(fake, { id: "t_member_a", role: "member", guild: "TA", server_number: "9001" }),
  };
  return { fake, jwt };
}

async function call(body: unknown, jwt?: string) {
  const res = await handler(post(body, jwt));
  return { status: res.status, body: await res.json().catch(() => null) };
}

const config = (fake: FakeSupabase, guild: string, key: string) =>
  fake.table("guild_config").find((r) => r.guild === guild && r.key === key)?.value;

Deno.test("isWebhookKey matches public.gm_is_webhook_key", () => {
  assertEquals(isWebhookKey("discord_webhook_url"), true);
  assertEquals(isWebhookKey("webhook_gvg"), true);
  assertEquals(isWebhookKey("webhook_svs_opponent"), true);
  assertEquals(isWebhookKey("coeff_svs"), false);
  assertEquals(isWebhookKey("webhook_"), false);
});

Deno.test("a guild admin sets, cleans and removes its own guild's webhook", async () => {
  const { fake, jwt } = setup();
  try {
    let r = await call({ action: "set-webhook", guild: "TA", key: "webhook_gvg", url: `<${GOOD}>` }, jwt.adminA);
    assertEquals([r.status, r.body?.configured], [200, true]);
    assertEquals(config(fake, "TA", "webhook_gvg"), GOOD);
    r = await call({ action: "set-webhook", guild: "TA", key: "webhook_gvg", url: "" }, jwt.adminA);
    assertEquals([r.status, r.body?.configured], [200, false]);
    assertEquals(config(fake, "TA", "webhook_gvg"), undefined);
  } finally { uninstallFake(); }
});

Deno.test("only Discord webhook URLs are stored", async () => {
  const { fake, jwt } = setup();
  try {
    for (const url of ["https://evil.example/api/webhooks/1/x", "http://discord.com/api/webhooks/1/x", "https://discord.com/api/channels/1"]) {
      const r = await call({ action: "set-webhook", guild: "TA", key: "webhook_gvg", url }, jwt.adminA);
      assertEquals([r.status, r.body?.error], [400, "invalid_discord_webhook_url"], url);
    }
    assertEquals(fake.table("guild_config").length, 0);
  } finally { uninstallFake(); }
});

Deno.test("a non-webhook key, an extra field or a missing guild is refused", async () => {
  const { fake, jwt } = setup();
  try {
    assertEquals((await call({ action: "set-webhook", guild: "TA", key: "coeff_svs", url: GOOD }, jwt.adminA)).status, 400);
    assertEquals((await call({ action: "set-webhook", guild: "TA", key: "webhook_gvg", url: GOOD, value: "x" }, jwt.adminA)).status, 400);
    assertEquals((await call({ action: "set-webhook", guild: "NOPE", key: "webhook_gvg", url: GOOD }, jwt.super)).status, 403);
    assertEquals(fake.table("guild_config").length, 0);
  } finally { uninstallFake(); }
});

Deno.test("the caller's scope decides, not the request", async () => {
  const { fake, jwt } = setup();
  try {
    assertEquals((await call({ action: "set-webhook", guild: "TB", key: "webhook_gvg", url: GOOD }, jwt.adminA)).status, 403);
    assertEquals((await call({ action: "set-webhook", guild: "TC", key: "webhook_gvg", url: GOOD }, jwt.server)).status, 403);
    assertEquals((await call({ action: "set-webhook", guild: "TA", key: "webhook_gvg", url: GOOD }, jwt.member)).status, 403);
    assertEquals((await call({ action: "set-webhook", guild: "TA", key: "webhook_gvg", url: GOOD })).status, 403);
    assertEquals(fake.table("guild_config").length, 0);
    assertEquals((await call({ action: "set-webhook", guild: "TB", key: "webhook_gvg", url: GOOD }, jwt.server)).status, 200);
    assertEquals((await call({ action: "set-webhook", guild: "TC", key: "webhook_gvg", url: GOOD }, jwt.super)).status, 200);
  } finally { uninstallFake(); }
});

Deno.test("set-webhook is rate-limited and fails closed", async () => {
  const { fake, jwt } = setup();
  fake.rpcs["gm_check_ip_throttle"] = () => ({ data: null, error: { message: "db down" } });
  try {
    assertEquals((await call({ action: "set-webhook", guild: "TA", key: "webhook_gvg", url: GOOD }, jwt.adminA)).status, 429);
    assertEquals(fake.table("guild_config").length, 0);
  } finally { uninstallFake(); }
});
