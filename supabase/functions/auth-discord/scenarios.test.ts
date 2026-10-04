// Characterization of auth-discord (medium-term plan, M3): the OAuth round
// trip with Discord stubbed, and every POST action on its success and refusal
// paths, with a frozen clock and frozen randomness. Each snapshot pins the
// response (redirects included), every database call, RPC and GoTrue call,
// and every request sent to Discord. They were taken from the single-file
// handler before it was split by route.
//
// Regenerate only for an intended behaviour change:
//   deno test --allow-all supabase/functions/auth-discord/scenarios.test.ts -- --update

import { assertSnapshot } from "jsr:@std/testing@1/snapshot";
import { FakeSupabase, seedAccount, testEnv, uninstallFake } from "../_test/fake-supabase.ts";
import { freezeClock, freezeRandom, recordedCalls, recordedResponse } from "../_test/characterize.ts";
import { normalizeBackupCode, randomBackupCode, sha256Hex } from "../_shared/backup-codes.ts";

const APP = "https://guildmanagement.vercel.app";
testEnv({
  DISCORD_CLIENT_ID: "client-test",
  DISCORD_CLIENT_SECRET: "client-secret-test",
  DISCORD_OAUTH_REDIRECT_URI: "https://fake.supabase.test/functions/v1/auth-discord/callback",
  APP_DEFAULT_ORIGIN: APP,
  DISCORD_BOT_TOKEN: "bot-test-token",
});
const { handler } = await import("./index.ts");

const BASE = "https://fake.supabase.test/functions/v1/auth-discord";
const D_ONE = "100000000000000001"; // one linked account
const D_TWO = "100000000000000002"; // two linked accounts
const D_NONE = "100000000000000003"; // no account yet
const TICKET = (n: string) => `ticket-${n}-0123456789abcdef`;
const TICKETS: Record<string, string> = {
  [TICKET("one")]: D_ONE,
  [TICKET("two")]: D_TWO,
  [TICKET("none")]: D_NONE,
};

async function seed() {
  const fake = new FakeSupabase();
  fake.install();
  fake.table("guilds").push({ id: "TA", server_number: "9001" });
  seedAccount(fake, { id: "t_super", role: "super_admin" });
  seedAccount(fake, { id: "t_admin_a", role: "guild_admin", guild: "TA", server_number: "9001" });
  seedAccount(fake, { id: "t_member_a", role: "member", guild: "TA", server_number: "9001" });
  fake
    .table("discord_account_links")
    .push(
      { discord_user_id: D_ONE, account_id: "t_member_a" },
      { discord_user_id: D_TWO, account_id: "t_admin_a" },
      { discord_user_id: D_TWO, account_id: "t_member_a" }
    );
  fake.table("guild_config").push({ guild: "TA", key: "discord_audit_channel_id", value: "999000999000999000" });

  const backupCode = randomBackupCode();
  fake
    .table("account_backup_codes")
    .push({ account_id: "t_super", code_hash: await sha256Hex(normalizeBackupCode(backupCode)), used_at: null });
  fake.table("account_link_codes").push({
    code_hash: await sha256Hex(normalizeBackupCode("RELINK-CODE-1")),
    kind: "relink",
    used_at: null,
    expires_at: "2026-12-01T00:00:00Z",
  });

  const ok = (data: unknown) => () => ({ data, error: null });
  fake.rpcs["gm_consume_discord_oauth_state"] = (a) => ({
    data: a.p_state === "good-state" ? [{ origin: APP, code_verifier: "verifier-test" }] : [],
    error: null,
  });
  fake.rpcs["gm_consume_discord_auth_ticket"] = (a) => {
    const id = TICKETS[String(a.p_ticket)];
    return {
      data: id ? [{ discord_user_id: id, discord_username: "ace", display_name: "Ace", attempts: 1 }] : [],
      error: null,
    };
  };
  fake.rpcs["gm_get_shadow"] = ok([
    { auth_user_id: "00000000-0000-4000-8000-000000000003", gotrue_secret: "shadow-secret" },
  ]);
  fake.rpcs["gm_check_discord_throttle"] = ok([{ allowed: true }]);
  fake.rpcs["gm_claim_account_with_discord"] = (a) => ({
    data:
      a.p_id === "t_super"
        ? [{ ok: true, account_id: "t_super", role: "super_admin" }]
        : [{ ok: false, err: "invalid_credentials" }],
    error: null,
  });
  fake.rpcs["gm_discord_join_guild"] = ok([
    { ok: true, account_id: "newbie", role: "member", status: "pending", guild: "TA" },
  ]);
  fake.rpcs["gm_discord_create_guild"] = ok([{ ok: false, err: "tag_taken" }]);
  fake.rpcs["gm_redeem_relink_code"] = ok([{ ok: true, account_id: "t_admin_a", role: "guild_admin", guild: "TA" }]);
  return { fake, backupCode };
}

