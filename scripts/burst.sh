#!/usr/bin/env bash
# Submits N jobs concurrently with curl and prints each HTTP status + latency.
# Usage: ./scripts/burst.sh [count] [api-url]
set -euo pipefail
COUNT="${1:-5}"
API="${2:-http://localhost:3000}"
BODY='{"reportType":"sales_summary","parameters":{"startDate":"2026-01-01","endDate":"2026-01-31"},"requestedBy":"burst-script"}'
for i in $(seq 1 "$COUNT"); do
  curl -s -o /dev/null -w "job $i -> HTTP %{http_code} in %{time_total}s\n" \
    -X POST "$API/api/jobs" -H 'Content-Type: application/json' -d "$BODY" &
done
wait
