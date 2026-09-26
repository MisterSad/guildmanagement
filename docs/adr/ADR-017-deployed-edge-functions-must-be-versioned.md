# ADR-017: Every Deployed Edge Function Must Have Its Source Versioned Here

- **Status**: Accepted
- **Date**: 2026-09-27
- **Authors**: Executed across Phases 0–1, recorded in Phase 9

---

## 1. Context

This is the rule whose absence produced the two most serious governance findings of the 2026-09 audit.

`gm-revolut-webhook` was **ACTIVE, version 13, `verify_jwt = false`** — a public endpoint serving production traffic, able to call `gm_apply_subscription_payment`, with **no source anywhere in this repository**. Only the platform held its code. `webauthn-spike` was the same story at lower severity: ACTIVE, version 6, a leftover probe nobody had cleaned up.

Worse than their existence: **`ARCHITECTURE.md` asserted in a warning box that `gm-revolut-webhook` did not exist** and instructed readers to keep it out of deployment matrices. The documentation did not merely fail to mention unreviewed public code — it actively told maintainers to ignore it.

Drift ran the other way too:

- `ocr-guild-members` was last deployed **two days before** the migration that created the cache table it reads. The ADR-012 cache was documented, tested and billed in Gemini quota while **not existing in the deployed binary** — proved from `function_logs`, where the log lines bracketing the cache block never once appeared (finding H1).
- `admin-accounts` was deployed `verify_jwt = false` while `supabase/config.toml` declared `true` and this document classified it "JWT-Gated" (finding M1). Not a hole — the handler re-verifies — but a layer of defence silently absent on the role provisioner.

The common cause is that the deployed set was reconciled against **prose**, and prose does not know what is running.

## 2. Decision

**Every Edge Function running on the platform must have its source committed in `supabase/functions/`.** A function with no source in this repository is to be deleted from the platform, not documented around.

Corollaries:

1. **Reconcile against the platform, never against a document.** The check is `list_edge_functions` compared to `ls supabase/functions/`, in both directions. A function in the repo but not deployed is as much a finding as the reverse.
2. **`config.toml` is the declaration of `verify_jwt`, and the deployed value must match it.** Where a handler also verifies the JWT itself, that is defence in depth and does not excuse the platform setting.
3. **A migration that a function depends on must be followed by a deploy of that function.** The `pre-push` hook on `main` (`scripts/hooks/pre-push`) automates this; note that any change under `_shared/` redeploys **all** functions.
4. **Never document a function as absent.** If it cannot be found, look at the platform before writing that it does not exist.

## 3. Consequences & Invariants

- **Reconciled 2026-09-27: 15 deployed, 15 in the repository, zero drift in either direction.** `admin-accounts` is now genuinely `verify_jwt = true`.
- `tests/supabase_config_functions.test.js` enforces the repo-internal half — every directory has a `[functions.*]` block and every block has a directory. **Nothing in CI can see the platform**, so the deployed-vs-repo comparison is a runbook step (`docs/DEPLOY_RUNBOOK.md`), performed at every release, not a test. Do not mistake a green CI for a reconciled platform.
- Deleting a function from the repository does **not** remove it from the platform. Remove it there too, and remove its `[functions.*]` block, or `tests/supabase_config_functions.test.js` fails.
