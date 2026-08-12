# Changelog

## New

- **Admin Interactive OCR Validation Grid (v90)**:
  - **Human-in-the-Loop Verification**: Once screenshot scanning completes, extracted data is displayed in an interactive review table before any database updates occur.
  - **Inline Real-Time Editing**: Admins can directly edit extracted player usernames (`.ocr-edit-pseudo`) or power levels (`.ocr-edit-power`) right inside the preview table before validating.
  - **Summary Breakdown Badges**: Added real-time summary indicators above the table for `New Players`, `Power Updates`, and `Unchanged Members`.
  - **Explicit Validation Action**: Button updated to **`Validate & Apply Updates (X)`** highlighted in green, requiring explicit admin click to commit to the active guild database.

- **Interactive OCR API Key Setup (v89)**:
  - **Inline Key Configuration Prompt**: When no API key is detected or if an HTTP 403 Permission Denied error occurs, the OCR modal automatically displays an interactive setup box.
  - **Key Settings Button**: Added a dedicated key icon button (`#ocr-key-config-btn`) in the modal header to view, update, or edit the saved API key anytime.

- **Dedicated Roster & Power OCR Import (v88)**:
  - **White-Label AI Integration**: Completely removed all references to external AI provider names ("Gemini") across all user-facing UI elements, buttons, titles, dropzone hints, loading spinners, and toast notifications.
  - **Clear Purpose & Scope**: Re-labeled the button in the `Add a member` card to **`Import Members (OCR)`** and updated the modal header to **`Import Members & Power (OCR)`** to explicitly clarify its dedicated function.

## Fixed

- **Inline Verification Flow**: Ensures no automatic or background data commits occur until the admin reviews and clicks **`Validate & Apply Updates`**.
- **Type Safety & Build Verification**: All scripts pass with 0 errors (`npm run type-check`) and 200/200 green Vitest tests (`npm test`).
