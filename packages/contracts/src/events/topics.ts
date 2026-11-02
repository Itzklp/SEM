/**
 * eventType -> Kafka topic name. Most match; two don't —
 * `fraud.case.created` publishes to `review.created`, and
 * `fraud.case.reviewed` to `review.completed` (docs/architecture/kafka-topics.md
 * has the full table).
 *
 * Deviation from that catalogue: it also names a generic `audit.events`
 * topic. We skip it — the audit-persistence consumer subscribes directly
 * to the domain-specific topics below and derives `audit_events` rows
 * from them instead, halving outbox writes with no loss to FR-008.
 */
export const TOPIC_FOR_EVENT_TYPE = {
  'transaction.received': 'transaction.received',
  'transaction.decided': 'transaction.decided',
  'fraud.case.created': 'review.created',
  'fraud.case.reviewed': 'review.completed',
  'model.updated': 'model.updated',
} as const;

export type KnownEventType = keyof typeof TOPIC_FOR_EVENT_TYPE;

/** kafka-init's naming convention (`create-topics.sh`): every catalogue topic has a matching `<topic>.dlq`. */
export function dlqTopicFor(topic: string): string {
  return `${topic}.dlq`;
}
