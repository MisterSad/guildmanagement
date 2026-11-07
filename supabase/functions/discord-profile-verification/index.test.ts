// discord-profile-verification in rename-only mode (public.discord_channel_modes),
// run for real against the in-memory Supabase, with the AI provider and the
// Discord API scripted at the fetch boundary. What these tests pin is what the
// mode must NOT do: no role read, given or removed, no roster or account
// access, no message posted. Every database call and every outgoing request is
// recorded and compared with the exact list the mode is allowed.

import { assertEquals } from "jsr:@std/assert@1.0.14";
import { FakeSupabase, post, testEnv, uninstallFake } from "../_test/fake-supabase.ts";

const SECRET = "worker-secret-for-tests";
testEnv({
  OPENROUTER_API_KEY: "sk-or-v1-handlertestkeyhandlertest",
  DISCORD_BOT_TOKEN: "bot-token-for-tests",
  DISCORD_WORKER_SECRET: SECRET,
});
const { handler } = await import("./index.ts");

const SERVER = "1525831969710014625";
const CHANNEL = "1544654496536338542";
const USER = "1000000000000000001";
const MEMBER_PATH = `https://discord.com/api/v10/guilds/${SERVER}/members/${USER}`;

interface Outgoing {
  method: string;
  url: string;
  body: unknown;
}

const realFetch = globalThis.fetch;

/** Scripts OpenRouter and Discord; returns every Discord request made. */
function script(opts: {
  ocr: Record<string, unknown> | null;
  member?: { status: number; body?: unknown };
  patch?: { status: number; body?: unknown };
}): { discord: Outgoing[]; ai: number } {
  const seen = { discord: [] as Outgoing[], ai: 0 };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://openrouter.ai/")) {
      seen.ai++;
      return new Response(
        JSON.stringify({
          model: "google/gemini-3.8-flash",
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(opts.ocr) } }],
        }),
        { status: 200 }
      );
    }
    if (url.startsWith("https://discord.com/")) {
      const method = init?.method || "GET";
      seen.discord.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const answer =
        method === "PATCH" && url === MEMBER_PATH
          ? (opts.patch ?? { status: 200, body: {} })
          : method === "GET" && url === MEMBER_PATH
            ? (opts.member ?? { status: 200, body: { nick: null, roles: ["role-a"] } })
            : { status: 599, body: { unexpected: true } };
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return seen;
}

function setup(opts: { modeServer?: string; throttleAllowed?: boolean } = {}) {
  const fake = new FakeSupabase();
  fake.install();
  fake.rpcs["gm_check_verification_throttle"] = () => ({
    data: [{ allowed: opts.throttleAllowed !== false, remaining: 4 }],
    error: null,
  });
  fake
    .table("discord_channel_modes")
    .push({ channel_id: CHANNEL, discord_server_id: opts.modeServer ?? SERVER, mode: "rename_only" });
  return fake;
}

async function call(extra: Record<string, unknown> = {}) {
  const res = await handler(
    post(
      {
        discord_user_id: USER,
        discord_username: "someone",
        discord_server_id: SERVER,
        channel_id: CHANNEL,
        image_base64: "iVBORw0KGgo=",
        mime_type: "image/png",
        ...extra,
      },
      SECRET
    )
  );
  return { status: res.status, body: await res.json() };
}

/** The only database access rename-only mode may make. */
function assertOnlyModeAndThrottle(fake: FakeSupabase) {
  assertEquals(
    fake.calls.map((c) => `${c.kind}:${c.name}${c.op ? `:${c.op}` : ""}`),
    ["from:discord_channel_modes:select", "rpc:gm_check_verification_throttle"]
  );
}

function teardown() {
  globalThis.fetch = realFetch;
  uninstallFake();
}

const PROFILE = { pseudo: "Ace", guild_tag: "SB", server_number: "#1042", power: 123, glory: null, uid: "1917131" };

Deno.test("rename-only: the author is renamed and nothing else happens", async () => {
  const fake = setup();
  const seen = script({ ocr: PROFILE });
  try {
    const r = await call();
    assertEquals(r.status, 200);
    assertEquals(r.body, {
      ok: true,
      mode: "rename_only",
      nickname: "[SB] Ace #1042",
      previous_nickname: null,
      changed: true,
    });
    // One member read, one PATCH carrying `nick` and nothing else: no `roles`
    // key, so no role is given or removed; no role list, no channel message.
    assertEquals(seen.discord, [
      { method: "GET", url: MEMBER_PATH, body: null },
      { method: "PATCH", url: MEMBER_PATH, body: { nick: "[SB] Ace #1042" } },
    ]);
    assertOnlyModeAndThrottle(fake);
  } finally {
    teardown();
  }
});

Deno.test("rename-only: a guild named in the request changes nothing", async () => {
  const fake = setup();
  fake.table("guilds").push({ id: "TA", server_number: "1042" });
  fake.table("guild_config").push({ guild: "TA", key: "guild_tag", value: "SB" });
  const seen = script({ ocr: PROFILE });
  try {
    const r = await call({ fgf_guild: "TA" });
    assertEquals([r.status, r.body.mode, r.body.nickname], [200, "rename_only", "[SB] Ace #1042"]);
    assertEquals(
      seen.discord.map((d) => d.method),
      ["GET", "PATCH"]
    );
    assertOnlyModeAndThrottle(fake);
  } finally {
    teardown();
  }
});

