import { loadConfig } from '@fraudguard/config';
import { fraudCaseSchema, type FraudCaseDto, type ScoreRequest } from '@fraudguard/contracts';
import { setMerchantRiskScore } from '@fraudguard/feature-store';
import { createKafkaClient, createProducer, type Producer } from '@fraudguard/messaging';
import {
  AuditRepository,
  CaseRepository,
  closePersistenceContext,
  createPersistenceContext,
  OutboxRepository,
  type AuditEventRow,
  type PersistenceContext,
} from '@fraudguard/persistence';
import { signTestToken } from '@fraudguard/testkit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import pino from 'pino';

import { handleAuditableEvent } from '../../apps/event-worker/src/consumers/audit-consumer';
import { handleTransactionDecidedForCaseCreation } from '../../apps/event-worker/src/consumers/case-creation-consumer';
import { runOutboxRelayOnce } from '../../apps/event-worker/src/relay/outbox-relay';
import { AppModule as FraudApiModule } from '../../apps/fraud-api/src/app.module';
import { HttpExceptionFilter as FraudApiExceptionFilter } from '../../apps/fraud-api/src/common/http-exception.filter';
import { REDIS_CLIENT } from '../../apps/fraud-api/src/common/redis.provider';
import { AppModule as ReviewApiModule } from '../../apps/review-api/src/app.module';
import { HttpExceptionFilter as ReviewApiExceptionFilter } from '../../apps/review-api/src/common/http-exception.filter';

/**
 * E2E — the journeys test-strategy.md §3.5 names as ones that "must
 * never break," driven through the FULL real stack (fraud-api,
 * event-worker's relay and all three consumer groups, review-api — real
 * Postgres, Redis and Kafka throughout), not shortcuts. Deliberately few
 * (two test cases), and deliberately NOT duplicating what `tests/
 * integration/*.test.ts` already proves piecewise — each of this file's
 * assertions specifically closes a gap no existing integration test
 * chains together in one continuous flow:
 *
 * - `event-worker.integration.test.ts`'s IT-EVT-001 proves audit
 *   recording for a transaction with NO case. `review-api.integration
 *   .test.ts`'s case-queue test proves review actions but explicitly
 *   skips Kafka ("proven separately") and never touches the audit
 *   consumer at all. Neither proves the REVIEW path's full audit
 *   trail — four rows (received, decided, case created, case
 *   reviewed) for ONE transaction, which is FR-008's actual claim
 *   ("every decision retrievable with its full basis") for the one
 *   decision class that has the MOST basis to retrieve.
 * - No existing test proves a DEGRADED decision's audit record
 *   preserves the degraded flag and reason all the way through the
 *   cold path — every resilience test asserts the HTTP response only.
 */
