/**
 * supabase/functions/_shared/openrouter.ts
 *
 * The one way this project calls an AI model (ADR-024): OpenRouter's
 * OpenAI-compatible chat completions API, for the OCR (screenshots and screen
 * recordings) and the Discord profile verification. (The Migration Hub summary
 * used it too, until the Hub was removed on 2026-11-06.)
 * It replaces the direct Google Gemini calls (`_shared/gemini.ts`, removed).
 *
 * Owner decisions, 2026-11-06:
 *   - model `google/gemini-3.8-flash`, falling back to `google/gemini-3.7-flash`;
 *   - reasoning as low as the model allows. Both models declare reasoning
 *     MANDATORY on OpenRouter (`reasoning.mandatory = true`, efforts high /
 *     medium / low), so it cannot be switched off; `effort: "low"` is the floor.
 *     Its tokens are billed as output and come out of the same `max_tokens`
 *     budget as the answer, which is how three OCR answers were cut mid-JSON on
 *     2026-09-27: a `length` finish is therefore a failure, never a result.
 *
 * The API key is read from the `OPENROUTER_API_KEY` secret and is never logged,
 * returned or written anywhere (AGENTS.md rule 1).
 */

import type { EdgeLogger } from "./logger.ts";

export const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Tried in order; the first complete answer wins. */
export const OPENROUTER_MODELS: readonly string[] = ["google/gemini-3.8-flash", "google/gemini-3.7-flash"];

export type AiPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };

export const textPart = (text: string): AiPart => ({ type: "text", text });

export const imagePart = (mimeType: string, base64: string): AiPart => ({
  type: "image_url",
  image_url: { url: `data:${mimeType};base64,${base64}` },
});

/**
 * Stands in for a large binary (a screen recording) inside a part's data URL.
 * The request body is then streamed with the bytes base64-encoded in place of
 * the marker, so the function never holds the whole encoded video as one string
 * (a 20 MB recording is ~27 MB of base64, ~54 MB as a JS string, twice more in
 * the JSON body).
 */
export const BINARY_MARKER = "__GM_BINARY_PAYLOAD__";

export const videoPart = (mimeType: string): AiPart => ({
  type: "video_url",
  video_url: { url: `data:${mimeType};base64,${BINARY_MARKER}` },
});

export interface AiCallOptions {
  apiKey: string;
  system?: string;
  parts: AiPart[];
  /** A Gemini-style schema (`STRING`, `nullable`); translated by toJsonSchema(). */
  schema?: { name: string; schema: unknown };
  /** Ask for a JSON object without a schema. Ignored when `schema` is set. */
  json?: boolean;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  /** The bytes that replace BINARY_MARKER in the body. */
  binary?: Uint8Array;
  logger?: EdgeLogger;
  /** Shown to OpenRouter as the calling app; never a secret. */
  referer?: string;
  models?: readonly string[];
  fetchImpl?: typeof fetch;
}

export interface AiCallResult {
  /** The model's text, or "" when every model failed. */
  raw: string;
  /** The model that answered, as OpenRouter reports it. */
  model: string | null;
  usage: Record<string, unknown> | null;
  lastError: string;
}

/**
 * Translates the Gemini response-schema dialect the callers were written in
 * (`{ type: "STRING", nullable: true }`) into JSON Schema for
 * `response_format.json_schema`. Strict mode wants every property listed in
 * `required` and no extra properties: an optional field is expressed as
 * nullable, which is what the Gemini schema already said.
 */
export function toJsonSchema(node: any): any {
  if (!node || typeof node !== "object") return node;
  const baseType = typeof node.type === "string" ? node.type.toLowerCase() : undefined;
  const out: Record<string, unknown> = {};
  if (baseType) out.type = node.nullable ? [baseType, "null"] : baseType;
  if (node.enum) out.enum = node.nullable ? [...node.enum, null] : node.enum;
  if (node.description) out.description = node.description;
  if (baseType === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node.properties || {})) props[k] = toJsonSchema(v);
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (baseType === "array") out.items = toJsonSchema(node.items);
  return out;
}

