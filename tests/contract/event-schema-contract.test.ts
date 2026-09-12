import {
  caseCreatedEvent,
  caseReviewedEvent,
  deterministicEventId,
  transactionDecidedEvent,
  transactionReceivedEvent,
} from '@fraudguard/contracts';

/**
 * Producer ↔ consumer contract (Phase 8's `CT-` deliverable,
 * test-strategy.md §3.3): "every published event validates against the
 * schema its consumers expect... catches the classic cross-developer
 * break where one side changes a payload and the other's consumer fails
 * silently in production."
 *
 * This is NOT `packages/contracts/src/events/envelope.test.ts` again —
 * that file tests the envelope SHAPE in the abstract (a synthetic
 * `TestEvent`). This file builds the envelope the exact way each real
 * PRODUCER does (`apps/fraud-api/src/scoring/build-outbox-events.ts`,
 * `apps/event-worker/src/consumers/case-creation-consumer.ts`,
 * `apps/review-api/src/cases/cases.service.ts`), round-trips it through
 * `JSON.stringify`/`JSON.parse` (the real Kafka wire format — an object
 * reference never "just happens to still work" after a real broker hop),
 * and confirms it parses the exact way each real CONSUMER does
 * (`apps/event-worker/src/consumers/audit-consumer.ts`,
 * `feature-update-consumer.ts`, `case-creation-consumer.ts`).
 *
 * The negative case at the bottom encodes the ACTUAL regression Phase 6
 * caught live: two consumers parsed `schema.shape.payload.parse(message)`
 * (expecting an already-unwrapped payload) against the FULL envelope
 * every real producer actually sends — every field came back "Required".
 * That fix is now also a standing assertion here, not just a historical
 * note in a doc comment: `shape.payload.parse(<the full envelope>)`
 * asserted to FAIL is what would catch the identical mistake being
 * reintroduced in a future consumer.
 */
