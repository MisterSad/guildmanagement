// Characterization of admin-accounts (medium-term plan, M3): every action, for
// the roles that matter to it, against the same seeded tenants, with a frozen
// clock and frozen randomness. Each snapshot pins the response, every read,
// write, RPC and GoTrue admin call, and every Discord post. They were taken
// from the single-file handler before it was split into actions/.
//
// Regenerate only for an intended behaviour change:
//   deno test --allow-all supabase/functions/admin-accounts/scenarios.test.ts -- --update

import { assertSnapshot } from "jsr:@std/testing@1/snapshot";
import { FakeSupabase, post, seedAccount, testEnv, uninstallFake } from "../_test/fake-supabase.ts";
import { freezeClock, freezeRandom, recordedCalls, recordedResponse, stubFetch } from "../_test/characterize.ts";

testEnv({ DISCORD_BOT_TOKEN: "bot-test-token" });
const { handler } = await import("./index.ts");

type Who = "super" | "server" | "adminA" | "member" | "anonymous";

function seed() {
  const fake = new FakeSupabase();
  fake.install();
  fake.table("guilds").push({ id: "TA", server_number: "9001" }, { id: "TB", server_number: "9001" }, { id: "TC", server_number: "9002" });
  const jwt: Record<Exclude<Who, "anonymous">, string> = {
    super: seedAccount(fake, { id: "t_super", role: "super_admin" }),
    server: seedAccount(fake, { id: "t_server", role: "server_admin", server_number: "9001" }),
    adminA: seedAccount(fake, { id: "t_admin_a", role: "guild_admin", guild: "TA", server_number: "9001" }),
    member: seedAccount(fake, { id: "t_member_a", role: "member", guild: "TA", server_number: "9001" }),
  };
  seedAccount(fake, { id: "t_admin_b", role: "guild_admin", guild: "TB", server_number: "9001" });
  seedAccount(fake, { id: "t_pending", role: "member", guild: "TA", server_number: "9001", status: "pending" });
  fake.table("guild_config").push({ guild: "TA", key: "discord_audit_channel_id", value: "999000999000999000" });

  const ok = (data: unknown) => () => ({ data, error: null });
  fake.rpcs["gm_admin_list"] = () => ({ data: fake.table("accounts").map((a) => ({ id: a.id, role: a.role, guild: a.guild, server_number: a.server_number })), error: null });
  fake.rpcs["gm_admin_upsert"] = (a) => {
    if (fake.table("accounts").some((r) => r.id === a.p_id)) return { data: null, error: { message: "taken", code: "23505" } };
    fake.table("accounts").push({ id: a.p_id, role: a.p_role, guild: a.p_guild, status: "active", session_version: 0 });
    return { data: null, error: null };
  };
  fake.rpcs["gm_reset_account_password"] = ok([{ ok: true }]);
  fake.rpcs["gm_get_shadow"] = ok([{ auth_user_id: "00000000-0000-4000-8000-000000000001", gotrue_secret: "shadow-secret" }]);
  fake.rpcs["gm_discord_unlink"] = ok([{ ok: true, previous_discord_user_id: "123456789012345678", guild: "TA" }]);
  fake.rpcs["gm_issue_admin_invite"] = ok([{ ok: true, open_codes: 1 }]);
  fake.rpcs["gm_admin_delete"] = ok("00000000-0000-4000-8000-000000000002");
  fake.rpcs["gm_set_join_code"] = ok({ ok: true });
  fake.rpcs["gm_get_join_code"] = ok({ ok: true, code: "JOIN-1" });
  fake.rpcs["gm_approve_guild_request"] = ok([{ ok: true, guild_tag: "NEW", admin_id: "new_admin", server_number: "9001" }]);
  fake.rpcs["gm_reject_guild_request"] = ok({ ok: true });
  fake.table("guild_creation_requests").push(
    { id: "11111111-1111-4111-8111-111111111111", guild_tag: "NEW", status: "pending", created_at: "2026-10-01T00:00:00Z" },
    { id: "22222222-2222-4222-8222-222222222222", guild_tag: "OLD", status: "rejected", created_at: "2026-09-01T00:00:00Z" },
  );
  return { fake, jwt };
}

