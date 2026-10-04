// Characterization of member-portal (medium-term plan, M3): every action, run
// against the same seeded guild with a frozen clock, and pinned -- response,
// then every read, write and RPC in order. The snapshots were taken from the
// single-file handler before it was split into actions/.
//
// Regenerate only for an intended behaviour change:
//   deno test --allow-all supabase/functions/member-portal/scenarios.test.ts -- --update

import { assertSnapshot } from "jsr:@std/testing@1/snapshot";
import { FakeSupabase, post, seedAccount, testEnv, uninstallFake } from "../_test/fake-supabase.ts";
import { freezeClock, recordedCalls, recordedResponse } from "../_test/characterize.ts";

testEnv();
const { handler } = await import("./index.ts");

function seed() {
  const fake = new FakeSupabase();
  fake.install();
  fake.table("guilds").push({ id: "TA", server_number: "9001" }, { id: "TB", server_number: "9001" });
  const jwt = {
    player: seedAccount(fake, { id: "p_ace", role: "member", guild: "TA", server_number: "9001" }),
    stranger: seedAccount(fake, { id: "p_none", role: "member", guild: "TB", server_number: "9001" }),
  };
  fake.table("accounts").find((a) => a.id === "p_ace")!.uid = "U1";
  fake.table("guild_members").push(
    {
      uid: "U1",
      pseudo: "Ace",
      guild: "TA",
      overall_power: 1000,
      tech_power: 10,
      champion_power: 20,
      crew_power: 30,
      flagship_power: 40,
      fleet_rating: 50,
      glory_score: 5,
      role: "R2",
      timezone_offset: 1,
      timezone: "Europe/Paris",
      created_at: "2026-01-01T00:00:00Z",
    },
    {
      uid: "U2",
      pseudo: "Bee",
      guild: "TA",
      overall_power: 3000,
      tech_power: 30,
      champion_power: 0,
      crew_power: 0,
      flagship_power: 0,
      fleet_rating: 70,
      glory_score: 9,
      role: "R1",
    }
  );
  fake.table("event_status").push(
    {
      guild: "TA",
      event_name: "Arms Race Stage A",
      session_id: "s1",
      is_active: true,
      start_at: "2026-10-05T12:00:00Z",
    },
    { guild: "TA", event_name: "GvG", session_id: "w1", is_active: true, start_at: "2026-10-05T00:00:00Z" },
    { guild: "TA", event_name: "Defend Trade Route", session_id: "s2", is_active: true, start_at: null },
    { guild: "TA", event_name: "Arms Race Stage B", session_id: "old", is_active: false, start_at: null }
  );
  fake.table("event_participants").push(
    {
      guild: "TA",
      event_name: "Arms Race Stage A",
      session_id: "s1",
      pseudo: "Ace",
      is_pending: false,
      participated: 0,
      score: 0,
      score_prep: 0,
      score_pvp: 0,
      week_start: "2026-10-05",
    },
    {
      guild: "TA",
      event_name: "GvG",
      session_id: "w1",
      pseudo: "Ace",
      is_pending: false,
      participated: 0,
      score: 0,
      score_prep: 0,
      score_pvp: 0,
      week_start: "2026-10-05",
    },
    {
      guild: "TA",
      event_name: "Arms Race Stage B",
      session_id: "old",
      pseudo: "Ace",
      is_pending: false,
      participated: 1,
      score: 900,
      score_prep: 0,
      score_pvp: 0,
      week_start: "2026-09-28",
    },
    {
      guild: "TA",
      event_name: "Glory",
      session_id: null,
      pseudo: "Ace",
      is_pending: false,
      participated: 1,
      score: 4000,
      week_start: "2026-10-05",
    }
  );
  fake.table("war_sessions").push({ guild: "TA", event_name: "GvG", session_id: "w1" });
  const ok = (data: unknown) => () => ({ data, error: null });
  fake.rpcs["gm_upsert_daily_scores"] = ok([{ ok: true }]);
  fake.rpcs["gm_upsert_player_metrics"] = ok([{ ok: true }]);
  fake.rpcs["gm_get_player_metrics_history"] = ok([{ ok: true, history: [{ week: "2026-09-28", power: 900 }] }]);
  fake.rpcs["gm_list_transfer_eligible_guilds"] = ok([{ id: "TB", name: "Beta" }]);
  fake.rpcs["request_guild_transfer"] = ok({ ok: true, request_id: 7 });
  fake.rpcs["gm_player_session_guild_stats"] = ok([
    { session_key: "ARMS RACE STAGE B|old", total_score: 1800, counted: 2, max_score: 900 },
  ]);
  fake.rpcs["gm_personal_kpis"] = ok([{ ok: true, density: 0.5, combativity: 2 }]);
  fake.rpcs["gm_player_stats"] = ok({
    ok: true,
    weeks: 4,
    player: { rate: 50 },
    guild_totals: { rate: 40 },
    glory: [4000],
  });
  return { fake, jwt };
}

