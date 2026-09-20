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
HOOK_DST=".git/hooks/pre-push"

if [[ ! -f "$HOOK_SRC" ]]; then
  echo "❌ Source hook not found at $HOOK_SRC"
  exit 1
fi

cp "$HOOK_SRC" "$HOOK_DST"
chmod +x "$HOOK_DST"
echo "✅ pre-push hook installed at $HOOK_DST"
echo "   Auto-deploy will trigger on every push to main that touches supabase/functions/."