function stubDiscord() {
  const real = globalThis.fetch;
  const sent: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body =
      init?.body instanceof URLSearchParams
        ? Object.fromEntries(init.body)
        : init?.body
          ? JSON.parse(String(init.body))
          : null;
    sent.push({ url: u, body });
    if (u.endsWith("/oauth2/token")) return Promise.resolve(Response.json({ access_token: "discord-access" }));
    if (u.endsWith("/users/@me"))
      return Promise.resolve(Response.json({ id: D_ONE, username: "ace", global_name: "Ace" }));
    return Promise.resolve(Response.json({ id: "msg-1" }));
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

async function scenario(t: Deno.TestContext, request: (ctx: { backupCode: string }) => Request) {
  const restoreClock = freezeClock("2026-10-07T10:00:00Z");
  const restoreRandom = freezeRandom();
  const discord = stubDiscord();
  const { fake, backupCode } = await seed();
  try {
    const res = await handler(request({ backupCode }));
    const location = res.headers.get("Location");
    await assertSnapshot(t, {
      response: await recordedResponse(res),
      location,
      calls: recordedCalls(fake),
      discord: discord.sent,
    });
  } finally {
    uninstallFake();
    discord.restore();
    restoreRandom();
    restoreClock();
  }
}

const get = (path: string) => () => new Request(`${BASE}${path}`, { method: "GET" });
const act = (body: unknown) => () =>
  new Request(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: APP },
    body: JSON.stringify(body),
  });

const cases: Array<[string, (ctx: { backupCode: string }) => Request]> = [
  ["start from the app", get(`/start?origin=${encodeURIComponent(APP)}`)],
  ["start from an untrusted origin", get("/start?origin=https%3A%2F%2Fevil.example")],
  ["callback with an unknown state", get("/callback?state=forged&code=c")],
  ["callback declined by the user", get("/callback?state=good-state&error=access_denied")],
  ["callback that completes", get("/callback?state=good-state&code=discord-code")],
  ["redeem with one linked account", act({ action: "redeem", ticket: TICKET("one") })],
  ["redeem with two linked accounts", act({ action: "redeem", ticket: TICKET("two") })],
  ["redeem with no account", act({ action: "redeem", ticket: TICKET("none") })],
  ["redeem a spent ticket", act({ action: "redeem", ticket: TICKET("spent") })],
  ["choose a linked account", act({ action: "choose", ticket: TICKET("two"), account_id: "t_admin_a" })],
  ["choose an account that is not linked", act({ action: "choose", ticket: TICKET("two"), account_id: "t_super" })],
  ["claim as the super admin", act({ action: "claim", ticket: TICKET("none"), id: "t_super", password: "pw" })],
  ["claim with a wrong password", act({ action: "claim", ticket: TICKET("none"), id: "t_member_a", password: "nope" })],
  [
    "onboard by join code",
    act({ action: "onboard", mode: "join", ticket: TICKET("none"), join_code: "HELLO", uid: "424242" }),
  ],
  [
    "onboard by creating a taken tag",
    act({ action: "onboard", mode: "create", ticket: TICKET("none"), guild_tag: "TA", server_number: "9001" }),
  ],
  ["redeem-code with a relink code", act({ action: "redeem-code", ticket: TICKET("none"), code: "relink-code-1" })],
  ["redeem-code with an unknown code", act({ action: "redeem-code", ticket: TICKET("none"), code: "nothing-here" })],
  ["backup-login", ({ backupCode }) => act({ action: "backup-login", id: "t_super", code: backupCode })()],
  [
    "backup-login for a guild admin",
    ({ backupCode }) => act({ action: "backup-login", id: "t_admin_a", code: backupCode })(),
  ],
  ["an unknown action", act({ action: "link" })],
  ["a body that is not JSON", () => new Request(BASE, { method: "POST", body: "{" })],
  ["an unknown route", get("/elsewhere")],
];

for (const [name, request] of cases) {
  Deno.test(`auth-discord: ${name}`, (t) => scenario(t, request));
}