async function scenario(t: Deno.TestContext, body: unknown, who: "player" | "stranger" | "anonymous" = "player") {
  const restore = freezeClock("2026-10-07T10:00:00Z");
  const { fake, jwt } = seed();
  try {
    const res = await handler(post(body, who === "anonymous" ? undefined : jwt[who]));
    await assertSnapshot(t, { response: await recordedResponse(res), calls: recordedCalls(fake) });
  } finally {
    uninstallFake();
    restore();
  }
}

const cases: Array<[string, unknown, ("player" | "stranger" | "anonymous")?]> = [
  ["get-active-sessions", { action: "get-active-sessions" }],
  ["get-active-sessions without a player", { action: "get-active-sessions" }, "stranger"],
  [
    "submit-scores",
    {
      action: "submit-scores",
      payload: { event_name: "Arms Race Stage A", session_id: "s1", score: "1,234", late: true, participated: true },
    },
  ],
  [
    "submit-scores on a war session",
    {
      action: "submit-scores",
      payload: { event_name: "GvG", session_id: "w1", score_prep: 100, score_pvp: "200", participated: true },
    },
  ],
  [
    "submit-scores on an inactive session",
    { action: "submit-scores", payload: { event_name: "Arms Race Stage B", session_id: "old", score: 1 } },
  ],
  [
    "submit-scores outside the session",
    { action: "submit-scores", payload: { event_name: "Defend Trade Route", session_id: "s2", participated: true } },
  ],
  [
    "submit-scores with an invalid score",
    { action: "submit-scores", payload: { event_name: "Arms Race Stage A", session_id: "s1", score: "abc" } },
  ],
  ["update-power", { action: "update-power", payload: { power: 5000 } }],
  ["update-power out of range", { action: "update-power", payload: { power: -1 } }],
  ["update-metrics", { action: "update-metrics", payload: { total_power: 2000, tech_power: "15", glory_score: 50 } }],
  ["get-metrics-history", { action: "get-metrics-history", payload: { limit: 5 } }],
  ["update-glory", { action: "update-glory", payload: { glory: "300" } }],
  ["get-transfer-guilds", { action: "get-transfer-guilds" }],
  ["submit-transfer-request", { action: "submit-transfer-request", payload: { targetGuild: "TB" } }],
  ["get-history", { action: "get-history" }],
  ["get-absences", { action: "get-absences" }],
  [
    "set-absence",
    {
      action: "set-absence",
      payload: { start_date: "2026-10-08", end_date: "2026-10-09", kind: "war", note: "travel" },
    },
  ],
  ["delete-absence", { action: "delete-absence", payload: { id: "a1" } }],
  ["get-badges", { action: "get-badges" }],
  ["get-weekly-challenges", { action: "get-weekly-challenges" }],
  ["get-personal-kpis", { action: "get-personal-kpis" }],
  ["update-timezone", { action: "update-timezone", payload: { offset: 5.75, timezone: "Asia/Kathmandu" } }],
  ["update-timezone off the quarter hour", { action: "update-timezone", payload: { offset: 5.1 } }],
  ["an unknown action", { action: "confirm-discord-link" }],
  ["no token", { action: "get-history" }, "anonymous"],
  ["no action", { payload: {} }],
];

for (const [name, body, who] of cases) {
  Deno.test(`member-portal: ${name}`, (t) => scenario(t, body, who));
}
