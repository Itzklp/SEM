import { loadConfig } from '@fraudguard/config';
import { scoreResponseSchema, type ScoreRequest } from '@fraudguard/contracts';
import { closePersistenceContext, type PersistenceContext } from '@fraudguard/persistence';
import { signTestToken } from '@fraudguard/testkit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import pino from 'pino';

import { AppModule } from '../../apps/fraud-api/src/app.module';
import { HttpExceptionFilter } from '../../apps/fraud-api/src/common/http-exception.filter';
import { PERSISTENCE_CONTEXT } from '../../apps/fraud-api/src/common/persistence.provider';
import { REDIS_CLIENT } from '../../apps/fraud-api/src/common/redis.provider';

/**
 * RT-SLOW-001: "Dependency latency injected → Timeouts fire; no
 * cascade; no retry storm." A DIFFERENT failure mode from
 * `redis-outage.resilience.test.ts`'s: that one makes Redis entirely
 * UNREACHABLE (the container stops, commands fail immediately with a
 * connection error); this one keeps Redis UP and reachable, but SLOW —
 * the scenario `REDIS_TIMEOUT_MS=20` (.env) exists for specifically,
 * and the one ADR-005's "no hot-path retries" rule is actually
 * defending against (a retry into a struggling-but-not-dead dependency
 * is how a slowdown becomes an outage).
 *
 * Injects real latency with Redis's own `CLIENT PAUSE` command — every
 * command Redis receives is queued and answered only once the pause
 * expires, for every client, not just this test's own connection. A
 * genuine server-side slowdown, not a simulated delay.
 */
describe('resilience: slow (not down) Redis still times out fast, falls back, and does not retry', () => {
  let app: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let scoreToken: string;
  let adminRedis: Redis;

  beforeAll(async () => {
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

    // A SEPARATE connection for administering the pause — issuing
    // CLIENT PAUSE from the app's own client would pause the command
    // that sets the pause too.
    const config = loadConfig();
    adminRedis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password || undefined,
      db: config.redis.db,
    });

    scoreToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['score'],
    });
  }, 60_000);

  afterAll(async () => {
    await adminRedis.call('CLIENT', 'UNPAUSE').catch(() => undefined);
    adminRedis.disconnect();
    await redis.quit();
    await closePersistenceContext(persistence);
    await app.close();
  }, 60_000);

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
      userId: `slow_dep_user_${transactionId}`,
      merchantId: 'slow_dep_merchant',
      deviceId: 'slow_dep_device',
      amount: { minorUnits: 1_000, currency: 'USD' },
      ipAddress: '203.0.113.31',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
    };
  }

  it('a request during a Redis CLIENT PAUSE longer than REDIS_TIMEOUT_MS still returns 200, degraded, well inside a bounded time — no hang, no retry', async () => {
    const config = loadConfig();
    const transactionId = 'slow_dep_demo';
    await redis.del(`idem:${transactionId}`).catch(() => undefined);
    // FK dependency order — outbox_events/decisions before
    // transactions (same bug class `bulkhead-isolation.resilience
    // .test.ts` caught on its own second run).
    await persistence.hotPool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [
      transactionId,
    ]);
    await persistence.hotPool.query('DELETE FROM decisions WHERE transaction_id = $1', [
      transactionId,
    ]);
    await persistence.hotPool.query('DELETE FROM transactions WHERE transaction_id = $1', [
      transactionId,
    ]);

    // Pause every Redis client for 10x the app's own command timeout
    // — long enough that REDIS_TIMEOUT_MS=20ms definitely fires first,
    // short enough the test doesn't sit around once it has.
    const pauseMs = config.redis.timeoutMs * 10;
    await adminRedis.call('CLIENT', 'PAUSE', String(pauseMs));

    const start = Date.now();
    const response = await inject(buildRequest(transactionId));
    const elapsed = Date.now() - start;

    expect(response.statusCode).toBe(200);
    const parsed = scoreResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.degraded).toBe(true);
      expect(parsed.data.degradedReason).toBe('FEATURES_UNAVAILABLE');
    }

    // No retry storm, no cascade: the WHOLE request — three Redis
    // round trips (idempotency check, feature fetch, idempotency
    // store), each timing out at ~20ms, plus the real Postgres persist
    // — completes in a small multiple of the pause, not anywhere
    // close to waiting out the full pause three separate times (which
    // `maxRetriesPerRequest` being honoured, not retried, is what
    // prevents). A generous but real ceiling, not the tight ADR-003
    // hot-path budget itself (that is Phase 9's rigorously-measured
    // claim) — this just proves "fast failure", not "fast enough".
    expect(elapsed).toBeLessThan(pauseMs * 2);
  }, 30_000);
});
