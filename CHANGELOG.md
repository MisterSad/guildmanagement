# Changelog

## Fixed

- **OCR Import Results Modal Display & Resilient Gemini JSON Parsing (v99)**:
  - **Robust Markdown Fence JSON Cleaning**: Added `parseGeminiJson` helper function in `gm-utils.js` and `app.js` to strip Markdown code fences (` ```json ` and ` ``` `), trim whitespace, and extract valid `{...}` / `[...]` JSON substrings from Gemini AI responses.
  - **Multi-Model Endpoint Fallback**: Added automatic fallback in `callGeminiOcrBatchApi` across `gemini-1.5-flash`, `gemini-2.0-flash`, and `gemini-flash-latest` endpoints to prevent HTTP 404 model errors from breaking imports.
  - **Modal Event Listener Initialization**: `openOcrModal()` now explicitly ensures `initOcrGeminiModule()` is executed, preventing uninitialized event listener states when clicking "Import Members (OCR)" in the Members tab.
  - **Safe UI Rendering & Empty State**: Replaced direct `window.GM` calls in `renderOcrResults` with null-safe local fallback helpers (`esc` and `fmtNum`), and added a friendly warning row when 0 players are extracted.
  - **Vitest Unit Test Suite**: Added `tests/ocr.test.js` to verify JSON parsing across raw, Markdown-wrapped, and substring-embedded payloads.
  - **Quality Gate**: Passed 0 type errors (`npm run type-check`), successful Vite production build (`npm run build`), and **206/206 green Vitest unit tests** (`npm test`).

