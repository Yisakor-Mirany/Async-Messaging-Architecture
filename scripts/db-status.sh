#!/usr/bin/env bash
# Prints job counts per status, the outbox backlog and the 10 latest jobs.
# Usage: ./scripts/db-status.sh
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
SELECT status, COUNT(*) AS jobs FROM jobs GROUP BY status ORDER BY status;
SELECT COUNT(*) AS outbox_unpublished FROM outbox WHERE published_at IS NULL;
SELECT id, report_type, status, attempts, progress, created_at, completed_at, failed_at
  FROM jobs ORDER BY created_at DESC LIMIT 10;
SQL
