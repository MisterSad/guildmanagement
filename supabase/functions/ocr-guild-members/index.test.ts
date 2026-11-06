// ocr-guild-members, run for real (audit OCR-15: no test executed the
// handler), with the AI provider scripted at the fetch boundary (ADR-024).

import { assertEquals } from "jsr:@std/assert@1.0.14";
import { FakeSupabase, post, seedAccount, testEnv, uninstallFake } from "../_test/fake-supabase.ts";

testEnv({ OPENROUTER_API_KEY: "sk-or-v1-handlertestkeyhandlertest" });
const { handler } = await import("./index.ts");

const realFetch = globalThis.fetch;
function scriptAi(answer: (body: any) => Response) {
  const seen: any[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://openrouter.ai/")) {
      const body = JSON.parse(String(init?.body));
      seen.push({ body, headers: init?.headers });
      return answer(body);
    }
    return realFetch(url as any, init);
  }) as typeof fetch;
  return seen;
}

function setup() {
  const fake = new FakeSupabase();
  fake.install();
  fake.table("guilds").push({ id: "TA", server_number: "9001" });
  const jwt = seedAccount(fake, { id: "t_admin_a", role: "guild_admin", guild: "TA", server_number: "9001" });
  return { fake, jwt };
}

const IMAGE = { images: [{ base64Data: "iVBORw0KGgo=", mimeType: "image/png" }], metadata: { metricType: "power" } };

Deno.test("a screenshot is read through OpenRouter and its players returned", async () => {
  const { fake, jwt } = setup();
  const seen = scriptAi(
    () =>
      new Response(
        JSON.stringify({
          model: "google/gemini-3.8-flash",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  metric: "power",
                  guild_tag: null,
                  endingRank: null,
                  players: [
                    { pseudo: "Ace", guild_tag: null, score: 1234567, raw_score: "1,234,567", uid: null, rank: null },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )
  );
  try {
    const res = await handler(post(IMAGE, jwt));
    const body = await res.json();
    assertEquals(res.status, 200);
    assertEquals(body.ok, true);
    assertEquals(
      body.players.map((p: any) => [p.pseudo, p.score]),
      [["Ace", 1234567]]
    );
    assertEquals(seen.length, 1);
    assertEquals(seen[0].body.model, "google/gemini-3.8-flash");
    assertEquals(seen[0].body.reasoning, { effort: "low", exclude: true });
    assertEquals(seen[0].body.messages[1].content[1].image_url.url, "data:image/png;base64,iVBORw0KGgo=");
    assertEquals(seen[0].body.response_format.json_schema.strict, true);
    // The result is cached for the guild, as before.
    assertEquals(fake.table("ocr_cache").length, 1);
  } finally {
    globalThis.fetch = realFetch;
    uninstallFake();
  }
});

Deno.test("when every model fails the officer gets a failure, never an empty success", async () => {
  const { jwt } = setup();
  const seen = scriptAi(() => new Response("upstream down", { status: 502 }));
  try {
    const res = await handler(post(IMAGE, jwt));
    const body = await res.json();
    assertEquals(res.status, 500);
    assertEquals(body.error, "ocr_processing_failed");
    assertEquals(
      seen.map((s) => s.body.model),
      ["google/gemini-3.8-flash", "google/gemini-3.7-flash"]
    );
  } finally {
    globalThis.fetch = realFetch;
    uninstallFake();
  }
});

Deno.test("a member cannot spend the AI budget", async () => {
  const fake = new FakeSupabase();
  fake.install();
  const jwt = seedAccount(fake, { id: "t_member_a", role: "member", guild: "TA", server_number: "9001" });
  const seen = scriptAi(() => new Response("{}", { status: 200 }));
  try {
    const res = await handler(post(IMAGE, jwt));
    assertEquals(res.status, 403);
    assertEquals(seen.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    uninstallFake();
  }
});

Deno.test("a guild whose TAG is 11 or 12 characters can scan (NW_NEWWORLD, 2026-11-06)", async () => {
  const fake = new FakeSupabase();
  fake.install();
  fake.table("guilds").push({ id: "NW_NEWWORLD", server_number: "9001" });
  const jwt = seedAccount(fake, { id: "t_admin_nw", role: "guild_admin", guild: "NW_NEWWORLD", server_number: "9001" });
  scriptAi(
    () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ metric: "members", guild_tag: null, endingRank: null, players: [] }) },
            },
          ],
        }),
        { status: 200 }
      )
  );
  try {
    for (const tag of ["NW_NEWWORLD", "SKAVEBLIGHT1"]) {
      const res = await handler(post({ ...IMAGE, metadata: { metricType: "members", guildTag: tag } }, jwt));
      assertEquals(res.status, 200, tag);
    }
    const tooLong = await handler(post({ ...IMAGE, metadata: { metricType: "members", guildTag: "THIRTEENCHARS" } }, jwt));
    assertEquals(tooLong.status, 400);
  } finally {
    globalThis.fetch = realFetch;
    uninstallFake();
  }
});
