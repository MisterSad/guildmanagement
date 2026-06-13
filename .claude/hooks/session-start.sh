#!/bin/bash
# SessionStart hook: validate this no-build static site.
# No package manager (vanilla JS PWA); node is the only requirement, so there
# is nothing to install. We run the project validator and surface its output
# WITHOUT blocking the session (always exit 0).
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

if ! command -v node >/dev/null 2>&1; then
  echo "session-start: node not found; skipping project validation."
  exit 0
fi

echo "session-start: running tools/check.js (syntax + i18n + asset refs)…"
if node tools/check.js; then
  echo "session-start: project validation passed."
else
  echo "session-start: tools/check.js reported issues above (not blocking the session)."
fi
exit 0
