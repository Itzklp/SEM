import {
  deterministicEventId,
  TOPIC_FOR_EVENT_TYPE,
  transactionDecidedEvent,
  transactionReceivedEvent,
} from '@fraudguard/contracts';
import type { FraudDecision, Transaction } from '@fraudguard/domain';
import { captureTraceparent, currentTraceId } from '@fraudguard/observability';
import type { OutboxEventInput } from '@fraudguard/persistence';

/**
 * ADR-006: the two outgoing events this system ever produces for an
 * authorization, built here and written by `TransactionRepository
 * .insertScored` in the SAME transaction as the decision itself — so a
 * decision can never exist durably without its outbox row existing too.
 *
 * `traceId` WAS a placeholder (`transactionId`) rather than a real
 * per-request trace id before Phase 7 — now `currentTraceId()` reads the
 * real OpenTelemetry trace id from the active request span, falling back
 * to `transactionId` only if tracing is disabled (`OTEL_ENABLED=false`)
 * or somehow no span is active. `traceContext` (the full W3C
 * `traceparent`, not just the trace id) is separately captured per event
 * and written to `outbox_events.trace_context` (migration 0003) — that
 * one is what actually lets the relay and every downstream consumer
 * resume this SAME trace; `traceId` on the envelope itself is the
 * human/analyst-facing correlation field, a property of the event's
 * public contract.
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
  const traceId = currentTraceId() ?? transaction.transactionId;
  const traceContext = captureTraceparent();

  const receivedEnvelope = transactionReceivedEvent.parse({
    eventId: deterministicEventId(transaction.transactionId, 'transaction.received'),
    eventType: 'transaction.received',
    aggregateId: transaction.transactionId,
    occurredAt: transaction.timestamp.toISOString(),
    traceId,
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
    traceId,
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
      // `exactOptionalPropertyTypes`: `traceContext?: string` means
      // "string or absent", not "string or undefined" — a conditional
      // spread omits the key entirely when tracing captured nothing,
      // same pattern `packages/messaging/src/kafka-client.ts` uses for
      // its optional `sasl` block.
      ...(traceContext ? { traceContext } : {}),
    },
    {
      eventId: decidedEnvelope.eventId,
      aggregateId: decidedEnvelope.aggregateId,
      eventType: decidedEnvelope.eventType,
      topic: TOPIC_FOR_EVENT_TYPE['transaction.decided'],
      partitionKey: transaction.transactionId,
      payload: decidedEnvelope,
      ...(traceContext ? { traceContext } : {}),
    },
  ];
}
