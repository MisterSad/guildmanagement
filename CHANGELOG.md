# Changelog

## New

- **Shadowfront Discord Webhook Edge Proxy & Embed Payload Support (v92)**:
  - **Supabase Edge Function Proxy Integration**: `sendDiscordWebhook` in `gm-utils.js` now routes webhook payloads through the `discord-webhook-proxy` Edge Function as primary with fallback to direct `fetch`. This bypasses browser CORS restrictions and adblocker issues that previously blocked Discord webhook POST calls in Chrome/Firefox/Safari.
  - **Full Discord Embed Payload Forwarding**: Upgraded `discord-webhook-proxy` Edge Function to parse and forward full Discord payloads (including squad roster `embeds`, `fields`, `content`, `color`, and formatting) instead of strictly requiring plain text strings.

- **Intelligent Roster Name Reconciliation & Fuzzy Matching (v91)**:
  - **Fuzzy Levenshtein Similarity Matcher**: Integrated `findBestMatchingMember` using Levenshtein distance and normalized string matching to compare extracted OCR pseudos against existing database members.
  - **Automatic Reconciled Tagging**: Automatically detects OCR transcription typos (e.g. `RAWK3T` vs `RAWKET`), extra spaces, or guild tags (e.g. `[ALPHA] HawkEye` vs `HawkEye`) and links them directly to the matching DB member.
  - **Gold Reconciled Chip Indicator**: Displays a dedicated golden badge `<span class="gm-chip"><i class="ph ph-sparkle"></i> Reconciled ("RAWKET") &rarr; 115M</span>` and summary counter in the review table.
  - **Prevents Duplicate Ghost Players**: Automatically updates existing member power records instead of creating duplicate player entries.

- **Multimodal OCR Batching & Auto 429 Retry (v90)**:
  - **Multimodal Payload Grouping**: Groups up to 4 screenshots per single Gemini API request, reducing total API call volume by 75% for large 200+ player rosters.
  - **Inter-Batch Delay**: 1.2s pause between batch requests to stay comfortably below free-tier RPM quotas.
  - **Automatic Rate Limit Retry**: Intercepts HTTP 429 errors, displays a clear status countdown on screen, and retries automatically.

## Fixed

- **Shadowfront Discord Webhook Sharing**: Fixed an issue preventing guild admins from sharing Shadowfront team compositions to Discord. Now successfully sends full squad rosters and reserve lists directly to Discord channels.
- **Roster Alignment**: Ensures fuzzy matches above 75% similarity map to existing players while keeping genuine new players tagged as `New Player`.
- **Quality Gate**: Passed 0 errors (`npm run type-check`), full production build (`npm run build`), and 201/201 green Vitest unit tests (`npm test`).
