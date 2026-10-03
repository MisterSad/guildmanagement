#!/usr/bin/env bash
# scripts/replay-migrations.sh
#
# Replays the whole migration chain on an EMPTY PostgreSQL 17 (audit DB-03).
# Never point it at production: it is meant for a throwaway database, the CI
# service container or a local `docker run postgres:17`.
#
#   1. supabase/replay/prelude.sql provides what Supabase normally does
#      (roles, auth/vault/cron/net/storage stand-ins);
#   2. every supabase/migrations/*.sql runs in version order, each in its own
#      transaction, stopping at the first error.
#
# Connection: the usual libpq variables (PGHOST, PGUSER, PGPASSWORD,
# PGDATABASE). `gm.replay = on` is set for the whole run: the drift guards in
# applied migrations read it to tell an empty replay from production.
#
# Local run:
#   docker run -d --name gm-replay -e POSTGRES_PASSWORD=postgres -v "$PWD":/repo postgres:17
#   docker exec -e PGUSER=postgres gm-replay bash /repo/scripts/replay-migrations.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGOPTIONS="${PGOPTIONS:-} -c gm.replay=on -c client_min_messages=warning"
PSQL=(psql -X -q -v ON_ERROR_STOP=1)

echo "prelude"
"${PSQL[@]}" -f "$ROOT/supabase/replay/prelude.sql"

n=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  n=$((n + 1))
  printf '%4d %s\n' "$n" "$(basename "$f")"
  "${PSQL[@]}" -1 -f "$f"
done

echo "replayed $n migrations"
