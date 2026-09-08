#!/bin/sh
# FraudGuard — Kafka topic bootstrap.
#
# Run once by the `kafka-init` service in docker-compose.yml, which depends
# on `kafka` being healthy and exits after this script completes — it is
# not a long-running process. Idempotent: `--if-not-exists` means re-running
# on an already-bootstrapped broker (e.g. after `pnpm docker:down` without
# `docker:reset`) is a no-op, not an error.
#
# Topic list, partition/retention rationale: docs/architecture/kafka-topics.md
# — this script is that catalogue made executable, not a second source of truth.
set -eu

BROKER="${KAFKA_BROKERS:-kafka:9092}"
PARTITIONS="${KAFKA_TOPIC_PARTITIONS:-3}"
REPLICATION="${KAFKA_TOPIC_REPLICATION_FACTOR:-1}"
KAFKA_BIN=/opt/kafka/bin

echo "Waiting for Kafka at ${BROKER}..."
until "${KAFKA_BIN}/kafka-broker-api-versions.sh" --bootstrap-server "${BROKER}" >/dev/null 2>&1; do
  sleep 2
done
echo "Kafka is reachable. Creating topics (partitions=${PARTITIONS}, replication=${REPLICATION})..."

# name:retention_ms — retention values from docs/architecture/kafka-topics.md's
# per-topic tables (7d / 30d / 90d, in milliseconds).
TOPICS="
transaction.received:604800000
transaction.decided:604800000
review.created:2592000000
review.completed:2592000000
audit.events:7776000000
model.updated:7776000000
"

# Dead-letter topics: same retention as their source topic, no ordering
# requirement (ADR-006 §Kafka catalogue "Dead-letter strategy" per topic).
DLQ_TOPICS="
transaction.received.dlq:604800000
transaction.decided.dlq:604800000
review.created.dlq:2592000000
review.completed.dlq:2592000000
audit.events.dlq:7776000000
model.updated.dlq:7776000000
"

create_topic() {
  name="$1"
  retention="$2"
  "${KAFKA_BIN}/kafka-topics.sh" --bootstrap-server "${BROKER}" \
    --create --if-not-exists \
    --topic "${name}" \
    --partitions "${PARTITIONS}" \
    --replication-factor "${REPLICATION}" \
    --config "retention.ms=${retention}"
  echo "  ✓ ${name} (retention.ms=${retention})"
}

for entry in ${TOPICS} ${DLQ_TOPICS}; do
  topic_name="${entry%%:*}"
  topic_retention="${entry##*:}"
  create_topic "${topic_name}" "${topic_retention}"
done

echo "Topic bootstrap complete. Current topics:"
"${KAFKA_BIN}/kafka-topics.sh" --bootstrap-server "${BROKER}" --list
