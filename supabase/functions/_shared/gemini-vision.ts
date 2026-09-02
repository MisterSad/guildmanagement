/**
 * supabase/functions/_shared/gemini-vision.ts
 *
 * Thin wrapper around the Gemini Vision REST call, extracted from
 * ocr-guild-members/index.ts (which keeps its own inline copy unchanged --
 * this is only used by new callers) so a second OCR use case doesn't
 * duplicate the endpoint/headers/model-fallback/response-parsing logic.
 * Deliberately does NOT own prompt construction -- that stays specific to
 * each caller's extraction schema.
 */

const MODELS_TO_TRY = [
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-3.7-flash",
  "gemini-3-flash-preview",
  "gemini-flash-lite-latest",
];

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

  const payload = {
    contents: [{ parts }],
    generationConfig: { response_mime_type: "application/json", temperature: 0.1 },
  };

  let lastError = "";

  for (const modelName of MODELS_TO_TRY) {
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
      });

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
    } catch (e: any) {
      lastError = `Fetch exception for ${modelName}: ${e.message}`;
    }
  }

  return { ok: false, error: lastError || "All Gemini models failed" };
}
