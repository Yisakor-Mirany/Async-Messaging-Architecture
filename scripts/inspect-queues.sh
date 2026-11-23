#!/usr/bin/env bash
# Shows queue depths, consumers and DLQ size using rabbitmqctl inside the container.
# Usage: ./scripts/inspect-queues.sh
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T rabbitmq rabbitmqctl list_queues -q \
  name durable messages_ready messages_unacknowledged consumers arguments
echo
echo "Consumers (prefetch):"
docker compose exec -T rabbitmq rabbitmqctl list_consumers -q queue_name channel_pid prefetch_count ack_required