describe('e2e: full lifecycle — score, relay, every consumer, review-api, audit, end to end', () => {
  let fraudApi: NestFastifyApplication;
  let reviewApi: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let producer: Producer;
  let scoreToken: string;
  let reviewToken: string;
  const logger = pino({ level: 'silent' });

  // Unique per test-process execution, not fixed — CAUGHT LIVE, running
  // this file twice in a row: `fraud.case.created`'s eventId is
  // deterministic from `transactionId` alone (not `caseId`, which is a
  // fresh random UUID every run), by design (RISK-005's dedup
  // guarantee). A fixed transactionId across separate runs means the
  // SECOND run's case.created audit row collides on
  // `audit_events.event_id`'s UNIQUE constraint with the FIRST run's —
  // a different case (different random caseId), but the identical
  // deterministic event id — and gets silently treated as a duplicate
  // delivery (`AuditRepository.append`'s own, correct, dedup behaviour,
  // just triggered by test reuse rather than a real redelivery). Unlike
  // `outbox_events`/`decisions`/`transactions`, there is no column to
  // clean `audit_events` by in `beforeAll` (the case-scoped rows are
  // keyed by `caseId`, generated only once the test BODY runs) — a
  // unique id per execution removes the collision structurally, the
  // same fix already applied to `tests/integration/observability
  // .integration.test.ts`'s IT-TRACE-001 for the identical reason.
  const runId = Date.now();
  const REVIEW_TRANSACTION_ID = `e2e_review_lifecycle_${runId}`;
  const DEGRADED_TRANSACTION_ID = `e2e_degraded_lifecycle_${runId}`;
  const TEST_TRANSACTION_IDS = [REVIEW_TRANSACTION_ID, DEGRADED_TRANSACTION_ID];

  beforeAll(async () => {
    const fraudApiModuleRef = await Test.createTestingModule({
      imports: [FraudApiModule],
    }).compile();
    fraudApi = fraudApiModuleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    fraudApi.useGlobalFilters(new FraudApiExceptionFilter(pino({ level: 'silent' })));
    await fraudApi.init();
    await fraudApi.getHttpAdapter().getInstance().ready();

    const reviewApiModuleRef = await Test.createTestingModule({
      imports: [ReviewApiModule],
    }).compile();
    reviewApi = reviewApiModuleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    reviewApi.useGlobalFilters(new ReviewApiExceptionFilter(pino({ level: 'silent' })));
    await reviewApi.init();
    await reviewApi.getHttpAdapter().getInstance().ready();

    redis = fraudApi.get<Redis>(REDIS_CLIENT);
    if (redis.status !== 'ready') {
      await new Promise((resolve) => redis.once('ready', resolve));
    }

    const config = loadConfig();
    scoreToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['score'],
    });
    reviewToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['review'],
    });

    persistence = createPersistenceContext(config);
    const kafka = createKafkaClient(config);
    producer = createProducer(kafka);
    await producer.connect();

    await redis.del(...TEST_TRANSACTION_IDS.map((id) => `idem:${id}`));
    await persistence.coldPool.query('DELETE FROM audit_events WHERE aggregate_id = ANY($1)', [
      TEST_TRANSACTION_IDS,
    ]);
    await persistence.coldPool.query('DELETE FROM fraud_cases WHERE transaction_id = ANY($1)', [
      TEST_TRANSACTION_IDS,
    ]);
    await persistence.coldPool.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1)', [
      TEST_TRANSACTION_IDS,
    ]);
    await persistence.coldPool.query('DELETE FROM decisions WHERE transaction_id = ANY($1)', [
      TEST_TRANSACTION_IDS,
    ]);
    await persistence.coldPool.query('DELETE FROM transactions WHERE transaction_id = ANY($1)', [
      TEST_TRANSACTION_IDS,
    ]);
  }, 60_000);

  afterAll(async () => {
    await producer.disconnect();
    await closePersistenceContext(persistence);
    await redis.quit();
    await fraudApi.close();
    await reviewApi.close();
  }, 60_000);

  function scoreInject(payload: unknown) {
    return fraudApi
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/fraud/score',
        headers: { authorization: `Bearer ${scoreToken}` },
        payload,
      });
  }

  function reviewApiInject(method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
    return reviewApi
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers: { authorization: `Bearer ${token}` },
        ...(payload !== undefined ? { payload } : {}),
      });
  }

  function buildRequest(overrides: Partial<ScoreRequest>): ScoreRequest {
    return {
      transactionId: 'e2e_default',
      userId: 'e2e_user_default',
      merchantId: 'e2e_merchant_default',
      deviceId: 'e2e_device_default',
      amount: { minorUnits: 1_000, currency: 'USD' },
      ipAddress: '203.0.113.41',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  /** Drains the outbox and feeds every unpublished row to the audit consumer — the real relay, a real Kafka round trip is unnecessary to prove THIS test's claim (the consumer's own parsing/persistence logic), and `event-worker.integration.test.ts`'s IT-EVT-005 already proves the relay's rows are byte-identical to what a real Kafka consumer reads back. */
  async function relayAndAudit(
    outboxRepository: OutboxRepository,
    auditRepository: AuditRepository,
    aggregateId: string,
  ): Promise<void> {
    await runOutboxRelayOnce({ outboxRepository, producer, logger, batchSize: 50 });
    const rows = await persistence.coldPool.query<{ topic: string; payload: unknown }>(
      'SELECT topic, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at',
      [aggregateId],
    );
    for (const row of rows.rows) {
      await handleAuditableEvent(auditRepository, row.topic, row.payload);
    }
  }

  // E2E-001. What: a REVIEW decision's full lifecycle — scored, a case
  // created, listed and approved by an analyst, and EVERY step of that
  // (including the review action itself) landing in the durable audit
  // trail. Why: FR-008's "full basis" promise, FR-010/FR-011's case
  // workflow, and NFR-012's consistency model, proved together rather
  // than piecewise. What failure it would catch: any of the four
  // consumer groups (feature-update doesn't apply here, but
  // case-creation and TWO separate audit-consumer passes do) silently
  // dropping a row, or review-api's review action not actually producing
  // an outbox event at all.
  it('REVIEW → case created → analyst approves → all four events land in the audit trail', async () => {
    const transactionId = REVIEW_TRANSACTION_ID;
    const merchantId = 'e2e_review_merchant';
    await setMerchantRiskScore(redis, merchantId, 0.85);

    const scoreResponse = await scoreInject(
      buildRequest({ transactionId, merchantId, userId: `${transactionId}_user` }),
    );
    expect(scoreResponse.statusCode).toBe(200);
    expect((scoreResponse.json() as { decision: string }).decision).toBe('REVIEW');

    const outboxRepository = new OutboxRepository(persistence.coldDb);
    const auditRepository = new AuditRepository(persistence.coldDb);
    const caseRepository = new CaseRepository(persistence.coldDb);

    // --- Relay + audit pass #1: transaction.received, transaction.decided. ---
    await relayAndAudit(outboxRepository, auditRepository, transactionId);

    // --- Case creation (event-worker's case-creation consumer, for real). ---
    const decidedRow = await persistence.coldPool.query<{ payload: unknown }>(
      "SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND topic = 'transaction.decided'",
      [transactionId],
    );
    await handleTransactionDecidedForCaseCreation(
      caseRepository,
      decidedRow.rows[0]?.payload,
      logger,
    );

    // --- The case is visible through review-api's real query endpoint. ---
    const listResponse = await reviewApiInject('GET', '/api/v1/fraud/cases', reviewToken);
    expect(listResponse.statusCode).toBe(200);
    const caseList = listResponse.json() as { items: FraudCaseDto[] };
    const createdCase = caseList.items.find((c) => c.transactionId === transactionId);
    expect(createdCase).toBeDefined();
    expect(fraudCaseSchema.safeParse(createdCase).success).toBe(true);

    // --- The analyst approves it through review-api's real action endpoint. ---
    const reviewResponse = await reviewApiInject(
      'POST',
      `/api/v1/fraud/cases/${createdCase?.caseId}/review`,
      reviewToken,
      { action: 'APPROVE', reason: 'Confirmed legitimate with the cardholder.' },
    );
    expect(reviewResponse.statusCode).toBe(200);
    expect((reviewResponse.json() as { status: string }).status).toBe('APPROVED');

    // --- Relay + audit pass #2: review.created, review.completed — the
    // case-creation consumer's OWN outbox event, and review-api's review
    // action's outbox event, both drained and audited for real. ---
    await relayAndAudit(outboxRepository, auditRepository, transactionId);
    const caseIdForAudit = createdCase?.caseId ?? '';
    await relayAndAudit(outboxRepository, auditRepository, caseIdForAudit);

    // --- The complete basis: all four actions, for one transaction's
    // full story, durably recorded. ---
    const auditRows = await auditRepository.findByAggregate('transaction', transactionId);
    const caseAuditRows = await auditRepository.findByAggregate('case', caseIdForAudit);
    const actions = [...auditRows, ...caseAuditRows].map((r: AuditEventRow) => r.action).sort();
    expect(actions).toEqual([
      'case.created',
      'case.reviewed',
      'transaction.decided',
      'transaction.received',
    ]);

    const reviewedAudit = caseAuditRows.find((r) => r.action === 'case.reviewed');
    // ASM-006: reviewer identity comes from the authenticated token's
    // `sub` claim (`test-client`, testkit's default), never the request
    // body — the audit row's actorId is that identity's one real proof.
    expect(reviewedAudit?.actorId).toBe('test-client');
    expect(reviewedAudit?.detail).toMatchObject({ resultingStatus: 'APPROVED' });
  }, 30_000);

  // E2E-002. What: the degraded path, end to end — not just the HTTP
  // response (every resilience test's scope), but the DURABLE AUDIT
  // RECORD a degraded decision produces, all the way through the cold
  // path. Why: ADR-005 requires the degraded flag to survive into
  // "historical analysis" (§"Visibility requirements" point 2) — that
  // claim is about the audit trail specifically, not the response body.
  it('a degraded decision’s audit record preserves degraded=true and its reason through the full cold path', async () => {
    const transactionId = DEGRADED_TRANSACTION_ID;
    redis.disconnect();
    let scoreResponse;
    try {
      scoreResponse = await scoreInject(
        buildRequest({ transactionId, userId: `${transactionId}_user` }),
      );
    } finally {
      redis.connect();
      if (redis.status !== 'ready') {
        await new Promise((resolve) => redis.once('ready', resolve));
      }
    }
    expect(scoreResponse.statusCode).toBe(200);
    const body = scoreResponse.json() as { degraded: boolean; degradedReason: string };
    expect(body.degraded).toBe(true);

    const outboxRepository = new OutboxRepository(persistence.coldDb);
    const auditRepository = new AuditRepository(persistence.coldDb);
    await relayAndAudit(outboxRepository, auditRepository, transactionId);

    const auditRows = await auditRepository.findByAggregate('transaction', transactionId);
    const decidedAudit = auditRows.find((r) => r.action === 'transaction.decided');
    expect(decidedAudit).toBeDefined();
    expect(decidedAudit?.detail).toMatchObject({
      degraded: true,
      degradedReason: body.degradedReason,
    });
  }, 30_000);
});
