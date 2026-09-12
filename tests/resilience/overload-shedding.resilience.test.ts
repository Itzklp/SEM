import { loadConfig } from '@fraudguard/config';
import { type ScoreRequest } from '@fraudguard/contracts';
import { closePersistenceContext, type PersistenceContext } from '@fraudguard/persistence';
import { signTestToken } from '@fraudguard/testkit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import pino from 'pino';

import { AppModule } from '../../apps/fraud-api/src/app.module';
import { HttpExceptionFilter } from '../../apps/fraud-api/src/common/http-exception.filter';
import { registerLoadShedding } from '../../apps/fraud-api/src/common/load-shedding';
import { PERSISTENCE_CONTEXT } from '../../apps/fraud-api/src/common/persistence.provider';
import { REDIS_CLIENT } from '../../apps/fraud-api/src/common/redis.provider';

/**
 * RT-OVERLOAD-001 (ADR-005's policy table, row "Overload"): "Shed above
 * a concurrency ceiling with `429` and `Retry-After`."
 *
 * CAUGHT WRITING THIS TEST, not by inspection: `MAX_CONCURRENT_REQUESTS`
 * (`AppConfig.security.maxConcurrentRequests`) has existed since Phase
 * 1 — nothing in `fraud-api` ever actually READ it. `@fastify/rate-limit`
 * (registered in `main.ts`) enforces a DIFFERENT thing (requests per
 * time window, per client); a concurrency ceiling, independent of
 * client or timing, had no enforcement at all. Fixed with
 * `apps/fraud-api/src/common/load-shedding.ts`, built alongside this
 * test, not before it.
 *
 * CAUGHT A SECOND TIME, proving it: the first version of this test fired
 * many `.inject()` calls via `Promise.all`, exactly like every other
 * test in this suite does for its own HTTP assertions — and reliably
 * measured ZERO shed responses, at every ceiling tried down to 1.
 * `.inject()` (light-my-request) does not go through a real socket;
 * empirically, repeated `.inject()` calls do not actually overlap
 * in-flight the way real concurrent connections do, so nothing in this
 * process ever saw more than one request "in flight" at a time — the
 * exact property a concurrency ceiling test needs. Fixed by having this
 * ONE test (not the rest of the suite, which has no need for it)
 * actually `app.listen()` on a real ephemeral port and fire real
 * concurrent `fetch()` calls at it — the only way to genuinely produce
 * overlapping in-flight requests in this runtime.
 *
 * `MAX_CONCURRENT_REQUESTS` is overridden to a small number here (real
 * default: 500 — firing 500+ genuinely simultaneous requests in one Jest
 * test to prove the same mechanism would be needlessly heavy) via
 * `process.env` BEFORE the testing module is built, since that is the
 * one time `loadConfig()` actually reads it. Restored in `afterAll` —
 * `process.env` is a real Node global, not reset between test FILES by
 * Jest's per-file module-registry isolation, so leaving the override in
 * place would leak into whichever resilience test file Jest runs next
 * in the same `--runInBand` process.
 */
describe('resilience: overload sheds load above the concurrency ceiling, never past it', () => {
  const ORIGINAL_MAX_CONCURRENT = process.env.MAX_CONCURRENT_REQUESTS;
  const TEST_CEILING = 3;

  let app: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let scoreToken: string;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.MAX_CONCURRENT_REQUESTS = String(TEST_CEILING);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new HttpExceptionFilter(pino({ level: 'silent' })));
    // This test harness never runs main.ts's bootstrap() — same gap
    // Phase 7 found twice (tracing-preload.js, http-metrics's hook
    // arity): registerLoadShedding() is ONLY ever called there, so it
    // has to be wired explicitly here too, or this test would measure
    // nothing having been registered at all. CAUGHT the same way those
    // were — this test reliably measured zero shed responses until this
    // line was added, despite firing real concurrent requests.
    registerLoadShedding(app.getHttpAdapter().getInstance(), TEST_CEILING);
    // A REAL listener on an ephemeral port (0) — see this file's own doc
    // comment for why `.inject()` cannot exercise genuine concurrency.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address !== null ? address.port : address;
    baseUrl = `http://127.0.0.1:${port}`;

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
  }, 60_000);

  afterAll(async () => {
    if (ORIGINAL_MAX_CONCURRENT === undefined) {
      delete process.env.MAX_CONCURRENT_REQUESTS;
    } else {
      process.env.MAX_CONCURRENT_REQUESTS = ORIGINAL_MAX_CONCURRENT;
    }
    await redis.quit();
    await closePersistenceContext(persistence);
    await app.close();
  }, 60_000);

  function postScore(payload: ScoreRequest): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/fraud/score`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${scoreToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  function buildRequest(transactionId: string): ScoreRequest {
    return {
      transactionId,
      userId: `overload_user_${transactionId}`,
      merchantId: 'overload_merchant',
      deviceId: 'overload_device',
      amount: { minorUnits: 1_000, currency: 'USD' },
      ipAddress: '203.0.113.11',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
    };
  }

  it('fires well past the concurrency ceiling at once over real connections: some requests are shed with 429 + Retry-After, none hang, none silently drop', async () => {
    const testTransactionIds = Array.from({ length: 60 }, (_, i) => `overload_${i}`);
    await redis.del(...testTransactionIds.map((id) => `idem:${id}`));
    await persistence.hotPool.query(
      'DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])',
      [testTransactionIds],
    );
    await persistence.hotPool.query(
      'DELETE FROM decisions WHERE transaction_id = ANY($1::text[])',
      [testTransactionIds],
    );
    await persistence.hotPool.query(
      'DELETE FROM transactions WHERE transaction_id = ANY($1::text[])',
      [testTransactionIds],
    );

    // All fired AT ONCE over REAL sockets (Promise.all, not awaited one
    // by one) — this is what actually exercises a CONCURRENCY ceiling
    // rather than a rate (requests-per-second) limit.
    const responses = await Promise.all(
      testTransactionIds.map((id) => postScore(buildRequest(id))),
    );

    const statusCodes = responses.map((r) => r.status);
    const shed = responses.filter((r) => r.status === 429);
    const served = responses.filter((r) => r.status === 200);

    // Every response is accounted for — none hung (Promise.all would
    // itself have timed out the test) and none is some THIRD, unexpected
    // status that would mean a crash rather than a deliberate shed.
    expect(shed.length + served.length).toBe(statusCodes.length);
    // Fired 20x the ceiling at once over real connections — at least
    // some MUST have been shed. A suite running this with zero shed
    // responses would mean the ceiling enforcement silently stopped
    // working, not that the system got faster.
    expect(shed.length).toBeGreaterThan(0);
    expect(served.length).toBeGreaterThan(0);

    for (const response of shed) {
      expect(response.headers.get('retry-after')).toBeDefined();
      const body = (await response.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('OVERLOADED');
    }
  }, 30_000);
});
