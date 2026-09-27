/**
 * supabase/functions/_shared/gemini-vision.ts
 *
 * Thin wrapper around the Gemini Vision REST call, used by
 * discord-profile-verification for its single-profile extraction. Deliberately
 * does NOT own prompt construction -- that stays specific to each caller's
 * extraction schema.
 *
 * It no longer carries its own model list. It had one, and it was the list
 * finding B1 condemned: `gemini-3.5-flash`, `gemini-3.7-flash` and
 * `gemini-3-flash-preview` are identifiers Google has never published -- Gemini
 * has never used a `3.5`/`3.7` minor-version scheme, that is the Claude/GPT
 * naming shape pattern-matched onto the wrong vendor. B1 fixed the copies in
 * `ocr-guild-members` and `migration-summary` and left this third copy behind,
 * so the bot's OCR still paid three full HTTP round trips and three 404s on
 * every fallback. One list now: `_shared/gemini.ts`.
 *
 * It also inherits `thinking_budget: 0`, for the reason measured in production
 * on 2026-09-27 and documented in geminiSupportsThinking(): the thinking tokens
 * come out of the same output budget as the answer, and the three OCR calls that
 * failed that day returned a well-formed envelope whose JSON stopped mid-object.
 * A profile screenshot is transcription against a fixed schema; there is nothing
 * to reason about.
 */
import { GEMINI_MODEL_FALLBACKS, geminiGenerateContentUrl, geminiSupportsThinking } from "./gemini.ts";

export interface GeminiVisionImage {
  mimeType: string;
  base64Data: string;
}

export interface GeminiVisionResult {
  ok: boolean;
  raw?: string;
  error?: string;
}

export async function callGeminiVision(
  apiKey: string,
  prompt: string,
  images: GeminiVisionImage[]
): Promise<GeminiVisionResult> {
  const parts: any[] = [{ text: prompt }];
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64Data } });
  }

  const baseGenerationConfig = { response_mime_type: "application/json", temperature: 0.1 };
  const buildPayload = (modelName: string) => ({
    contents: [{ parts }],
    generationConfig: geminiSupportsThinking(modelName)
      ? { ...baseGenerationConfig, thinking_config: { thinking_budget: 0 } }
      : baseGenerationConfig,
  });

  const call = (modelName: string, payload: unknown): Promise<Response> =>
    fetch(geminiGenerateContentUrl(modelName), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(payload),
    });

  let lastError = "";

  for (const modelName of GEMINI_MODEL_FALLBACKS) {
    try {
      let resp = await call(modelName, buildPayload(modelName));

      // A build that has not heard of thinking_config answers 400 rather than
      // ignoring the field, and the whole extraction would fail on what is only
      // an optimisation. Drop it and ask again -- same recovery as
      // ocr-guild-members.
      if (resp.status === 400 && geminiSupportsThinking(modelName)) {
        const errTxt = await resp.text();
        lastError = `Model ${modelName} rejected thinking_config: ${errTxt.slice(0, 300)}`;
        resp = await call(modelName, { contents: [{ parts }], generationConfig: baseGenerationConfig });
      }

      if (!resp.ok) {
        const errTxt = await resp.text();
        lastError = `Model ${modelName} returned ${resp.status}: ${errTxt}`;
        continue;
      }

      const respData = await resp.json();
      const textCandidate = respData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (textCandidate) {
        return { ok: true, raw: textCandidate };
      }
      lastError = `Model ${modelName} returned no text candidate`;
    } catch (e: any) {
      lastError = `Fetch exception for ${modelName}: ${e.message}`;
    }
  }

  return { ok: false, error: lastError || "All Gemini models failed" };
}
