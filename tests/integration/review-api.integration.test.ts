import { loadConfig } from '@fraudguard/config';
import {
  fraudCaseSchema,
  transactionDetailSchema,
  type FraudCaseDto,
  type ScoreRequest,
} from '@fraudguard/contracts';
import { setMerchantRiskScore } from '@fraudguard/feature-store';
import { createKafkaClient, createProducer, type Producer } from '@fraudguard/messaging';
import {
  CaseRepository,
  closePersistenceContext,
  createPersistenceContext,
  OutboxRepository,
  type PersistenceContext,
} from '@fraudguard/persistence';
import { signTestToken } from '@fraudguard/testkit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import pino from 'pino';

import { handleTransactionDecidedForCaseCreation } from '../../apps/event-worker/src/consumers/case-creation-consumer';
import { runOutboxRelayOnce } from '../../apps/event-worker/src/relay/outbox-relay';
import { AppModule as FraudApiModule } from '../../apps/fraud-api/src/app.module';
import { HttpExceptionFilter as FraudApiExceptionFilter } from '../../apps/fraud-api/src/common/http-exception.filter';
import { REDIS_CLIENT } from '../../apps/fraud-api/src/common/redis.provider';
import { AppModule as ReviewApiModule } from '../../apps/review-api/src/app.module';
import { HttpExceptionFilter as ReviewApiExceptionFilter } from '../../apps/review-api/src/common/http-exception.filter';

/**
 * The full Phase 6 chain, end to end: fraud-api scores a REVIEW
 * transaction -> event-worker's case-creation consumer creates a case ->
 * review-api's endpoints serve and act on it -> the outcome is itself an
 * outbox event a future audit consumer would pick up. Two real apps,
 * both booted, against the same real Postgres/Redis/Kafka.
 */