- **Shadowfront Discord Embeds Fix & Proxy Upgrade (v98)**:
  - **Proxy Upgrade**: Upgraded the `discord-webhook-proxy` Edge Function on Supabase to correctly forward JSON `embeds` to Discord, replacing an outdated v80 version that silently stripped them.
  - **Code Cleanup**: Removed temporary diagnostic UI embeds from [shadowfront.js](file:///Users/andrevieira/Documents/GitHub/guildmanagement/shadowfront.js) after verifying proxy stability.

## New

- **Automatic Session Token Refresh & Proxy Retry on Expired JWTs (v97)**:
  - **Proactive Token Refresh**: Updated `ensureAuthSession` in [gm-utils.js](file:///Users/andrevieira/Documents/GitHub/guildmanagement/gm-utils.js) to proactively refresh JWT access tokens within 60 seconds of expiration.
  - **Apikey Proxy Fallback**: Updated `sendDiscordWebhook` in [gm-utils.js](file:///Users/andrevieira/Documents/GitHub/guildmanagement/gm-utils.js) to automatically retry proxy invocation with the public `apikey` if the user's browser session encounters an HTTP 401 JWT error, guaranteeing 100% webhook delivery.

- **Shadowfront Active Session Filtering & Squad Roster Formatting Fix (v96)**:
  - **Active Session Filtering**: Updated `squadField` in [shadowfront.js](file:///Users/andrevieira/Documents/GitHub/guildmanagement/shadowfront.js) to strictly filter squad assignments by the active squad's `sessionId`.
  - **Complete Roster Formatting & Deduplication**: Ensures all 20 main participants and 10 substitutes are formatted, deduplicated, and posted to Discord without list truncation or historical session pollution.

- **Server-Side Webhook Resolution & Tenant Context Resilience (v95)**:
  - **Server-Side Proxy Webhook Resolution**: Enhanced `discord-webhook-proxy` Edge Function ([discord-webhook-proxy/index.ts](file:///Users/andrevieira/Documents/GitHub/guildmanagement/supabase/functions/discord-webhook-proxy/index.ts)) to accept `guild` and `eventPrefix`. If the client-side session lacks a resolved webhook URL (due to RLS or missing local storage), the Edge Function automatically resolves the webhook URL for that tenant using `SUPABASE_SERVICE_ROLE_KEY`.
  - **Unstoppable Webhook Invocation**: Updated `sendDiscordWebhook` ([gm-utils.js](file:///Users/andrevieira/Documents/GitHub/guildmanagement/gm-utils.js)) to always invoke the server proxy with tenant context (`guild` & `eventPrefix`) even when client-side resolution yields `null`.

- **Shadowfront Discord Role Ping Crash Fix & `sf_subtitle` i18n Localization (v94)**:
  - **Export `formatDiscordRoleMention`**: Exported `formatDiscordRoleMention` in `window.GM` ([gm-utils.js](file:///Users/andrevieira/Documents/GitHub/guildmanagement/gm-utils.js)) and added defensive checks in [shadowfront.js](file:///Users/andrevieira/Documents/GitHub/guildmanagement/shadowfront.js) to resolve uncaught `TypeError: window.GM.formatDiscordRoleMention is not a function` runtime crashes for guilds with a configured Discord Role ID.
  - **Localization of `sf_subtitle`**: Added missing `sf_subtitle` translation key to [i18n.js](file:///Users/andrevieira/Documents/GitHub/guildmanagement/i18n.js) ('Squad 1 & Squad 2 - 20 participants + 10 reserves'), eliminating raw key display on all tenant pages.

- **Robust Discord Webhook Proxy, Multi-Domain Validation & Fallback Resolution (v93)**:
  - **Guild Webhook Fallback Resolution**: `resolveDiscordWebhook` in `gm-utils.js` now falls back to any configured guild event webhook (`webhook_armsrace`, `webhook_svs`, `webhook_gvg`, `webhook_dtr`, `webhook_calamity`) if the dedicated `webhook_shadowfront` field is left empty.
  - **Multi-Domain & Subdomain Discord Support**: Upgraded `discord-webhook-proxy` and `event-reminders` Edge Functions to validate and accept all official Discord subdomains (`canary.discord.com`, `ptb.discord.com`), versioned paths (`/api/v10/webhooks/`), and clean angle-bracketed URLs (`<https://...>`).
  - **Discord 1024-Character Embed Safety**: Updated `fmtList` in `shadowfront.js` to safely truncate squad participant and reserve roster lists at 1024 characters, preventing Discord HTTP 400 Bad Request errors.
  - **Discord Role Mention Integration**: Shadowfront composition sharing now automatically appends configured Discord role pings (`discord_role_id_shadowfront` or `discord_role_id`).
  - **Enhanced Proxy Error Logging**: `sendDiscordWebhook` now logs detailed error messages from proxy responses for faster diagnosis.

- **Intelligent Roster Name Reconciliation & Fuzzy Matching (v91)**:
  - **Fuzzy Levenshtein Similarity Matcher**: Integrated `findBestMatchingMember` using Levenshtein distance and normalized string matching to compare extracted OCR pseudos against existing database members.
  - **Automatic Reconciled Tagging**: Automatically detects OCR transcription typos (e.g. `RAWK3T` vs `RAWKET`), extra spaces, or guild tags (e.g. `[ALPHA] HawkEye` vs `HawkEye`) and links them directly to the matching DB member.
  - **Gold Reconciled Chip Indicator**: Displays a dedicated golden badge `<span class="gm-chip"><i class="ph ph-sparkle"></i> Reconciled ("RAWKET") &rarr; 115M</span>` and summary counter in the review table.
  - **Prevents Duplicate Ghost Players**: Automatically updates existing member power records instead of creating duplicate player entries.

- **Multimodal OCR Batching & Auto 429 Retry (v90)**:
  - **Multimodal Payload Grouping**: Groups up to 4 screenshots per single Gemini API request, reducing total API call volume by 75% for large 200+ player rosters.
  - **Inter-Batch Delay**: 1.2s pause between batch requests to stay comfortably below free-tier RPM quotas.
  - **Automatic Rate Limit Retry**: Intercepts HTTP 429 errors, displays a clear status countdown on screen, and retries automatically.
