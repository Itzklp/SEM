import { transactionDecidedEvent } from '@fraudguard/contracts';
import { Money, RiskScore, type FraudDecision, type Transaction } from '@fraudguard/domain';
import { recordTransactionFeatures } from '@fraudguard/feature-store';
import type { Redis } from 'ioredis';

/**
 * Kafka topic catalogue: `transaction.decided`'s feature-update consumer.
 * `recordTransactionFeatures` (Phase 4, `packages/feature-store`) is
 * idempotent by construction (ZADD/HSET keyed by transactionId, SETNX
 * for first-seen) — a duplicate delivery of the same event changes
 * nothing, which is what makes this consumer safe under at-least-once
 * delivery (ADR-006) without a separate eventId dedup table.
 *
 * `paymentMethod` is not part of `transactionDecidedEvent`'s payload (it
 * carries what feature computation actually needs, not the full original
 * request) and `recordTransactionFeatures` never reads it — an empty
 * string here is a genuinely unused field, not a silently wrong value.
 *
 * `message` is the FULL event envelope (`{eventId, eventType,
 * aggregateId, occurredAt, traceId, payload}`) — the same shape every
 * consumer in this app receives, because that is what
 * `TransactionRepository.insertScored` stored in `outbox_events.payload`
 * and what the relay publishes byte-for-byte (`outbox-relay.ts`'s doc
 * comment). Parsed with the full schema, not `.shape.payload` alone —
 * `.shape.payload` describes what's AT `message.payload`, not `message`
 * itself, and parsing the whole envelope against only its inner shape
 * fails every field as "Required". Caught live by this file's own
 * integration test, not by inspection.
 */
export async function handleTransactionDecided(redis: Redis, message: unknown): Promise<void> {
  const { payload: event } = transactionDecidedEvent.parse(message);

  const transaction: Transaction = {
    transactionId: event.transactionId,
    userId: event.userId,
    merchantId: event.merchantId,
    deviceId: event.deviceId,
    amount: Money.of(event.amount.minorUnits, event.amount.currency),
    ipAddress: event.ipAddress,
    paymentMethod: '',
    timestamp: new Date(event.timestamp),
    status: 'DECIDED',
  };

  const decision: FraudDecision = {
    transactionId: event.transactionId,
    decision: event.decision,
    riskScore: RiskScore.of(event.riskScore),
    reasons: [],
    policyVersion: event.policyVersion,
    modelVersion: event.modelVersion,
    scoringProvider: event.scoringProvider,
    degraded: event.degraded,
    degradedReason: event.degradedReason,
    decidedAt: new Date(event.timestamp),
    processingTimeMs: 0,
  };

  await recordTransactionFeatures(redis, transaction, decision);
}
