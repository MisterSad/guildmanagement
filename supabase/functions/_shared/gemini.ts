/**
 * supabase/functions/_shared/gemini.ts
 *
 * The one list of Gemini models this project will try, and how to address them.
 *
 * FINDING B1. Two functions each carried their own fallback list and they
 * disagreed. `ocr-guild-members` tried, in order:
 *
 *     gemini-flash-latest, gemini-3.5-flash, gemini-3.7-flash,
 *     gemini-3-flash-preview, gemini-flash-lite-latest
 *
 * while `migration-summary` tried a different set of four. Three of the OCR
 * entries are identifiers Google has never published: Gemini has never used a
 * `3.5` or `3.7` minor-version scheme -- that is the Claude/GPT naming shape,
 * pattern-matched onto the wrong vendor. Every one of them costs a full HTTP
 * round trip and a 404 on the fallback path before the next candidate is tried.
 *
 * WHAT IS AND IS NOT VERIFIED HERE. I could not confirm these slugs against the
 * live API: `generativelanguage.googleapis.com` rejects an unauthenticated call
 * with 403 PERMISSION_DENIED *before* it resolves the model name, so a valid and
 * an invented slug are indistinguishable without the API key -- which is a
 * production secret this project deliberately keeps out of reach. The ordering
 * below therefore rests on two things: the published Gemini model names, and the
 * audit's reading of production logs, which found `gemini-flash-latest` to be
 * the only model that ever actually served. It is kept first for that reason.
 *
 * The two `-latest` entries are aliases that track the current model, so they
 * keep working across Gemini releases without another edit here. The concrete
 * versions that follow exist only to cover an alias outage.
 */

export const GEMINI_MODEL_FALLBACKS: readonly string[] = [
  // Proven in production. An alias, so it survives model retirements.
  "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  // Cheaper tier, tried last: lower capability, so only worth reaching for
  // once the flash models are unavailable.
  "gemini-flash-lite-latest",
  "gemini-2.5-flash-lite",
];

/** Endpoint for one model's `generateContent` call. */
export function geminiGenerateContentUrl(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}
