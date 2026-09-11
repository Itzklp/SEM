import { loadConfig } from '@fraudguard/config';
import { type ScoreRequest } from '@fraudguard/contracts';
import { getFeatureVector, setMerchantRiskScore } from '@fraudguard/feature-store';
import {
  createConsumer,
  createKafkaClient,
  createProducer,
  type Consumer,
  type Producer,
} from '@fraudguard/messaging';
import {
  AuditRepository,
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

import { handleAuditableEvent } from '../../apps/event-worker/src/consumers/audit-consumer';
import { handleTransactionDecidedForCaseCreation } from '../../apps/event-worker/src/consumers/case-creation-consumer';
import { handleTransactionDecided } from '../../apps/event-worker/src/consumers/feature-update-consumer';
import { runOutboxRelayOnce } from '../../apps/event-worker/src/relay/outbox-relay';
import { AppModule } from '../../apps/fraud-api/src/app.module';
import { HttpExceptionFilter } from '../../apps/fraud-api/src/common/http-exception.filter';
import { PERSISTENCE_CONTEXT } from '../../apps/fraud-api/src/common/persistence.provider';
import { REDIS_CLIENT } from '../../apps/fraud-api/src/common/redis.provider';

/**
 * Phase 6's exit criteria, proved against real Postgres, Redis AND Kafka
 * — the full producer (fraud-api) -> outbox -> relay -> Kafka -> consumer
 * chain, not a mock of any link in it.
 */
describe('event-worker (integration): outbox relay + consumers, against real infra', () => {
  let app: NestFastifyApplication;
  let appPersistence: PersistenceContext;
  let appRedis: Redis;
  let scoreToken: string;

  let persistence: PersistenceContext;
  let outboxRepository: OutboxRepository;
  let caseRepository: CaseRepository;
  let auditRepository: AuditRepository;
  let producer: Producer;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new HttpExceptionFilter(pino({ level: 'silent' })));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    appPersistence = app.get<PersistenceContext>(PERSISTENCE_CONTEXT);
    appRedis = app.get<Redis>(REDIS_CLIENT);
    if (appRedis.status !== 'ready') {
      await new Promise((resolve) => appRedis.once('ready', resolve));
    }

    const config = loadConfig();
    scoreToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['score'],
    });

    persistence = createPersistenceContext(config);
    outboxRepository = new OutboxRepository(persistence.coldDb);
    caseRepository = new CaseRepository(persistence.coldDb);
    auditRepository = new AuditRepository(persistence.coldDb);

    // This file uses fixed, readable transactionIds — a second local run
    // without a fresh database would hit FR-017's idempotency fast path
    // (fraud-api never re-scores, never re-inserts outbox rows) and every
    // assertion below would silently check PREVIOUS-run state instead of
    // this run's. Same fix as demo-scenarios.integration.test.ts, for the
    // same reason.
    const testTransactionIds = [
      'evt_audit_001',
      'evt_dup_001',
      'evt_review_001',
      'evt_allow_001',
      'evt_kafka_roundtrip_001',
    ];
    await persistence.coldPool.query('DELETE FROM fraud_cases WHERE transaction_id = ANY($1)', [
      testTransactionIds,
    ]);
    await persistence.coldPool.query('DELETE FROM audit_events WHERE aggregate_id = ANY($1)', [
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
    await appRedis.del(...testTransactionIds.map((id) => `idem:${id}`));

    const kafka = createKafkaClient(config);
    producer = createProducer(kafka);
    await producer.connect();
  });

  afterAll(async () => {
    await producer.disconnect();
    await closePersistenceContext(persistence);
    await appRedis.quit();
    await closePersistenceContext(appPersistence);
    await app.close();
  });

  function inject(payload: unknown) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/fraud/score',
        headers: { authorization: `Bearer ${scoreToken}` },
        payload,
      });
  }

  function buildRequest(overrides: Partial<ScoreRequest>): ScoreRequest {
    return {
      transactionId: 'evt_default',
      userId: 'evt_user_default',
      merchantId: 'evt_merchant_default',
      deviceId: 'evt_device_default',
      amount: { minorUnits: 1_000, currency: 'USD' },
      ipAddress: '203.0.113.1',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  async function outboxRowsFor(
    transactionId: string,
  ): Promise<{ topic: string; payload: unknown }[]> {
    const result = await persistence.coldPool.query<{ topic: string; payload: unknown }>(
      'SELECT topic, payload FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at',
      [transactionId],
    );
    return result.rows;
  }

  // IT-EVT-001. What: every decision is recoverable with its full basis.
  // Why: FR-008, this phase's first exit criterion — the whole
  // fraud-api -> outbox -> relay -> Kafka -> audit-consumer chain,
  // exercised for real.
  it('a decision is fully recoverable: outbox relay publishes to Kafka, audit consumer records both events', async () => {
    const txn = buildRequest({ transactionId: 'evt_audit_001', userId: 'evt_audit_user' });
    const response = await inject(txn);
    expect(response.statusCode).toBe(200);

    const relayResult = await runOutboxRelayOnce({
      outboxRepository,
      producer,
      logger,
      batchSize: 50,
    });
    expect(relayResult.failedCount).toBe(0);

    const published = await persistence.coldPool.query<{ published_at: string | null }>(
      'SELECT published_at FROM outbox_events WHERE aggregate_id = $1',
      [txn.transactionId],
    );
    expect(published.rows.length).toBe(2); // transaction.received + transaction.decided
    expect(published.rows.every((r) => r.published_at !== null)).toBe(true);

    const rows = await outboxRowsFor(txn.transactionId);
    for (const row of rows) {
      await handleAuditableEvent(auditRepository, row.topic, row.payload);
    }

    const auditRows = await auditRepository.findByAggregate('transaction', txn.transactionId);
    expect(auditRows.length).toBe(2);
    expect(auditRows.map((r) => r.action).sort()).toEqual([
      'transaction.decided',
      'transaction.received',
    ]);
  });

  // IT-EVT-002. What: consuming the SAME published event twice does not
  //             create a duplicate audit row or double-count a feature.
  // Why: RISK-005, ADR-006's "all consumers must be idempotent" —
  //      verified, not assumed, for both the audit and feature-update
  //      consumers.
  it('duplicate delivery: no duplicate audit rows, no double-counted feature', async () => {
    const txn = buildRequest({ transactionId: 'evt_dup_001', userId: 'evt_dup_user' });
    await inject(txn);
    await runOutboxRelayOnce({ outboxRepository, producer, logger, batchSize: 50 });
    const [decidedRow] = (await outboxRowsFor(txn.transactionId)).filter(
      (r) => r.topic === 'transaction.decided',
    );
    expect(decidedRow).toBeDefined();

    // Audit: twice.
    await handleAuditableEvent(auditRepository, 'transaction.decided', decidedRow!.payload);
    await handleAuditableEvent(auditRepository, 'transaction.decided', decidedRow!.payload);
    const auditRows = await auditRepository.findByAggregate('transaction', txn.transactionId);
    expect(auditRows.filter((r) => r.action === 'transaction.decided').length).toBe(1);

    // Feature-update: twice — recordTransactionFeatures is idempotent by
    // construction (Phase 4); this proves it holds through the consumer
    // wrapper too, not just the underlying function directly. Checked
    // against the actual Redis feature state, not a proxy for it.
    await handleTransactionDecided(appRedis, decidedRow!.payload);
    await handleTransactionDecided(appRedis, decidedRow!.payload);
    const vector = await getFeatureVector(appRedis, {
      userId: txn.userId,
      deviceId: txn.deviceId,
      merchantId: txn.merchantId,
      ipAddress: txn.ipAddress,
    });
    expect(vector.features.transaction_count_5m).toBe(1);
  });

  // IT-EVT-003. What: a REVIEW decision creates exactly one case, even
  //             under duplicate delivery.
  // Why: FR-010, RISK-005.
  it('case-creation: exactly one case per REVIEW transaction, duplicate delivery included', async () => {
    const merchantId = 'evt_review_merchant';
    await setMerchantRiskScore(appRedis, merchantId, 0.85);
    const txn = buildRequest({
      transactionId: 'evt_review_001',
      userId: 'evt_review_user',
      merchantId,
      amount: { minorUnits: 1_000, currency: 'USD' },
    });
    const response = await inject(txn);
    const body = response.json() as { decision: string };
    expect(body.decision).toBe('REVIEW');

    await runOutboxRelayOnce({ outboxRepository, producer, logger, batchSize: 50 });
    const [decidedRow] = (await outboxRowsFor(txn.transactionId)).filter(
      (r) => r.topic === 'transaction.decided',
    );

    await handleTransactionDecidedForCaseCreation(caseRepository, decidedRow!.payload, logger);
    await handleTransactionDecidedForCaseCreation(caseRepository, decidedRow!.payload, logger); // duplicate delivery

    const fraudCase = await caseRepository.findByTransactionId(txn.transactionId);
    expect(fraudCase).not.toBeNull();
    expect(fraudCase?.status).toBe('OPEN');

    const caseCount = await persistence.coldPool.query<{ count: string }>(
      'SELECT count(*)::text as count FROM fraud_cases WHERE transaction_id = $1',
      [txn.transactionId],
    );
    expect(caseCount.rows[0]?.count).toBe('1');
  });

  // IT-EVT-004. What: an ALLOW decision creates no case at all.
  it('case-creation: an ALLOW decision creates no case', async () => {
    const txn = buildRequest({ transactionId: 'evt_allow_001', userId: 'evt_allow_user' });
    await inject(txn);
    await runOutboxRelayOnce({ outboxRepository, producer, logger, batchSize: 50 });
    const [decidedRow] = (await outboxRowsFor(txn.transactionId)).filter(
      (r) => r.topic === 'transaction.decided',
    );

    await handleTransactionDecidedForCaseCreation(caseRepository, decidedRow!.payload, logger);

    const fraudCase = await caseRepository.findByTransactionId(txn.transactionId);
    expect(fraudCase).toBeNull();
  });

  // IT-EVT-005. What: the relay genuinely round-trips through a real
  //             Kafka broker — a consumer actually reads what the relay
  //             produced, not just what the outbox row said it would.
  // Why: every other test in this file re-reads the outbox row's payload
  //      column rather than consuming from Kafka, which would pass even
  //      if the relay's `sendEvent` call were silently broken. This one
  //      doesn't have that gap.
  it('published events are actually readable back from Kafka by a real consumer', async () => {
    const txn = buildRequest({
      transactionId: 'evt_kafka_roundtrip_001',
      userId: 'evt_kafka_user',
    });
    await inject(txn);
    await runOutboxRelayOnce({ outboxRepository, producer, logger, batchSize: 50 });

    const config = loadConfig();
    const kafka = createKafkaClient(config);
    const consumer: Consumer = createConsumer(kafka, `evt-worker-test-roundtrip-${Date.now()}`);
    await consumer.connect();
    await consumer.subscribe({ topic: 'transaction.decided', fromBeginning: true });

    const found = await new Promise<boolean>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      }, 15_000);
      void consumer.run({
        eachMessage: ({ message }) => {
          const value = JSON.parse(message.value?.toString() ?? '{}') as { aggregateId?: string };
          if (value.aggregateId === txn.transactionId && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(true);
          }
          return Promise.resolve();
        },
      });
    });

    await consumer.disconnect();
    expect(found).toBe(true);
  }, 20_000);
});
