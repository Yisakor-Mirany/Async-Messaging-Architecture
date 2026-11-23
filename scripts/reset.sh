#!/usr/bin/env bash
# DESTRUCTIVE: stops everything and deletes the PostgreSQL and RabbitMQ volumes
# (all jobs and queued messages), then rebuilds and starts a clean stack.
# Usage: ./scripts/reset.sh
set -euo pipefail
cd "$(dirname "$0")/.."
read -r -p "This deletes ALL jobs and queued messages. Type 'reset' to continue: " answer
[ "$answer" = "reset" ] || { echo "Aborted."; exit 1; }
docker compose down -v --remove-orphans
docker compose up --build -d
docker compose ps
