#!/usr/bin/env bash
# scripts/deploy-edge-functions.sh
#
# Deploys the Edge Functions a push changed. Run by the CI `deploy` job, after
# every other job is green (short-term plan, phase 5). It replaces the
# pre-push hook, which deployed from the developer's machine BEFORE CI had run:
# a red build could already be live.
#
#   deploy-edge-functions.sh <base-sha> <head-sha>
#
# Needs SUPABASE_ACCESS_TOKEN (GitHub secret) and SUPABASE_PROJECT_REF.
#
# What gets deployed:
#   - anything under supabase/functions/_shared/, or supabase/config.toml
#     (where verify_jwt is declared)          -> every function;
#   - any file under supabase/functions/<fn>/ -> that function. The hook only
#     looked at index.ts, so a change to a function's other files never shipped;
#   - any other supabase/functions/_<dir>/ (e.g. _test) -> nothing;
#   - an unknown base (first push, force-push) -> every function.
#
# NOTE ON verify_jwt -- do not add `--no-verify-jwt` back.
#   The old hook passed it on every deploy, forcing verify_jwt = false onto ALL
#   functions whatever supabase/config.toml declares. That is the root cause of
#   audit finding M1: `admin-accounts`, the role provisioner, ran publicly.
#   Without the flag the CLI reads the per-function value from config.toml.
#   tests/deploy_edge_functions.test.js fails if the flag comes back.

set -euo pipefail

BASE="${1:-}"
HEAD="${2:-HEAD}"
FUNCTIONS_DIR="supabase/functions"

: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is not set}"
if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  # Fail visibly: a silent skip is how the deployed code drifted from the
  # repository before (ADR-017).
  echo "::error::SUPABASE_ACCESS_TOKEN is not set: nothing was deployed. Create the repository secret."
  exit 1
fi

# Enumerated from the filesystem, never hand-maintained: a stale name in a
# literal list makes the deploy fail, and a missing one never ships.
ALL_FUNCTIONS=()
while IFS= read -r d; do
  fn=$(basename "$d")
  [[ "$fn" == _* ]] && continue
  ALL_FUNCTIONS+=("$fn")
done < <(find "${FUNCTIONS_DIR}" -mindepth 1 -maxdepth 1 -type d | sort)

DEPLOY_ALL=false
DEPLOY_FUNCTIONS=()

if [[ -z "$BASE" || "$BASE" =~ ^0+$ ]] || ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then
  echo "Base commit unknown: deploying every function."
  DEPLOY_ALL=true
else
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if [[ "$f" == "${FUNCTIONS_DIR}/_shared/"* || "$f" == "supabase/config.toml" ]]; then
      DEPLOY_ALL=true
      break
    fi
    if [[ "$f" == "${FUNCTIONS_DIR}/"*/* ]]; then
      fn=$(echo "$f" | cut -d'/' -f3)
      # Other `_` directories (_test: the in-memory Supabase the handler tests
      # run against) are not functions and are imported by none.
      [[ "$fn" == _* ]] && continue
      # A function deleted in this push has nothing left to deploy.
      [[ -d "${FUNCTIONS_DIR}/${fn}" ]] && DEPLOY_FUNCTIONS+=("$fn")
    fi
  done < <(git diff --name-only "$BASE" "$HEAD")
fi

if [[ "$DEPLOY_ALL" == true ]]; then
  DEPLOY_FUNCTIONS=("${ALL_FUNCTIONS[@]}")
fi

if [[ "${#DEPLOY_FUNCTIONS[@]}" -eq 0 ]]; then
  echo "No Edge Function changed: nothing to deploy."
  exit 0
fi

DEDUPED=()
while IFS= read -r fn; do
  [[ -z "$fn" ]] && continue
  DEDUPED+=("$fn")
done < <(printf '%s\n' "${DEPLOY_FUNCTIONS[@]}" | sort -u)

echo "Deploying ${#DEDUPED[@]} function(s): ${DEDUPED[*]}"

FAILED=()
for fn in "${DEDUPED[@]}"; do
  echo "::group::${fn}"
  if supabase functions deploy "$fn" --project-ref "$SUPABASE_PROJECT_REF"; then
    echo "deployed ${fn}"
  else
    # One retry: transient network errors are the common failure.
    sleep 5
    if supabase functions deploy "$fn" --project-ref "$SUPABASE_PROJECT_REF"; then
      echo "deployed ${fn} (retry)"
    else
      FAILED+=("$fn")
    fi
  fi
  echo "::endgroup::"
done

if [[ "${#FAILED[@]}" -gt 0 ]]; then
  echo "::error::Deploy failed for: ${FAILED[*]}"
  exit 1
fi
echo "All ${#DEDUPED[@]} function(s) deployed."
