---
description: Run the full mandatory verification battery (unit tests, security matrix, anon scan, e2e smoke) and report results.
agent: tester
---

Run the full AGENTS.md §6 verification battery and report results.

1. **Unit tests**: `npm install` then `npm test`. All 135 tests must pass.
2. **Security regression matrix (§6.2)**: after any backend/security change,
   create temporary accounts (super_admin / guild_admin OMEGA / member ALPHA),
   verify the matrix with curl against the live Supabase REST API, then clean
   up the accounts.
3. **Anonymous surface scan (§6.3)**: query anon-executable functions and
   anon-granted tables; every anon-executable function must be identity
   checked or harmless, every anon-granted table must return `[]`.
4. **End-to-end smoke (§6.4)**: register player → approve → login → dashboard
   loads, charts draw, Active Events submits scores, absence + timezone save,
   transfer request; reload keeps the session; non-ALPHA admin works.

Report: `PASS` / `FAIL` per stage with the exact output that matters. If a
stage fails, identify the root cause and file/line. Do not edit files; report
back to the build agent.
