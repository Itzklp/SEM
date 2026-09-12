import { loadConfig } from '@fraudguard/config';
import { type ScoreRequest } from '@fraudguard/contracts';
import {
  createConsumer,
  createKafkaClient,
  createProducer,
  type Admin,
  type Consumer,
} from '@fraudguard/messaging';
import { registry, runWithExtractedContext, startTracing } from '@fraudguard/observability';
import {
  closePersistenceContext,
  createPersistenceContext,
  OutboxRepository,
  type PersistenceContext,
} from '@fraudguard/persistence';
import { signTestToken } from '@fraudguard/testkit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { trace } from '@opentelemetry/api';
import type { Redis } from 'ioredis';
import pino from 'pino';

import { runOutboxRelayOnce } from '../../apps/event-worker/src/relay/outbox-relay';
import { AppModule } from '../../apps/fraud-api/src/app.module';
import { HttpExceptionFilter } from '../../apps/fraud-api/src/common/http-exception.filter';
import { PERSISTENCE_CONTEXT } from '../../apps/fraud-api/src/common/persistence.provider';
import { REDIS_CLIENT } from '../../apps/fraud-api/src/common/redis.provider';

/**
 * Phase 7's exit criteria (docs/ROADMAP.md): metrics carry real values
 * produced by real traffic (IT-OBS-001 below feeds `golden-signals.json`
 * / `hot-path.json` exactly the series they query), and a single
 * transaction is traceable end to end by traceId (IT-TRACE-001) — proved
 * MECHANICALLY here: the real `traceparent` captured on the outbox row,
 * round-tripped through a real Kafka header, and extracted back into the
 * same trace id on the consumer side. `.inject()` (light-my-request)
 * does not go through a real TCP socket, so OpenTelemetry's
 * `HttpInstrumentation` — what a real `main.ts` bootstrap registers —
 * may not produce a root span for it; this test starts that root span
 * itself, which is the one thing a real inbound HTTP request would have
 * supplied and `.inject()` does not, not a difference in anything this
 * system's own code does.
 */
