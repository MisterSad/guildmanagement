---
name: fgf-memory-keeper
description: >-
  Where durable knowledge about this project lives and how to add to it.
  Use when recording an architectural decision, a permanent lesson, or a bug whose cause
  would otherwise be rediscovered.
---

# FGF Memory Keeper

## Where knowledge lives

1. **`docs/adr/`** — architectural decisions and permanent lessons. Indexed in `docs/adr/README.md`. **Read the index before any significant refactor**, and read the specific ADR before changing what it governs.
2. **`CHANGELOG.md`** — what changed, when, and *why the obvious thing was wrong*. This file carries the reasoning; it is the reason several audit findings were disproved rather than re-litigated.
3. **`ARCHITECTURE.md`** — the current shape of the system. Numbers in it must be measured, not estimated.

## What is worth writing down

The finding, not the fix. A diff shows what changed; only prose can record **why the obvious approach was wrong**.

Specifically worth recording:

- **A claim that measurement disproved.** A large share of the 2026-09 audit's findings were not defects: the participation band, the squad caps, the "contradictory" event coefficients, duplicate badge names, most of the "dead code". Writing down *"this looked wrong and is not, here is the measurement"* is what stops it being re-investigated every quarter.
- **A defect no test could have caught**, and what would now catch it. 42 icons that drew nothing. A pre-warm function that had never once run because it probed a name that did not exist. An `AbortSignal` that was never wired.
- **An ordering that is load-bearing.** Ship the self-unregistering `sw.js` before deleting `src/sw/`. Bump `session_version` inside the RPC, then mint the session. Anonymise by renaming the roster row, never by deleting it first.
- **A mistake and its cost.** A verification probe that ran `UPDATE`/`DELETE` unwrapped against production destroyed four real rows, permanently, because `execute_sql` autocommits and the plan had no PITR. That is written down precisely so it is never repeated.

## What is not worth writing down

Anything the repository already records: code structure, git history, a fix visible in a diff. If asked to remember something already in the code, record instead what was *non-obvious* about it.

## Anti-regression protocol

Before touching `src/core/config/events.ts`, `src/core/api/supabase.ts`, `src/core/state/app-state.ts`, `src/core/api/db-guard.ts` or `supabase/migrations/`:

1. Read the relevant ADR.
2. Keep the two session-ID definitions (TypeScript and Postgres) identical.
3. For a schema change: scan `pg_get_functiondef` for dependents **before** dropping anything, then regenerate `src/types/database.generated.ts`. A dropped table whose name survives inside a function body breaks a cron at 03:00 with nobody watching — this has happened twice.
4. Run the full gate (see `fgf-quality-gate`).

## Honesty

Report outcomes as they are. If tests fail, show the output. If a step was skipped, say so. If a claim in a document turns out to be false, correct the document rather than working around it — a published document that is wrong is worse than one that is silent, and this project has shipped both.
