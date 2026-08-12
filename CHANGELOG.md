# Changelog

## New

- **Interactive OCR API Key Setup (v89)**:
  - **Inline Key Configuration Prompt**: When no API key is detected or if an HTTP 403 Permission Denied error occurs, the OCR modal automatically displays an interactive setup box: *"API Key Required: Please enter your API key to enable OCR scanning"*.
  - **Key Settings Button**: Added a dedicated key icon button (`#ocr-key-config-btn`) in the modal header to view, update, or edit the saved API key anytime.
  - **Local Storage Persistence**: API key is saved locally in `localStorage.setItem('gm_gemini_key', val)` so it remains configured across sessions.

- **Dedicated Roster & Power OCR Import (v88)**:
  - **White-Label AI Integration**: Completely removed all references to external AI provider names ("Gemini") across all user-facing UI elements, buttons, titles, dropzone hints, loading spinners, and toast notifications.
  - **Clear Purpose & Scope**: Re-labeled the button in the `Add a member` card to **`Import Members (OCR)`** and updated the modal header to **`Import Members & Power (OCR)`** to explicitly clarify its dedicated function (importing new roster members and updating player power levels).

- **Gemini 2.5 Flash OCR Bulk Member Import (v87)**:
  - **Scan Button & Modal**: Integrated a dedicated "Scan OCR" button in the `Members` tab (`Add a member` section).
  - **100% English UI & Localization**: Standardized all modal titles, headers, dropzone instructions, review table columns, status tags (`New Player`, `Update`, `Unchanged`), and toast notifications in English.
  - **Interactive Verification Grid**: Drag-and-drop or upload game screenshots (leaderboards, guild roster lists) to preview detected player names, extracted power values, and match status.

## Fixed

- **HTTP 403 Permission Denied Handling**: Catches missing API keys gracefully and prompts the user to enter their key instead of throwing raw network errors.
- **Provider White-Labeling**: Cleaned up all brand provider mentions from UI strings to maintain a professional white-label SaaS appearance.
- **Type Safety & Build Verification**: All scripts pass with 0 errors (`npm run type-check`) and 200/200 green Vitest tests (`npm test`).
