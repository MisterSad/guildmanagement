# Changelog

## New

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

## Fixed

- **Shadowfront Roster Sharing to Discord**: Resolved issues causing "Failed to send to Discord" toasts when guild admins share squad rosters.
- **Quality Gate**: Passed 0 errors (`npm run type-check`), full production build (`npm run build`), and 202/202 green Vitest unit tests (`npm test`).
