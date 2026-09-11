/**
 * eventType -> Kafka topic name. Most match (`transaction.received`'s
 * eventType and topic are the same string); two do not —
 * `fraud.case.created` publishes to topic `review.created`, and
 * `fraud.case.reviewed` publishes to `review.completed` — see
 * `docs/architecture/kafka-topics.md`'s topic summary table, the single
 * source of truth this mirrors.
 *
 * DELIBERATE DEVIATION from that catalogue, recorded here rather than
 * silently: the catalogue also names a generic `audit.events` topic,
 * produced by "every service, via outbox relay, for any state-changing
 * action" alongside its domain-specific event. Phase 6 does not build
 * that second, parallel write — `apps/event-worker`'s audit-persistence
 * consumer instead subscribes directly to the domain-specific topics
 * below and derives its own `audit_events` rows from them. This halves
 * outbox writes and avoids a topic whose only consumer would otherwise
 * duplicate information already on the topics it re-publishes. FR-008
 * ("every decision retrievable with its full basis") is unaffected — the
 * durable record ends up in the same table either way. Revisit if a
 * future consumer genuinely needs the generic shape (e.g. Phase 10's
 * model-registry auditing) rather than a specific one.
 */
export const TOPIC_FOR_EVENT_TYPE = {
  'transaction.received': 'transaction.received',
  'transaction.decided': 'transaction.decided',
  'fraud.case.created': 'review.created',
  'fraud.case.reviewed': 'review.completed',
} as const;

export type KnownEventType = keyof typeof TOPIC_FOR_EVENT_TYPE;

/** kafka-init's naming convention (`create-topics.sh`): every catalogue topic has a matching `<topic>.dlq`. */
export function dlqTopicFor(topic: string): string {
  return `${topic}.dlq`;
}
