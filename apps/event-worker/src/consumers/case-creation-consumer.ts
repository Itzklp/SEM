import { randomUUID } from 'node:crypto';

import {
  caseCreatedEvent,
  deterministicEventId,
  TOPIC_FOR_EVENT_TYPE,
  transactionDecidedEvent,
} from '@fraudguard/contracts';
import type { CaseRepository } from '@fraudguard/persistence';
import type { Logger } from 'pino';

/**
 * Kafka topic catalogue: `transaction.decided`'s case-creation consumer
 * (FR-010) — creates exactly one `FraudCase` per `REVIEW` decision.
 * Idempotency (RISK-005) comes from `fraud_cases.transaction_id`'s
 * UNIQUE constraint, not from `caseId` — `caseId` is a fresh random UUID
 * on every delivery (including retries of the same event), and that is
 * fine: `CaseRepository.createIfAbsent` only keeps the FIRST case it
 * successfully inserts for a given `transactionId`, discarding any
 * caseId a later, duplicate attempt generated.
 *
 * The outgoing `fraud.case.created` event IS keyed deterministically
 * (`deterministicEventId(transactionId, ...)`), because that one has to
 * dedup correctly downstream (`review-api`'s queue) regardless of which
 * delivery attempt produced it.
 *
 * `message` is the FULL event envelope, not just its inner payload — see
 * `feature-update-consumer.ts`'s doc comment for why that distinction is
 * load-bearing here (caught by this file's own integration test).
 */
export async function handleTransactionDecidedForCaseCreation(
  caseRepository: CaseRepository,
  message: unknown,
  logger: Logger,
): Promise<void> {
  const { payload: event } = transactionDecidedEvent.parse(message);
  if (event.decision !== 'REVIEW') {
    return;
  }

  const caseId = randomUUID();
  const createdAt = new Date();
  const eventId = deterministicEventId(event.transactionId, 'fraud.case.created');

  const outboxEvent = {
    eventId,
    aggregateId: event.transactionId,
    eventType: 'fraud.case.created',
    topic: TOPIC_FOR_EVENT_TYPE['fraud.case.created'],
    partitionKey: event.transactionId,
    payload: caseCreatedEvent.parse({
      eventId,
      eventType: 'fraud.case.created',
      aggregateId: event.transactionId,
      occurredAt: createdAt.toISOString(),
      traceId: event.transactionId,
      payload: { caseId, transactionId: event.transactionId },
    }),
  };

  const result = await caseRepository.createIfAbsent(
    caseId,
    event.transactionId,
    createdAt,
    outboxEvent,
  );

  if (result.wasExisting) {
    logger.info(
      { transactionId: event.transactionId, caseId: result.fraudCase.caseId },
      'Case already existed for this transaction — duplicate delivery, no-op (RISK-005)',
    );
  } else {
    logger.info(
      { transactionId: event.transactionId, caseId: result.fraudCase.caseId },
      'Created fraud case for REVIEW decision',
    );
  }
}
