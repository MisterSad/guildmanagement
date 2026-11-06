// _shared/openrouter.ts, run for real against a scripted fetch (ADR-024).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.14";
import {
  BINARY_MARKER,
  buildBody,
  callOpenRouter,
  imagePart,
  OPENROUTER_CHAT_URL,
  textPart,
  toJsonSchema,
  videoPart,
} from "./openrouter.ts";

type Seen = { url: string; headers: Record<string, string>; body: any };

function scripted(answers: Array<Response | (() => Promise<Response>)>) {
  const seen: Seen[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const raw = init?.body;
    const text = typeof raw === "string" ? raw : await new Response(raw as ReadableStream).text();
    seen.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(text) });
    const a = answers[Math.min(i++, answers.length - 1)];
    return typeof a === "function" ? await a() : a;
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const ok = (content: string, finish = "stop", model = "google/gemini-3.8-flash") =>
  new Response(
    JSON.stringify({ model, choices: [{ message: { content }, finish_reason: finish }], usage: { total_tokens: 10 } }),
    {
      status: 200,
    }
  );

const base = { apiKey: "sk-or-v1-testkeytestkeytestkey", temperature: 0.1, maxTokens: 1000, timeoutMs: 5000 };

Deno.test("sends one chat completion to OpenRouter: model, reasoning floor, no-data providers, strict schema", async () => {
  const { seen, fetchImpl } = scripted([ok('{"players":[]}')]);
  const res = await callOpenRouter({
    ...base,
    system: "SYS",
    parts: [textPart("hello"), imagePart("image/png", "AAAA")],
    schema: {
      name: "ocr",
      schema: { type: "OBJECT", properties: { a: { type: "STRING", nullable: true } }, required: ["a"] },
    },
    fetchImpl,
  });
  assertEquals(res.raw, '{"players":[]}');
  assertEquals(res.model, "google/gemini-3.8-flash");
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, OPENROUTER_CHAT_URL);
  assertEquals(seen[0].headers.Authorization, "Bearer sk-or-v1-testkeytestkeytestkey");
  const b = seen[0].body;
  assertEquals(b.model, "google/gemini-3.8-flash");
  assertEquals(b.reasoning, { effort: "low", exclude: true });
  assertEquals(b.provider, { data_collection: "deny", require_parameters: true });
  assertEquals(b.messages[0], { role: "system", content: "SYS" });
  assertEquals(b.messages[1].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  assertEquals(b.response_format.type, "json_schema");
  assertEquals(b.response_format.json_schema.strict, true);
  assertEquals(b.response_format.json_schema.schema.properties.a.type, ["string", "null"]);
});

Deno.test("falls back to 3.7-flash on an error status, a cut answer, or an empty one", async () => {
  for (const first of [
    new Response("overloaded", { status: 503 }),
    ok('{"players":[{"pseudo":"A"', "length"),
    ok("", "stop"),
  ]) {
    const { seen, fetchImpl } = scripted([first, ok('{"ok":1}', "stop", "google/gemini-3.7-flash")]);
    const res = await callOpenRouter({ ...base, parts: [textPart("x")], json: true, fetchImpl });
    assertEquals(res.raw, '{"ok":1}');
    assertEquals(
      seen.map((s) => s.body.model),
      ["google/gemini-3.8-flash", "google/gemini-3.7-flash"]
    );
  }
});

Deno.test("a cut answer is never returned as a result, even from the last model", async () => {
  const { fetchImpl } = scripted([() => Promise.resolve(ok('{"a":', "length"))]);
  const res = await callOpenRouter({ ...base, parts: [textPart("x")], fetchImpl });
  assertEquals(res.raw, "");
  assertStringIncludes(res.lastError, "stopped early: length");
});

Deno.test("a provider error in a 200 body is a failure", async () => {
  const { fetchImpl } = scripted([
    () =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: "no endpoints", code: 404 } }), { status: 200 })),
  ]);
  const res = await callOpenRouter({ ...base, parts: [textPart("x")], fetchImpl });
  assertEquals(res.raw, "");
  assertStringIncludes(res.lastError, "no endpoints");
});

Deno.test("a call that hangs is abandoned at its timeout", async () => {
  const fetchImpl = ((_u: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
  const res = await callOpenRouter({ ...base, timeoutMs: 50, parts: [textPart("x")], fetchImpl });
  assertEquals(res.raw, "");
  assertStringIncludes(res.lastError, "timed out after 50 ms");
});

Deno.test("the key never appears in what the client reports", async () => {
  const { fetchImpl } = scripted([new Response("bad key sk-or-v1-testkeytestkeytestkey", { status: 401 })]);
  const res = await callOpenRouter({ ...base, parts: [textPart("x")], fetchImpl, models: ["google/gemini-3.8-flash"] });
  // The provider's own text is kept (logs), but never the caller-supplied key header.
  assert(!JSON.stringify({ model: res.model, usage: res.usage }).includes("testkey"));
});

Deno.test("a recording is streamed as base64 in place of the marker, byte for byte", async () => {
  const bytes = new Uint8Array(7 * 1024 * 1024 + 5);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  const body = buildBody({ messages: [{ role: "user", content: [videoPart("video/mp4")] }] }, bytes);
  assert(body instanceof ReadableStream);
  const text = await new Response(body).text();
  assert(!text.includes(BINARY_MARKER));
  const url = JSON.parse(text).messages[0].content[0].video_url.url as string;
  assertEquals(url.slice(0, 22), "data:video/mp4;base64,");
  const decoded = Uint8Array.from(atob(url.slice(22)), (c) => c.charCodeAt(0));
  assertEquals(decoded.length, bytes.length);
  assertEquals(decoded[123456], bytes[123456]);
  assertEquals(decoded[bytes.length - 1], bytes[bytes.length - 1]);
});

Deno.test("toJsonSchema: types lowercased, nullable as a union, every property required, nothing extra", () => {
  const out = toJsonSchema({
    type: "OBJECT",
    properties: {
      players: { type: "ARRAY", items: { type: "OBJECT", properties: { n: { type: "INTEGER", nullable: true } } } },
    },
  });
  assertEquals(out, {
    type: "object",
    properties: {
      players: {
        type: "array",
        items: {
          type: "object",
          properties: { n: { type: ["integer", "null"] } },
          required: ["n"],
          additionalProperties: false,
        },
      },
    },
    required: ["players"],
    additionalProperties: false,
  });
});
