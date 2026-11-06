# ADR-024: Every AI call goes through OpenRouter

- **Status**: Accepted
- **Date**: 2026-11-06
- **Supersedes**: the direct Google Gemini calls (`_shared/gemini.ts`, `_shared/gemini-vision.ts`), and, in ADR-021, the Gemini File API upload, the frame rate and the media resolution
- **Related**: ADR-012 (OCR cache), ADR-018 (GDPR processors), ADR-021 (video OCR)

## Context

Three Edge Functions called Google's Gemini API directly, with `GEMINI_API_KEY`:
- `ocr-guild-members` reads screenshots and screen recordings;
- `migration-summary` summarises Migration Hub notes;
- `discord-profile-verification` reads a profile screenshot posted in Discord.

The owner chose to move them to OpenRouter, with the model
`google/gemini-3.8-flash`. The model is listed in OpenRouter's public catalog
(checked 2026-11-06): text, image and video input, structured outputs, $0.825
per million input tokens and $4.125 per million output tokens.

## Decision

**One client, `supabase/functions/_shared/openrouter.ts`, for every model
call**, keyed by the `OPENROUTER_API_KEY` secret.

Owner decisions, 2026-11-06:
1. **All three functions move.** The OCR (images *and* video), the summary and
   the Discord verification all go through OpenRouter.
2. **Models.** `google/gemini-3.8-flash` is tried first, falling back to
   `google/gemini-3.7-flash`. A fallback happens on an error status, an error
   body, a timeout, an empty answer, or any finish other than `stop`.
3. **Reasoning is kept as low as the model allows.** The owner asked for none,
   to save tokens: OCR is transcription against a fixed schema. Both models
   declare reasoning **mandatory** on OpenRouter (efforts high, medium and low
   only). Offered a model where it can be turned off (`gemini-3-flash-preview`,
   `gemini-3.1-flash-lite`), the owner kept 3.8-flash, so every call sends
   `reasoning: { effort: "low", exclude: true }`.
   - The reasoning tokens are billed as output.
   - They spend from the same `max_tokens` budget as the answer, which is how
     three OCR answers came back cut on 2026-09-27. The budgets therefore stay
     generous: 32,768 for the OCR, 8,192 for the summary and the verification.
   - A `length` finish is a failure, never a result.
4. **Video recordings are capped at 20 MiB** (was 64 MiB).
   - OpenRouter's Google endpoints take a video only inline, as a base64 data
     URL: there is no upload API.
   - The recordings scanned on 2026-11-05/06 weighed 13.9 to 17.3 MB, for 50 to
     148 s.
   - The request body is streamed (`buildBody`), with the bytes encoded in
     place, so the function never holds the encoded video as one string.

**Privacy.** Every request sends `provider: { data_collection: "deny",
require_parameters: true }`. It is routed only to providers that do not collect
the data, and that support every parameter sent. The key is never logged, and
the logger also redacts any `sk-or-…` string.

## Consequences and invariants

- **Only `_shared/openrouter.ts` names a model or an AI provider.**
  `tests/discord_worker_contract.test.js` and `tests/phase5_repairs.test.js`
  enforce it.
- **The video frame rate is no longer ours to set.**
  - ADR-021 read recordings at up to 8 frames per second through the File API.
    OpenRouter exposes no such control, so Gemini's default sampling applies
    (about 1 frame per second).
  - A fast scroll may therefore lose rows. The coverage check and the targeted
    second pass of ADR-021 remain, and say what is missing.
  - The duration limit (300 s) is now checked in the browser only.
  - **To be measured after deployment** against a ground-truth recording
    (`scripts/ocr-eval.mjs`).
- **`GEMINI_API_KEY` is no longer read.** Keep the secret until the new path is
  validated in production, so that `git revert` stays a complete rollback, then
  delete it.
- **The cache (ADR-012) is unchanged.** Results cached under the old model stay
  valid for their 7 days.
- **Tests.**
  - `supabase/functions/_shared/openrouter.test.ts` runs the client: request
    shape, fallback, a cut answer refused, timeout, the streamed video body
    checked byte for byte, and the schema translation.
  - `supabase/functions/ocr-guild-members/index.test.ts` runs the OCR handler
    end to end, against a scripted provider.
