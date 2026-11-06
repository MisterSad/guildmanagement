/**
 * supabase/functions/_shared/ai-vision.ts
 *
 * One image, one JSON answer: the profile-screenshot extraction of
 * discord-profile-verification. It owns no prompt -- that stays with the
 * caller's schema -- and no model list: both come from _shared/openrouter.ts
 * (ADR-024), which replaced the direct Gemini call of `gemini-vision.ts`.
 */
import { callOpenRouter, imagePart, textPart, type AiPart } from "./openrouter.ts";

export interface VisionImage {
  mimeType: string;
  base64Data: string;
}

export interface VisionResult {
  ok: boolean;
  raw?: string;
  error?: string;
}

export async function callVisionModel(apiKey: string, prompt: string, images: VisionImage[]): Promise<VisionResult> {
  const parts: AiPart[] = [textPart(prompt), ...images.map((img) => imagePart(img.mimeType, img.base64Data))];
  const result = await callOpenRouter({
    apiKey,
    parts,
    json: true,
    temperature: 0.1,
    // A profile answers in a few hundred tokens; the rest is room for the
    // reasoning these models cannot switch off.
    maxTokens: 8192,
    timeoutMs: 45_000,
    referer: Deno.env.get("APP_DEFAULT_ORIGIN") ?? undefined,
  });
  return result.raw ? { ok: true, raw: result.raw } : { ok: false, error: result.lastError || "No AI model answered" };
}