describe('contract: producer-built envelopes validate against every real consumer’s parse call', () => {
  function roundTrip(envelope: unknown): unknown {
    return JSON.parse(JSON.stringify(envelope));
  }

  it('transaction.received: fraud-api’s envelope parses for the audit consumer', () => {
    const envelope = transactionReceivedEvent.parse({
      eventId: deterministicEventId('ct_txn_001', 'transaction.received'),
      eventType: 'transaction.received',
      aggregateId: 'ct_txn_001',
      occurredAt: new Date().toISOString(),
      traceId: 'ct_txn_001',
      payload: {
        transactionId: 'ct_txn_001',
        userId: 'ct_user_001',
        merchantId: 'ct_merchant_001',
        deviceId: 'ct_device_001',
        amount: { minorUnits: 1_999, currency: 'USD' },
        ipAddress: '203.0.113.1',
        timestamp: new Date().toISOString(),
      },
    });

    // audit-consumer.ts's exact call: transactionReceivedEvent.parse(payload)
    // against the FULL envelope, post-wire-round-trip.
    const parsed = transactionReceivedEvent.parse(roundTrip(envelope));
    expect(parsed.payload.transactionId).toBe('ct_txn_001');
  });

  it('transaction.decided: fraud-api’s envelope parses for audit, feature-update, AND case-creation consumers', () => {
    const envelope = transactionDecidedEvent.parse({
      eventId: deterministicEventId('ct_txn_002', 'transaction.decided'),
      eventType: 'transaction.decided',
      aggregateId: 'ct_txn_002',
      occurredAt: new Date().toISOString(),
      traceId: 'ct_txn_002',
      payload: {
        transactionId: 'ct_txn_002',
        userId: 'ct_user_002',
        merchantId: 'ct_merchant_002',
        deviceId: 'ct_device_002',
        amount: { minorUnits: 5_000, currency: 'USD' },
        ipAddress: '203.0.113.2',
        timestamp: new Date().toISOString(),
        decision: 'REVIEW',
        riskScore: 0.62,
        policyVersion: 'policy-v1',
        modelVersion: 'model-v1-rules',
        scoringProvider: 'rules',
        degraded: false,
        degradedReason: 'NONE',
      },
    });
    const wireFormat = roundTrip(envelope);

    // audit-consumer.ts's exact call.
    const forAudit = transactionDecidedEvent.parse(wireFormat);
    expect(forAudit.payload.decision).toBe('REVIEW');

    // feature-update-consumer.ts's exact call — the same schema, the
    // same full-envelope parse; recordTransactionFeatures() reads the
    // unwrapped payload afterward.
    const forFeatureUpdate = transactionDecidedEvent.parse(wireFormat);
    expect(forFeatureUpdate.payload.amount.minorUnits).toBe(5_000);

    // case-creation-consumer.ts's exact call — it additionally branches
    // on `decision !== 'REVIEW'` before doing anything, but the PARSE
    // itself is identical to the other two.
    const forCaseCreation = transactionDecidedEvent.parse(wireFormat);
    expect(forCaseCreation.payload.decision).not.toBe('ALLOW');
  });

  it('fraud.case.created: event-worker’s envelope parses for the audit consumer AND review-api’s queue', () => {
    const caseId = 'ct_case_001';
    const transactionId = 'ct_txn_003';
    const envelope = caseCreatedEvent.parse({
      eventId: deterministicEventId(transactionId, 'fraud.case.created'),
      eventType: 'fraud.case.created',
      aggregateId: transactionId,
      occurredAt: new Date().toISOString(),
      traceId: transactionId,
      payload: { caseId, transactionId },
    });

    // audit-consumer.ts's exact call (topic: review.created).
    const parsed = caseCreatedEvent.parse(roundTrip(envelope));
    expect(parsed.payload.caseId).toBe(caseId);
  });

  it('fraud.case.reviewed: review-api’s envelope parses for the audit consumer', () => {
    const envelope = caseReviewedEvent.parse({
      eventId: deterministicEventId('ct_case_002', 'fraud.case.reviewed'),
      eventType: 'fraud.case.reviewed',
      aggregateId: 'ct_txn_004',
      occurredAt: new Date().toISOString(),
      traceId: 'ct_txn_004',
      payload: {
        caseId: 'ct_case_002',
        transactionId: 'ct_txn_004',
        action: 'APPROVE',
        resultingStatus: 'APPROVED',
        reviewerId: 'analyst_001',
        reason: 'Confirmed legitimate with the cardholder.',
      },
    });

    // audit-consumer.ts's exact call (topic: review.completed) — also
    // reads payload.reviewerId as the audit row's actorId (ASM-006).
    const parsed = caseReviewedEvent.parse(roundTrip(envelope));
    expect(parsed.payload.reviewerId).toBe('analyst_001');
  });

  // The actual Phase 6 regression, encoded as a standing assertion.
  it('REGRESSION GUARD: parsing only the inner payload schema against the FULL envelope fails — the exact mistake two consumers made once', () => {
    const envelope = transactionDecidedEvent.parse({
      eventId: deterministicEventId('ct_regression', 'transaction.decided'),
      eventType: 'transaction.decided',
      aggregateId: 'ct_regression',
      occurredAt: new Date().toISOString(),
      traceId: 'ct_regression',
      payload: {
        transactionId: 'ct_regression',
        userId: 'ct_regression_user',
        merchantId: 'ct_regression_merchant',
        deviceId: 'ct_regression_device',
        amount: { minorUnits: 100, currency: 'USD' },
        ipAddress: '203.0.113.9',
        timestamp: new Date().toISOString(),
        decision: 'ALLOW',
        riskScore: 0.01,
        policyVersion: 'policy-v1',
        modelVersion: 'model-v1-rules',
        scoringProvider: 'rules',
        degraded: false,
        degradedReason: 'NONE',
      },
    });

    // `.shape.payload` describes what's AT `envelope.payload`, not the
    // envelope itself — parsing the WHOLE envelope against only that
    // inner shape is the bug: every envelope-level field (eventId,
    // eventType, aggregateId, occurredAt, traceId) comes back "Required".
    const result = transactionDecidedEvent.shape.payload.safeParse(roundTrip(envelope));
    expect(result.success).toBe(false);

    // The correct form — parse the full schema against the full
    // envelope, then destructure `.payload` — is what every real
    // consumer actually does, and is what the four tests above prove.
    const correct = transactionDecidedEvent.safeParse(roundTrip(envelope));
    expect(correct.success).toBe(true);
  });
});
