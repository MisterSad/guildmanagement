# Scripts Archive

This directory contains legacy and one-off maintenance scripts archived as part of repository cleanup and modernization (`[TICKET-12] [MAINT-01]`).

## Archived Scripts

### `bump_cache_busters.py`
- **Original Purpose**: Scanned `index.html` for `<script src="X.js?v=N">` and `<link rel="stylesheet" href="Y.css?v=N">` and bumped `?v=N` for changed files.
- **Reason for Archiving**: Obsolete. All runtime scripts and CSS are bundled by Vite via `src/main.ts` with content-hashed filenames (`index-[hash].js`, `index-[hash].css`). Manual `?v=` cache busters are no longer needed.

### `analyze_event_ids.py`
- **Original Purpose**: Dry-run migration planner for converting legacy event session IDs to the modern canonical format.
- **Reason for Archiving**: Historical migration script. The migration has been completed and verified. Kept for audit and reference purposes.

### `migrate_event_ids.py`
- **Original Purpose**: Executed the migration of legacy event session IDs in Supabase database tables.
- **Reason for Archiving**: Historical migration script. Kept for historical reference.