function encodeBase64Chunk(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * The request body: a plain string, or -- when `binary` is given -- a stream
 * that writes the JSON around BINARY_MARKER and the bytes as base64 in its
 * place, 3 MiB at a time (a multiple of 3, so the chunks concatenate into one
 * valid base64 string).
 */
export function buildBody(payload: unknown, binary?: Uint8Array): string | ReadableStream<Uint8Array> {
  const text = JSON.stringify(payload);
  if (!binary) return text;
  const at = text.indexOf(BINARY_MARKER);
  if (at === -1) throw new Error("binary_marker_missing");
  const head = text.slice(0, at);
  const tail = text.slice(at + BINARY_MARKER.length);
  const enc = new TextEncoder();
  const CHUNK = 3 * 1024 * 1024;
  let offset = 0;
  let headSent = false;
  // Every pull enqueues something or closes: a pull that does neither is
  // never called again, and the request would hang with its body unfinished.
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!headSent) {
        controller.enqueue(enc.encode(head));
        headSent = true;
      } else if (offset < binary.length) {
        controller.enqueue(enc.encode(encodeBase64Chunk(binary.subarray(offset, offset + CHUNK))));
        offset += CHUNK;
      } else {
        controller.enqueue(enc.encode(tail));
        controller.close();
      }
    },
  });
}

function contentText(message: any): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
  }
  return "";
}

/** One extraction against the model list; never throws. */
export async function callOpenRouter(opts: AiCallOptions): Promise<AiCallResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const models = opts.models ?? OPENROUTER_MODELS;
  const messages: unknown[] = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: opts.parts });

  const responseFormat = opts.schema
    ? {
        type: "json_schema",
        json_schema: { name: opts.schema.name, strict: true, schema: toJsonSchema(opts.schema.schema) },
      }
    : opts.json
      ? { type: "json_object" }
      : undefined;

  let lastError = "";
  for (const model of models) {
    const payload: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      // The floor these models accept: reasoning cannot be turned off (see the
      // header). `exclude` keeps the reasoning text out of the answer.
      reasoning: { effort: "low", exclude: true },
      // Only providers that keep no data and support every parameter sent.
      provider: { data_collection: "deny", require_parameters: true },
    };
    if (responseFormat) payload.response_format = responseFormat;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "FGF Guild Management",
    };
    if (opts.referer) headers["HTTP-Referer"] = opts.referer;

    const started = Date.now();
    try {
      const resp = await fetchImpl(OPENROUTER_CHAT_URL, {
        method: "POST",
        headers,
        body: buildBody(payload, opts.binary),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });

      if (!resp.ok) {
        const errTxt = (await resp.text()).slice(0, 300);
        lastError = `Model ${model} returned ${resp.status}: ${errTxt}`;
        opts.logger?.warn("AI model attempt failed", { model, status: resp.status });
        continue;
      }

      const data = await resp.json();
      if (data?.error) {
        lastError = `Model ${model} returned an error: ${String(data.error?.message ?? data.error).slice(0, 300)}`;
        opts.logger?.warn("AI model returned an error body", { model, code: data.error?.code ?? null });
        continue;
      }

      const choice = data?.choices?.[0];
      const text = contentText(choice?.message);
      const finish = String(choice?.finish_reason ?? "").toLowerCase();

      // Anything but a clean stop means the text is not the whole answer: a
      // `length` finish is the budget spent (often on reasoning), not a result.
      if (finish !== "stop") {
        lastError = `Model ${model} stopped early: ${finish || "no finish reason"}`;
        opts.logger?.warn("AI model returned an incomplete answer", {
          model,
          finish,
          textLength: text.length,
          usage: data?.usage ?? null,
        });
        continue;
      }
      if (!text) {
        lastError = `Model ${model} returned no text`;
        opts.logger?.warn("AI model returned no text", { model });
        continue;
      }

      opts.logger?.info("AI extraction succeeded", {
        requested: model,
        served: data?.model ?? null,
        provider: data?.provider ?? null,
        ms: Date.now() - started,
        usage: data?.usage ?? null,
      });
      return { raw: text, model: data?.model ?? model, usage: data?.usage ?? null, lastError: "" };
    } catch (e: any) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      lastError = timedOut ? `Model ${model} timed out after ${opts.timeoutMs} ms` : `Fetch exception for ${model}`;
      opts.logger?.warn("AI model call threw", { model, timedOut, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  return { raw: "", model: null, usage: null, lastError: lastError || "No AI model answered" };
}
