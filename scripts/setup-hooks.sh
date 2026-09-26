#!/usr/bin/env bash
# scripts/setup-hooks.sh
#
# Installs the pre-push git hook for Supabase Edge Function auto-deploy.
# Run this once after cloning the repo:
#
#   bash scripts/setup-hooks.sh
#
# The hook auto-deploys affected Edge Functions on every push to main:
#   - _shared/ changed  → deploys ALL functions (avoids version drift)
#   - Only function index.ts changed → deploys only that function
#   - No function files changed → no-op, push proceeds instantly

set -euo pipefail

HOOK_SRC="scripts/hooks/pre-push"

# Resolve the real hooks directory instead of assuming `.git/` is one. Inside a
# git WORKTREE `.git` is a FILE pointing at the worktree's admin directory, so
# the old hardcoded `.git/hooks/pre-push` failed with "Not a directory" and the
# hook silently stayed at whatever version was installed last -- which is how the
# installed copy came to still name three Edge Functions deleted in phase 1.
# `--git-common-dir` gives the shared directory, which is where hooks live for
# every worktree.
HOOK_DIR="$(git rev-parse --git-common-dir)/hooks"
HOOK_DST="${HOOK_DIR}/pre-push"

if [[ ! -f "$HOOK_SRC" ]]; then
  echo "❌ Source hook not found at $HOOK_SRC"
  exit 1
fi

mkdir -p "$HOOK_DIR"
cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"
echo "✅ pre-push hook installed at $HOOK_DST"
echo "   Auto-deploy will trigger on every push to main that touches supabase/functions/."