describe('review-api (integration): case queue, review actions, transaction queries', () => {
  let fraudApi: NestFastifyApplication;
  let reviewApi: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let producer: Producer;
  let scoreToken: string;
  let reviewToken: string;
  const logger = pino({ level: 'silent' });

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

    const testTransactionIds = ['review_api_txn_001', 'review_api_txn_002'];
    await persistence.coldPool.query('DELETE FROM fraud_cases WHERE transaction_id = ANY($1)', [
      testTransactionIds,
    ]);
    await persistence.coldPool.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1)', [
      testTransactionIds,
    ]);
    await persistence.coldPool.query('DELETE FROM decisions WHERE transaction_id = ANY($1)', [
      testTransactionIds,
    ]);
    await persistence.coldPool.query('DELETE FROM transactions WHERE transaction_id = ANY($1)', [
      testTransactionIds,
    ]);
    await redis.del(...testTransactionIds.map((id) => `idem:${id}`));
  }, 60_000);

  afterAll(async () => {
    await producer.disconnect();
    await closePersistenceContext(persistence);
    await redis.quit();
    await fraudApi.close();
    await reviewApi.close();
  });

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
      transactionId: 'review_api_default',
      userId: 'review_api_user_default',
      merchantId: 'review_api_merchant_default',
      deviceId: 'review_api_device_default',
      amount: { minorUnits: 1_000, currency: 'USD' },
      ipAddress: '203.0.113.1',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  /** Drives a REVIEW transaction all the way through case-creation, exactly as the real pipeline would (minus Kafka in between — proven separately by event-worker.integration.test.ts). */
  async function createReviewCase(
    transactionId: string,
    merchantId: string,
  ): Promise<FraudCaseDto> {
    await setMerchantRiskScore(redis, merchantId, 0.85);
    const request = buildRequest({ transactionId, merchantId, userId: `${transactionId}_user` });
    const response = await scoreInject(request);
    if (
      response.statusCode !== 200 ||
      (response.json() as { decision: string }).decision !== 'REVIEW'
    ) {
      throw new Error(
        `setup failed: expected REVIEW, got ${response.statusCode} ${JSON.stringify(response.json())}`,
      );
    }

    const outboxRepository = new OutboxRepository(persistence.coldDb);
    await runOutboxRelayOnce({ outboxRepository, producer, logger, batchSize: 50 });

    const rows = await persistence.coldPool.query<{ payload: unknown }>(
      "SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND topic = 'transaction.decided'",
      [transactionId],
    );
    const caseRepository = new CaseRepository(persistence.coldDb);
    await handleTransactionDecidedForCaseCreation(caseRepository, rows.rows[0]?.payload, logger);

    const getResponse = await reviewApiInject('GET', `/api/v1/fraud/cases`, reviewToken);
    const body = getResponse.json() as { items: FraudCaseDto[] };
    const created = body.items.find((c) => c.transactionId === transactionId);
    if (!created) {
      throw new Error(`setup failed: no case found for ${transactionId}`);
    }
    return created;
  }

  // IT-REV-001. What: a score-only token cannot reach review-api's endpoints.
  it('rejects a score-only token — review is a distinct privilege (FR-015)', async () => {
    const response = await reviewApiInject('GET', '/api/v1/fraud/cases', scoreToken);
    expect(response.statusCode).toBe(403);
  });

  // IT-REV-002. What: the full chain — REVIEW decision -> case created ->
  //             visible in the OPEN queue -> reviewable -> APPROVE
  //             changes status and is idempotent against re-review.
  it('lists an OPEN case, approves it, and rejects a second review of the same case', async () => {
    const fraudCase = await createReviewCase('review_api_txn_001', 'review_api_merchant_001');
    expect(fraudCase.status).toBe('OPEN');

    const detailResponse = await reviewApiInject(
      'GET',
      `/api/v1/fraud/cases/${fraudCase.caseId}`,
      reviewToken,
    );
    expect(detailResponse.statusCode).toBe(200);
    const detail = fraudCaseSchema.safeParse(detailResponse.json());
    expect(detail.success).toBe(true);

    const reviewResponse = await reviewApiInject(
      'POST',
      `/api/v1/fraud/cases/${fraudCase.caseId}/review`,
      reviewToken,
      { action: 'APPROVE', reason: 'Verified with the cardholder by phone.' },
    );
    expect(reviewResponse.statusCode).toBe(200);
    const reviewed = reviewResponse.json() as FraudCaseDto;
    expect(reviewed.status).toBe('APPROVED');
    expect(reviewed.reviewerId).toBeTruthy(); // from the token, never the body (ASM-006)

    // FR-011: illegal transitions rejected — this case is already closed.
    const secondReview = await reviewApiInject(
      'POST',
      `/api/v1/fraud/cases/${fraudCase.caseId}/review`,
      reviewToken,
      { action: 'BLOCK', reason: 'too late' },
    );
    expect(secondReview.statusCode).toBe(400);
    expect((secondReview.json() as { error: { code: string } }).error.code).toBe(
      'ILLEGAL_TRANSITION',
    );

    // The review outcome is itself durably queued for propagation (ADR-006) —
    // same pattern as fraud-api's own decision write.
    const outboxRow = await persistence.coldPool.query(
      "SELECT topic FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'fraud.case.reviewed'",
      ['review_api_txn_001'],
    );
    expect(outboxRow.rows.length).toBe(1);
    expect(outboxRow.rows[0]?.topic).toBe('review.completed');
  });

  // IT-REV-003. What: GET /transactions/:id returns the full recoverable basis (FR-008, FR-014).
  it("retrieves a transaction's full detail, including its decision", async () => {
    const request = buildRequest({
      transactionId: 'review_api_txn_002',
      userId: 'review_api_txn_002_user',
    });
    await scoreInject(request);

    const response = await reviewApiInject(
      'GET',
      `/api/v1/transactions/${request.transactionId}`,
      reviewToken,
    );
    expect(response.statusCode).toBe(200);
    const parsed = transactionDetailSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.transactionId).toBe(request.transactionId);
      expect(parsed.data.decision).not.toBeNull();
    }
  });

  it('returns 404 for a transaction that does not exist', async () => {
    const response = await reviewApiInject(
      'GET',
      '/api/v1/transactions/does_not_exist_txn',
      reviewToken,
    );
    expect(response.statusCode).toBe(404);
  });
});
