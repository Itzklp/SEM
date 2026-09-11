import {
  deterministicEventId,
  TOPIC_FOR_EVENT_TYPE,
  transactionDecidedEvent,
  transactionReceivedEvent,
} from '@fraudguard/contracts';
import type { FraudDecision, Transaction } from '@fraudguard/domain';
import type { OutboxEventInput } from '@fraudguard/persistence';

/**
 * ADR-006: the two outgoing events this system ever produces for an
 * authorization, built here and written by `TransactionRepository
 * .insertScored` in the SAME transaction as the decision itself — so a
 * decision can never exist durably without its outbox row existing too.
 *
 * `traceId` is a placeholder (`transactionId`) rather than a real
 * per-request trace id — Phase 7 wires actual request-scoped tracing
 * (`requestId`/`traceId` through pino/OpenTelemetry); until then, this is
 * honestly a stand-in, not a claim of real distributed tracing.
 *
 * Uses each event schema's `.parse()` (throws on invalid), not
 * `.safeParse()` — this is the system's OWN construction from data it
 * just validated and scored, so a failure here is a bug in this
 * function, not malformed input, and should surface loudly rather than
 * be swallowed.
 */
export function buildOutboxEvents(
  transaction: Transaction,
  decision: FraudDecision,
): OutboxEventInput[] {
  const receivedEnvelope = transactionReceivedEvent.parse({
    eventId: deterministicEventId(transaction.transactionId, 'transaction.received'),
    eventType: 'transaction.received',
    aggregateId: transaction.transactionId,
    occurredAt: transaction.timestamp.toISOString(),
    traceId: transaction.transactionId,
    payload: {
      transactionId: transaction.transactionId,
      userId: transaction.userId,
      merchantId: transaction.merchantId,
      deviceId: transaction.deviceId,
      amount: { minorUnits: transaction.amount.minorUnits, currency: transaction.amount.currency },
      ipAddress: transaction.ipAddress,
      timestamp: transaction.timestamp.toISOString(),
    },
  });

  const decidedEnvelope = transactionDecidedEvent.parse({
    eventId: deterministicEventId(transaction.transactionId, 'transaction.decided'),
    eventType: 'transaction.decided',
    aggregateId: transaction.transactionId,
    occurredAt: decision.decidedAt.toISOString(),
    traceId: transaction.transactionId,
    payload: {
      transactionId: transaction.transactionId,
      userId: transaction.userId,
      merchantId: transaction.merchantId,
      deviceId: transaction.deviceId,
      amount: { minorUnits: transaction.amount.minorUnits, currency: transaction.amount.currency },
      ipAddress: transaction.ipAddress,
      timestamp: transaction.timestamp.toISOString(),
      decision: decision.decision,
      riskScore: decision.riskScore.value,
      policyVersion: decision.policyVersion,
      modelVersion: decision.modelVersion,
      scoringProvider: decision.scoringProvider,
      degraded: decision.degraded,
      degradedReason: decision.degradedReason,
    },
  });

  return [
    {
      eventId: receivedEnvelope.eventId,
      aggregateId: receivedEnvelope.aggregateId,
      eventType: receivedEnvelope.eventType,
      topic: TOPIC_FOR_EVENT_TYPE['transaction.received'],
      partitionKey: transaction.transactionId,
      payload: receivedEnvelope,
    },
    {
      eventId: decidedEnvelope.eventId,
      aggregateId: decidedEnvelope.aggregateId,
      eventType: decidedEnvelope.eventType,
      topic: TOPIC_FOR_EVENT_TYPE['transaction.decided'],
      partitionKey: transaction.transactionId,
      payload: decidedEnvelope,
    },
  ];
}