describe('observability (integration): real metrics and real end-to-end trace propagation', () => {
  let app: NestFastifyApplication;
  let appPersistence: PersistenceContext;
  let appRedis: Redis;
  let scoreToken: string;
  let persistence: PersistenceContext;
  let outboxRepository: OutboxRepository;
  let tracing: ReturnType<typeof startTracing>;
  const logger = pino({ level: 'silent' });

  beforeAll(async () => {
    const config = loadConfig();
    // OpenTelemetry's global tracer provider is a process-wide singleton
    // (by design — it's what lets every bundled copy of `@opentelemetry/
    // api` across every package agree on one provider) — `--runInBand`
    // runs every integration test FILE in this one process, so once this
    // registers, every other file's `measure()`/`withSpan()` calls start
    // producing real (harmless, correctly-attributed-to-THEIR-own-span-
    // names, just exported under this test's serviceName) spans too, for
    // the rest of the run. Accepted rather than engineered around: there
    // is no real OTel API to unregister a global provider, and no other
    // test asserts anything about tracing being absent.
    tracing = startTracing({
      enabled: true,
      serviceName: 'observability-test',
      otlpEndpoint: config.observability.otel.otlpEndpoint,
      tracesSamplerArg: 1, // always sample — a flaky 10%-sampled assertion would be the wrong kind of flaky
    });

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

    scoreToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['score'],
    });

    persistence = createPersistenceContext(config);
    outboxRepository = new OutboxRepository(persistence.coldDb);

    // 'obs_metrics_001' is the only fixed id left needing cleanup —
    // IT-TRACE-001 generates its own unique id per run (see that test's
    // own comment on why a fixed id there was a real, caught bug).
    const testTransactionIds = ['obs_metrics_001'];
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
  });

  afterAll(async () => {
    await closePersistenceContext(persistence);
    await appRedis.quit();
    await closePersistenceContext(appPersistence);
    await app.close();
    await tracing.forceFlush();
    await tracing.shutdown();
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
      transactionId: 'obs_default',
      userId: 'obs_user_default',
      merchantId: 'obs_merchant_default',
      deviceId: 'obs_device_default',
      amount: { minorUnits: 1_000, currency: 'USD' },
      ipAddress: '203.0.113.1',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  // IT-OBS-001. What: real traffic through the real hot path moves the
  // real counters the dashboards (golden-signals.json, hot-path.json)
  // query. Why: "dashboards render real data under load" (exit
  // criterion) is false the moment these counters sit at zero after a
  // real request — checked directly against the shared registry, not a
  // mock of it.
  it('a real scored transaction increments transactions_total and fraud_decisions_total', async () => {
    const before = await registry.getMetricsAsJSON();
    const beforeTransactions = before.find((m) => m.name === 'transactions_total');
    const countBefore = beforeTransactions?.values.reduce((sum, v) => sum + v.value, 0) ?? 0;

    const txn = buildRequest({ transactionId: 'obs_metrics_001', userId: 'obs_metrics_user' });
    const response = await inject(txn);
    expect(response.statusCode).toBe(200);

    const after = await registry.getMetricsAsJSON();
    const afterTransactions = after.find((m) => m.name === 'transactions_total');
    const countAfter = afterTransactions?.values.reduce((sum, v) => sum + v.value, 0) ?? 0;
    expect(countAfter).toBeGreaterThan(countBefore);

    const decisions = after.find((m) => m.name === 'fraud_decisions_total');
    expect(decisions?.values.some((v) => v.value > 0)).toBe(true);

    const stageDurations = after.find((m) => m.name === 'fraud_score_duration_seconds');
    const stages = new Set(
      stageDurations?.values
        .filter((v) => v.metricName?.endsWith('_count'))
        .map((v) => v.labels.stage),
    );
    // Every stage this file's own doc comment (scoring.service.ts) names
    // — a missing stage here means that `measure()` call was never
    // reached, not just "not yet labelled".
    for (const stage of ['idempotency_check', 'feature_fetch', 'score', 'decide', 'persist']) {
      expect(stages.has(stage)).toBe(true);
    }
  });

  // IT-TRACE-001. What: the W3C traceparent captured at request time
  // survives (1) being persisted on the outbox row, (2) a REAL publish
  // to REAL Kafka as a message header, (3) being read back by a REAL
  // consumer and extracted into a context whose trace id matches the
  // ORIGINAL request's — the full chain ADR-006's async gap would
  // otherwise break, proved end to end rather than unit-tested per hop.
  it('the original request trace id survives outbox -> Kafka header -> consumer extraction', async () => {
    const tracer = trace.getTracer('observability-test');
    // A unique id PER RUN, not a fixed one — caught live: a fixed
    // 'obs_trace_001' re-run against a topic whose retention keeps
    // EVERY previous run's message (Postgres rows get cleaned in
    // beforeAll; Kafka's topic history does not) meant a fresh
    // `fromBeginning: true` consumer found a PREVIOUS run's
    // `transaction.decided` message first — same `aggregateId`, a
    // DIFFERENT trace id — and the assertion below compared against the
    // wrong run entirely. A unique id makes that collision structurally
    // impossible rather than merely unlikely.
    const transactionId = `obs_trace_${Date.now()}`;
    const txn = buildRequest({ transactionId, userId: 'obs_trace_user' });

    const originalTraceId = await tracer.startActiveSpan('test.original-request', async (span) => {
      const traceId = span.spanContext().traceId;
      const response = await inject(txn);
      expect(response.statusCode).toBe(200);
      span.end();
      return traceId;
    });

    const rows = await persistence.coldPool.query<{ trace_context: string | null }>(
      'SELECT trace_context FROM outbox_events WHERE aggregate_id = $1',
      [txn.transactionId],
    );
    expect(rows.rows.length).toBe(2);
    for (const row of rows.rows) {
      expect(row.trace_context).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
      // The captured traceparent's own trace id segment IS the id the
      // original span reported — not just "some" well-formed value.
      expect(row.trace_context?.split('-')[1]).toBe(originalTraceId);
    }

    // Real consume, real broker — subscribed BEFORE publishing, reading
    // only NEW messages (fromBeginning: false), not the DB column. CAUGHT
    // LIVE: this test originally published first and started a FRESH
    // `fromBeginning: true` consumer afterward — correct in isolation,
    // but `transaction.decided` accumulates messages across every other
    // integration/resilience test run in a long session, and scanning
    // the whole topic from the start eventually exceeded this test's own
    // 15s wait. Subscribing first and waiting for the group to actually
    // reach `Stable` (not just "subscribe() resolved" — the same gap
    // `tests/resilience/malformed-message.resilience.test.ts` found)
    // means the publish below is only ever read as a brand-new message,
    // regardless of how large the topic has grown.
    const config = loadConfig();
    const kafka = createKafkaClient(config);
    const admin: Admin = kafka.admin();
    await admin.connect();
    const consumerGroupId = `obs-trace-test-${Date.now()}`;
    const consumer: Consumer = createConsumer(kafka, consumerGroupId);
    await consumer.connect();
    await consumer.subscribe({ topic: 'transaction.decided', fromBeginning: false });

    const headerTraceparentPromise = new Promise<string | undefined>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(undefined);
        }
      }, 20_000);
      // `.run()` is what actually triggers the group-join handshake —
      // CAUGHT LIVE: an earlier version of this fix polled for `Stable`
      // BEFORE ever calling `.run()`, so the group could never reach
      // that state no matter how long it waited. Calling it here, before
      // polling below, is what makes the poll meaningful at all.
      void consumer.run({
        eachMessage: ({ message }) => {
          const value = JSON.parse(message.value?.toString() ?? '{}') as { aggregateId?: string };
          if (value.aggregateId === txn.transactionId && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve(message.headers?.['traceparent']?.toString());
          }
          return Promise.resolve();
        },
      });
    });

    const deadline = Date.now() + 20_000;
    let stable = false;
    while (Date.now() < deadline) {
      const { groups } = await admin.describeGroups([consumerGroupId]);
      if (groups.every((g) => g.state === 'Stable')) {
        stable = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await admin.disconnect();
    expect(stable).toBe(true);

    // Real publish, real broker — only now, once the consumer is
    // genuinely ready to receive it.
    const producer = createProducer(kafka);
    await producer.connect();
    const relayResult = await runOutboxRelayOnce({
      outboxRepository,
      producer,
      logger,
      batchSize: 50,
    });
    expect(relayResult.failedCount).toBe(0);
    await producer.disconnect();

    const headerTraceparent = await headerTraceparentPromise;
    await consumer.disconnect();

    expect(headerTraceparent).toBeDefined();
    expect(headerTraceparent?.split('-')[1]).toBe(originalTraceId);

    // Extraction side: a span started inside the extracted context
    // belongs to the SAME trace — this is exactly what
    // apps/event-worker/src/main.ts does around every consumer handler.
    runWithExtractedContext(headerTraceparent, () => {
      tracer.startActiveSpan('test.consumer-side', (span) => {
        expect(span.spanContext().traceId).toBe(originalTraceId);
        span.end();
      });
    });
  }, 60_000);
});
