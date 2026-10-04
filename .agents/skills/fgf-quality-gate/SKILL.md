---
name: fgf-quality-gate
description: >-
  The verification battery this repository requires before any change is called done.
  Use before finalizing any code modification, completing a user prompt, or opening a pull request.
---

# FGF Quality Gate

## The battery

```bash
npm run lint           # biome ci . — lint + format check, 0 errors
npm run type-check     # tsc --noEmit — 0 errors, no exceptions
npm test               # vitest run, all green, plus a coverage floor
npm run build          # production build into dist/
npx playwright test    # e2e, against the REAL built bundle in dist/
```

The e2e suite is not optional and not a nicety. `playwright.config.js` runs `npm run build`, then serves `dist/` with the headers `vercel.json` gives production (`scripts/e2e-serve-config.mjs` generates the serve config), and `e2e/fixtures.js` fails any test on a CSP violation the browser reports. It exercises the actual production artifact — it is the only check in this repo that would catch a CSP violation, a 404 stylesheet, or a bundling regression. Several defects in the 2026-09 audit were invisible to `tsc` and to Vitest and visible only there.

`npm test` enforces a coverage floor (`vitest.config.js` → `coverage.thresholds`). It is a **ratchet**: raise it when real coverage rises comfortably above it, never set it to the current value (it then fails on noise) and never set it aspirationally (it fails immediately and gets deleted).

## Before claiming a change works

**Verification-first is the rule this project is built on, because the audit that shaped it found more false claims than broken code.**

- **Measure, do not describe.** Before writing that something is true of the database, the deployed functions, or production, query it. `ARCHITECTURE.md` carried volumetrics wrong by a factor of two for months because nobody re-counted.
- **A test that has never failed has proved nothing.** Break the thing on purpose, watch the test fail by name, then restore it. Assertions in this repo have passed against deliberately sabotaged code more than once: an icon-width check passed with the glyph removed (a missing glyph renders `.notdef` at normal width), and a build-step check passed after the step was deleted because the file's *comments* still mentioned the path.
- **Strip comments before asserting absence.** Explanatory prose describing what was removed will match a grep for the removed thing. This has caused a false failure roughly five times.
- **Assert on the DOM, not on `innerHTML`, for escaping.** `esc()` writes `&lt;img`, the parser decodes it into an attribute value, and re-serialising prints `<` raw again. Searching the serialised output looks right and proves nothing; assert that no live element was constructed.
- **Never fabricate a result, a row count, or a passing run.** If something fails, say so and show the output. If a step was skipped, say it was skipped.

## Regression checklist

1. **Zero console errors** in the e2e run — `e2e/boot.spec.js` asserts `pageErrors === []`.
2. **No per-tenant branching.** `grep -rn "=== 'ALPHA'" src/` must return nothing in domain logic. An unresolved tenant must fail visibly (`getActiveGuild()` returns `null` and writes are blocked), never fall back to a real guild.
3. **Views are torn down.** A view that subscribes to a Realtime channel must implement `destroy()`, and the router's `TEARDOWN_BY_TAB` must map its tab to it.
4. **New event-session logic has a test** covering the ID format.
5. **Schema change?** Scan `pg_get_functiondef` for dependents before dropping anything, then regenerate `src/types/database.generated.ts`. A dropped table whose name survives in a function body breaks a cron at 03:00, silently.

## Never

- Never run a destructive probe against production. `execute_sql` **autocommits** — an `UPDATE`/`DELETE` pair written as a "temporary" verification is permanent. This has destroyed real rows on this project. Test destructive behaviour on a replayed database (`scripts/replay-migrations.sh`, then `scripts/sql-tests.sh`); on production, only inside a dry run that ends in a raised exception so the batch rolls back. The `DEMO` sandbox tenant was removed on 2026-10-04.
- Never commit or push unless asked.
