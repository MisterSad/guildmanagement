# Changelog

## New

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

- **Roster Alignment**: Ensures fuzzy matches above 75% similarity map to existing players while keeping genuine new players tagged as `New Player`.
- **Quality Gate**: Passed 0 errors (`npm run type-check`) and 200/200 green Vitest unit tests (`npm test`).
