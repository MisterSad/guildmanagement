#!/usr/bin/env bash
# scripts/sql-tests.sh
#
# Runs supabase/tests/*.sql against a database built by
# scripts/replay-migrations.sh (audit QA-01, QA-02). Never point it at
# production: every file creates its own fixtures, inside a transaction that
# ends in ROLLBACK, but the helpers themselves are installed for good.
#
# Each assertion prints "ok - <what>"; the first failure stops the file and
# the run (ON_ERROR_STOP), and the script exits non-zero.
#
# Connection: the usual libpq variables, as for replay-migrations.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=notice"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -f "$ROOT/supabase/tests/_helpers.sql" 2>&1 | grep -v 'already exists, skipping' || true

files=0
asserts=0
for f in "$ROOT"/supabase/tests/[0-9]*.sql; do
  files=$((files + 1))
  name="$(basename "$f")"
  if ! out="$("${PSQL[@]}" -f "$f" 2>&1)"; then
    echo "$out" | grep -E 'ok - |FAILED|ERROR' | sed "s|^|$name: |"
    echo "FAIL $name"
    exit 1
  fi
  n="$(echo "$out" | grep -c 'ok - ' || true)"
  asserts=$((asserts + n))
  printf 'PASS %-40s %3d assertions\n' "$name" "$n"
done

echo "SQL tests: $files files, $asserts assertions, all passed."
