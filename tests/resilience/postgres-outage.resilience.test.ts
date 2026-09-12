import { loadConfig } from '@fraudguard/config';
import { scoreResponseSchema, type ScoreRequest } from '@fraudguard/contracts';
import { closePersistenceContext, type PersistenceContext } from '@fraudguard/persistence';
import { signTestToken } from '@fraudguard/testkit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import pino from 'pino';

import { AppModule } from '../../apps/fraud-api/src/app.module';
import { HttpExceptionFilter } from '../../apps/fraud-api/src/common/http-exception.filter';
import { PERSISTENCE_CONTEXT } from '../../apps/fraud-api/src/common/persistence.provider';
import { REDIS_CLIENT } from '../../apps/fraud-api/src/common/redis.provider';

import { dockerCompose, ensureServiceHealthy, isServiceHealthy, waitUntil } from './docker-helpers';

/**
 * RT-PG-001 (ADR-005's policy table, row "PostgreSQL"): "Return 503 with
 * Retry-After. Do not return a decision." The one FAIL-CLOSED row in the
 * whole table — every other dependency degrades and keeps serving;
 * PostgreSQL loss must stop the response, because an unrecorded decision
 * is unauditable (ADR-005 §"Why PostgreSQL is the sole fail-closed case").
 *
 * Genuinely stops the real `postgres` container, the same reasoning
 * `kafka-outage.resilience.test.ts` already applies to Kafka: the only
 * way to actually prove "fails closed" is to make the dependency
 * unreachable, not to mock the failure.
 *
 * CAUGHT LIVE, writing this test: `packages/persistence`'s connection
 * pools had no `'error'` listener — node-postgres's own documented
 * gotcha, where an IDLE pooled client erroring (exactly what happens the
 * instant the server goes away) emits an `'error'` event on the `Pool`
 * itself, and an `EventEmitter`'s unlistened `'error'` event is fatal in
 * Node. Without a handler, stopping Postgres with an idle connection
 * sitting in the pool would have crashed `fraud-api` outright — the
 * opposite of "fail closed with a 503", which requires the PROCESS to
 * stay up long enough to return that 503 at all. Fixed in
 * `packages/persistence/src/connection.ts` before this test could even
 * run meaningfully.
 */
describe('resilience: PostgreSQL outage fails closed, never crashes, never silently succeeds', () => {
  let app: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let scoreToken: string;

  const isPostgresHealthy = (): boolean => isServiceHealthy('postgres');

  beforeAll(async () => {
    await ensureServiceHealthy('postgres');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new HttpExceptionFilter(pino({ level: 'silent' })));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    persistence = app.get<PersistenceContext>(PERSISTENCE_CONTEXT);
    redis = app.get<Redis>(REDIS_CLIENT);
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

    await redis.del('idem:pg_outage_demo', 'idem:pg_outage_recovery');
    await persistence.hotPool.query(
      'DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])',
      [['pg_outage_demo', 'pg_outage_recovery']],
    );
    await persistence.hotPool.query(
      'DELETE FROM decisions WHERE transaction_id = ANY($1::text[])',
      [['pg_outage_demo', 'pg_outage_recovery']],
    );
    await persistence.hotPool.query(
      'DELETE FROM transactions WHERE transaction_id = ANY($1::text[])',
      [['pg_outage_demo', 'pg_outage_recovery']],
    );
  }, 120_000);

  afterAll(async () => {
    await ensureServiceHealthy('postgres');
    await redis.quit();
    await closePersistenceContext(persistence);
    await app.close();
  }, 120_000);

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

  function buildRequest(transactionId: string): ScoreRequest {
    return {
      transactionId,
      userId: 'pg_outage_user',
      merchantId: 'pg_outage_merchant',
      deviceId: 'pg_outage_device',
      amount: { minorUnits: 1_500, currency: 'USD' },
      ipAddress: '203.0.113.1',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
    };
  }

  it('returns 503 with Retry-After while Postgres is down, never a 500, never a silent decision — and works normally once it recovers', async () => {
    dockerCompose('stop postgres');

    try {
      const request = buildRequest('pg_outage_demo');
      const response = await inject(request);

      // Fails CLOSED: not 200 (no decision returned), and specifically
      // not a generic 500 either — a real bug in this code path must
      // still surface as 500, so asserting the EXACT status is what
      // actually distinguishes "planned degradation" from "a crash
      // that happens to return something".
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBeDefined();
      const body = response.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe('DECISION_NOT_RECORDED');
    } finally {
      dockerCompose('start postgres');
    }

    const recovered = await waitUntil(isPostgresHealthy, 90_000);
    expect(recovered).toBe(true);

    // The process did not crash (ADR-005 fail-closed only works if the
    // SERVICE survives to return the 503 — and survives to serve the
    // very next request normally too, which is the thing the missing
    // Pool error handler would have broken).
    const healthResponse = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/api/v1/health' });
    expect(healthResponse.statusCode).toBe(200);

    const recoveryRequest = buildRequest('pg_outage_recovery');
    const recoveryResponse = await inject(recoveryRequest);
    expect(recoveryResponse.statusCode).toBe(200);
    const parsed = scoreResponseSchema.safeParse(recoveryResponse.json());
    expect(parsed.success).toBe(true);

    // And the outage itself left nothing behind — the failed attempt
    // never partially wrote anything (the transaction in
    // TransactionRepository.insertScored is all-or-nothing regardless
    // of where in the chain the connection actually failed).
    const outageRows = await persistence.hotPool.query(
      'SELECT 1 FROM transactions WHERE transaction_id = $1',
      ['pg_outage_demo'],
    );
    expect(outageRows.rows.length).toBe(0);
  }, 150_000);
});