async function scenario(t: Deno.TestContext, body: unknown, who: Who) {
  const restoreClock = freezeClock("2026-10-07T10:00:00Z");
  const restoreRandom = freezeRandom();
  const discord = stubFetch(200);
  const { fake, jwt } = seed();
  try {
    const res = await handler(post(body, who === "anonymous" ? undefined : jwt[who]));
    await assertSnapshot(t, { response: await recordedResponse(res), calls: recordedCalls(fake), discord: discord.sent });
  } finally {
    uninstallFake();
    discord.restore();
    restoreRandom();
    restoreClock();
  }
}

const REQ = "11111111-1111-4111-8111-111111111111";

const cases: Array<[string, unknown, Who]> = [
  ["refused to a member", { action: "list" }, "member"],
  ["refused without a token", { action: "list" }, "anonymous"],
  ["backup-codes-status", { action: "backup-codes-status" }, "super"],
  ["backup-codes-regenerate", { action: "backup-codes-regenerate" }, "super"],
  ["backup codes refused to a guild admin", { action: "backup-codes-status" }, "adminA"],
  ["list as super admin", { action: "list" }, "super"],
  ["list as server admin", { action: "list" }, "server"],
  ["list as guild admin", { action: "list" }, "adminA"],
  ["reset-password", { action: "reset-password", id: "t_member_a" }, "adminA"],
  ["reset-password of another guild", { action: "reset-password", id: "t_admin_b" }, "adminA"],
  ["reset-password of nobody", { action: "reset-password", id: "ghost" }, "adminA"],
  ["discord-unlink", { action: "discord-unlink", id: "t_member_a" }, "adminA"],
  ["issue-admin-invite", { action: "issue-admin-invite", guild: "TA", role: "guild_admin" }, "adminA"],
  ["issue-admin-invite above the ceiling", { action: "issue-admin-invite", guild: "TA", role: "server_admin" }, "adminA"],
  ["issue-admin-invite out of scope", { action: "issue-admin-invite", guild: "TC", role: "guild_admin" }, "server"],
  ["create as guild admin, asking for more", { action: "create", id: "new_officer", role: "super_admin", guild: "TB" }, "adminA"],
  ["create as server admin, out of scope", { action: "create", id: "outsider", role: "guild_admin", guild: "TC" }, "server"],
  ["create as server admin, a member", { action: "create", id: "recruit", role: "member", guild: "TB" }, "server"],
  ["create a server admin as super admin", { action: "create", id: "srv2", role: "server_admin", guild: "TC" }, "super"],
  ["create a taken id", { action: "create", id: "t_super" }, "adminA"],
  ["update-role", { action: "update-role", id: "t_admin_b", role: "server_admin" }, "super"],
  ["update-role refused to a guild admin", { action: "update-role", id: "t_member_a", role: "guild_admin" }, "adminA"],
  ["delete", { action: "delete", id: "t_member_a" }, "adminA"],
  ["delete out of scope", { action: "delete", id: "t_admin_b" }, "adminA"],
  ["update-guild", { action: "update-guild", id: "t_member_a", guild: "TB" }, "super"],
  ["update-guild out of scope", { action: "update-guild", id: "t_member_a", guild: "TC" }, "server"],
  ["set-join-code", { action: "set-join-code", guild: "TB", code: "HELLO" }, "adminA"],
  ["get-join-code", { action: "get-join-code", guild: "TB" }, "server"],
  ["get-join-code out of scope", { action: "get-join-code", guild: "TC" }, "server"],
  ["reject-registration", { action: "reject-registration", id: "t_pending" }, "adminA"],
  ["list-guild-requests", { action: "list-guild-requests" }, "super"],
  ["list-guild-requests refused", { action: "list-guild-requests" }, "server"],
  ["clear-resolved-guild-requests", { action: "clear-resolved-guild-requests" }, "super"],
  ["approve-guild-request", { action: "approve-guild-request", id: REQ }, "super"],
  ["reject-guild-request", { action: "reject-guild-request", id: REQ, reason: "duplicate" }, "super"],
  ["an unknown action", { action: "drop-everything" }, "super"],
];

for (const [name, body, who] of cases) {
  Deno.test(`admin-accounts: ${name}`, (t) => scenario(t, body, who));
}