Deno.test("rename-only: no tag on the screenshot gives 'Pseudo #Server', never [VISITOR]", async () => {
  const fake = setup();
  const seen = script({ ocr: { ...PROFILE, guild_tag: null } });
  try {
    const r = await call();
    assertEquals(r.body.nickname, "Ace #1042");
    assertEquals(seen.discord[1].body, { nick: "Ace #1042" });
    assertOnlyModeAndThrottle(fake);
  } finally {
    teardown();
  }
});

Deno.test("rename-only: a member who already has the nickname is not patched again", async () => {
  const fake = setup();
  const seen = script({ ocr: PROFILE, member: { status: 200, body: { nick: "[SB] Ace #1042", roles: [] } } });
  try {
    const r = await call();
    assertEquals([r.body.ok, r.body.changed], [true, false]);
    assertEquals(
      seen.discord.map((d) => d.method),
      ["GET"]
    );
    assertOnlyModeAndThrottle(fake);
  } finally {
    teardown();
  }
});

Deno.test("rename-only: a dry run decides but never patches", async () => {
  const fake = setup();
  const seen = script({ ocr: PROFILE, member: { status: 200, body: { nick: "old", roles: [] } } });
  try {
    const r = await call({ dry_run: true });
    assertEquals(r.body, {
      ok: true,
      mode: "rename_only",
      nickname: "[SB] Ace #1042",
      previous_nickname: "old",
      changed: false,
      dry_run: true,
    });
    assertEquals(
      seen.discord.map((d) => d.method),
      ["GET"]
    );
    assertOnlyModeAndThrottle(fake);
    assertEquals((await call({ dry_run: "yes" })).status, 400);
  } finally {
    teardown();
  }
});

Deno.test("rename-only: a member who left the server is skipped", async () => {
  const fake = setup();
  const seen = script({ ocr: PROFILE, member: { status: 404, body: { code: 10007 } } });
  try {
    const r = await call();
    assertEquals([r.status, r.body.error], [200, "member_not_found"]);
    assertEquals(seen.discord.length, 1);
    assertOnlyModeAndThrottle(fake);
  } finally {
    teardown();
  }
});

Deno.test("rename-only: a picture that is not a profile renames nobody", async () => {
  const fake = setup();
  const seen = script({ ocr: { pseudo: "Ace", guild_tag: "SB", uid: null } });
  try {
    const r = await call();
    assertEquals([r.status, r.body.error], [200, "missing_fields_in_ocr"]);
    assertEquals(seen.discord, []);
    assertOnlyModeAndThrottle(fake);
  } finally {
    teardown();
  }
});

Deno.test("rename-only: Discord's rate limit is reported with its delay", async () => {
  const fake = setup();
  script({ ocr: PROFILE, patch: { status: 429, body: { retry_after: 2.5 } } });
  try {
    const r = await call();
    assertEquals([r.status, r.body.error, r.body.retry_after], [429, "discord_rate_limited", 2.5]);
    assertOnlyModeAndThrottle(fake);
  } finally {
    teardown();
  }
});

Deno.test("rename-only: a member the bot cannot rename is reported, not retried", async () => {
  const fake = setup();
  script({ ocr: PROFILE, patch: { status: 403, body: { code: 50013 } } });
  try {
    const r = await call();
    assertEquals([r.status, r.body.error], [200, "cannot_rename"]);
    assertOnlyModeAndThrottle(fake);
  } finally {
    teardown();
  }
});

Deno.test("rename-only: the attempt throttle fails closed before any OCR", async () => {
  const fake = setup({ throttleAllowed: false });
  const seen = script({ ocr: PROFILE });
  try {
    const r = await call();
    assertEquals([r.status, r.body.error], [429, "rate_limited"]);
    assertEquals([seen.ai, seen.discord.length], [0, 0]);
    assertOnlyModeAndThrottle(fake);
  } finally {
    teardown();
  }
});

Deno.test("a mode row for another Discord server does not apply", async () => {
  const fake = setup({ modeServer: "1525831969710014699" });
  const seen = script({ ocr: PROFILE });
  try {
    const r = await call();
    // Not rename-only, and no guild: refused before any OCR or Discord call.
    assertEquals([r.status, r.body.error], [400, "missing_fields"]);
    assertEquals([seen.ai, seen.discord.length], [0, 0]);
    assertEquals(
      fake.calls.map((c) => c.name),
      ["discord_channel_modes"]
    );
  } finally {
    teardown();
  }
});

Deno.test("a request without the worker secret is refused before anything", async () => {
  const fake = setup();
  const seen = script({ ocr: PROFILE });
  try {
    const res = await handler(post({ discord_user_id: USER, discord_server_id: SERVER, channel_id: CHANNEL }, "nope"));
    assertEquals(res.status, 401);
    assertEquals([seen.ai, seen.discord.length, fake.calls.length], [0, 0, 0]);
  } finally {
    teardown();
  }
});
