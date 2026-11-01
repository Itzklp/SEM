import type { ChildProcess } from 'node:child_process';

import { loadConfig } from '@fraudguard/config';
import { scoreResponseSchema, type ScoreRequest } from '@fraudguard/contracts';
import { closePersistenceContext, type PersistenceContext } from '@fraudguard/persistence';
import { signTestToken } from '@fraudguard/testkit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import pino from 'pino';

import {
  assertTrainedModelExists,
  startMlService,
  stopMlService,
  waitForReady,
} from './ml-service-process';

/**
 * RT-ML-001 (ADR-005's policy table, row "ML provider"; deferred from
 * Phase 8 — `tests/resilience/overload-shedding.resilience.test.ts`'s own
 * doc comment explains why: no `MLScoringProvider` existed yet). Phase 10
 * built it (`apps/fraud-api/src/scoring/ml-scoring.provider.ts`); this is
 * that deferred test, against the REAL process now that it exists.
 *
 * `ml-service` is a host-run Python process, not a container — this test
 * spawns and kills a real `uvicorn` child process on its own test port
 * (never the developer's own `pnpm ml:serve` on 8000), rather than
 * mocking the HTTP call. The circuit breaker's threshold/reset are
 * overridden to small numbers purely so this test finishes in seconds,
 * not because the mechanism being tested is different at the real
 * defaults (`ML_CIRCUIT_BREAKER_THRESHOLD=5`,
 * `ML_CIRCUIT_BREAKER_RESET_MS=10000`).
 *
 * CAUGHT LIVE, verifying this manually before writing the test: the FIRST
 * request from `fraud-api` to a freshly-started `ml-service` genuinely
 * failed the default 30ms `ML_TIMEOUT_MS` budget — not because the model
 * is slow (in-process inference measures ~1-2ms,
 * `docs/testing/test-results/phase10-ml-evaluation.md`), but because
 * establishing the FIRST HTTP connection between the two processes has its
 * own one-time cost that this budget does not accommodate. The correct,
 * observed behaviour is a transparent fallback with `ML_UNAVAILABLE` on
 * that one request — ADR-005's cautious design working as intended, not a
 * bug — but it would make THIS test (which cares about the
 * outage/recovery path, not that one cold-start millisecond) flaky. Using
 * a more generous `ML_TIMEOUT_MS=500` here is a deliberate, documented
 * test-only relaxation; the real 30ms hot-path budget is unchanged in
 * every other environment.
 *
 * CAUGHT A SECOND TIME, writing this test: `apps/fraud-api/src/common/
 * config.provider.ts` is `useValue: loadConfig()` — read once, when that
 * module is first evaluated, "Fail Fast" by design (matches `main.ts`'s
 * real bootstrap: config does not change after process start). A static
 * top-level `import { AppModule } from '...'` in this file is hoisted
 * ahead of this describe block's own code, so it would evaluate
 * `config.provider.ts` — and therefore read `process.env.ML_SERVICE_URL`
 * — BEFORE `beforeAll` ever sets this test's override. The result:
 * every request silently used whatever `ml-service` this test's OWN
 * `.env` already pointed at (a real `pnpm ml:serve` on port 8000,
 * running the whole time from manual verification), never this test's
 * port-8099 instance at all — so "killing" the test's own process never
 * affected what `fraud-api` was actually calling, and the outage
 * assertions failed while looking, misleadingly, like the circuit
 * breaker itself was broken. Fixed by requiring `AppModule` and its
 * fraud-api-local siblings with `require()` INSIDE `beforeAll`, after the
 * env overrides are set — the same "read order relative to module
 * evaluation" class of bug this project has hit before (dotenv/tracing
 * preloads, Phase 3/7).
 */
describe('resilience: ML provider outage falls back to rules, and recovers', () => {
  assertTrainedModelExists();

  const ML_TEST_PORT = 8099;
  const CIRCUIT_THRESHOLD = 3;
  const CIRCUIT_RESET_MS = 2_000;

  let app: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let scoreToken: string;
  let mlProcess: ChildProcess;

  const ORIGINAL_ENV = {
    SCORING_PROVIDER: process.env['SCORING_PROVIDER'],
    ML_SERVICE_URL: process.env['ML_SERVICE_URL'],
    ML_TIMEOUT_MS: process.env['ML_TIMEOUT_MS'],
    ML_CIRCUIT_BREAKER_THRESHOLD: process.env['ML_CIRCUIT_BREAKER_THRESHOLD'],
    ML_CIRCUIT_BREAKER_RESET_MS: process.env['ML_CIRCUIT_BREAKER_RESET_MS'],
  };

  function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }

  const TRANSACTION_IDS = Array.from({ length: 10 }, (_, i) => `ml_outage_${Date.now()}_${i}`);
  let nextId = 0;
  function freshId(): string {
    const id = TRANSACTION_IDS[nextId];
    nextId += 1;
    if (!id) throw new Error('ran out of pre-generated test transaction ids');
    return id;
  }

  beforeAll(async () => {
    process.env['SCORING_PROVIDER'] = 'ml';
    process.env['ML_SERVICE_URL'] = `http://127.0.0.1:${ML_TEST_PORT}`;
    process.env['ML_TIMEOUT_MS'] = '500';
    process.env['ML_CIRCUIT_BREAKER_THRESHOLD'] = String(CIRCUIT_THRESHOLD);
    process.env['ML_CIRCUIT_BREAKER_RESET_MS'] = String(CIRCUIT_RESET_MS);

    mlProcess = startMlService(ML_TEST_PORT);
    const ready = await waitForReady(ML_TEST_PORT, 30_000);
    if (!ready) throw new Error('ml-service test instance did not become ready in time');

    // Required here, not statically at the top of the file — see this
    // file's own doc comment on why that ordering matters for a provider
    // that is `useValue: loadConfig()`.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } = require('../../apps/fraud-api/src/app.module');
    const {
      HttpExceptionFilter,
    } = require('../../apps/fraud-api/src/common/http-exception.filter');
    const { PERSISTENCE_CONTEXT } = require('../../apps/fraud-api/src/common/persistence.provider');
    const { REDIS_CLIENT } = require('../../apps/fraud-api/src/common/redis.provider');
    /* eslint-enable @typescript-eslint/no-require-imports */

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

    await redis.del(...TRANSACTION_IDS.map((id) => `idem:${id}`));
    await persistence.coldPool.query(
      'DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])',
      [TRANSACTION_IDS],
    );
    await persistence.coldPool.query(
      'DELETE FROM decisions WHERE transaction_id = ANY($1::text[])',
      [TRANSACTION_IDS],
    );
    await persistence.coldPool.query(
      'DELETE FROM transactions WHERE transaction_id = ANY($1::text[])',
      [TRANSACTION_IDS],
    );
  }, 60_000);

  afterAll(async () => {
    stopMlService(mlProcess);
    restoreEnv('SCORING_PROVIDER', ORIGINAL_ENV.SCORING_PROVIDER);
    restoreEnv('ML_SERVICE_URL', ORIGINAL_ENV.ML_SERVICE_URL);
    restoreEnv('ML_TIMEOUT_MS', ORIGINAL_ENV.ML_TIMEOUT_MS);
    restoreEnv('ML_CIRCUIT_BREAKER_THRESHOLD', ORIGINAL_ENV.ML_CIRCUIT_BREAKER_THRESHOLD);
    restoreEnv('ML_CIRCUIT_BREAKER_RESET_MS', ORIGINAL_ENV.ML_CIRCUIT_BREAKER_RESET_MS);
    await redis.quit();
    await closePersistenceContext(persistence);
    await app.close();
  }, 30_000);

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
      userId: `ml_outage_user_${transactionId}`,
      merchantId: 'ml_outage_merchant',
      deviceId: 'ml_outage_device',
      amount: { minorUnits: 250_000, currency: 'USD' },
      ipAddress: '203.0.113.60',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
    };
  }

  it('scores via the real model while ml-service is up, falls back while it is down, trips the breaker, and recovers once it is back', async () => {
    // --- Warm-up: the first request pays the one-time connection cost
    // this file's own doc comment explains; not asserted on. ---------
    await inject(buildRequest(freshId()));

    // --- Baseline: ml-service healthy — the real model is used. ------
    const baseline = await inject(buildRequest(freshId()));
    expect(baseline.statusCode).toBe(200);
    const baselineParsed = scoreResponseSchema.safeParse(baseline.json());
    expect(baselineParsed.success).toBe(true);
    if (baselineParsed.success) {
      expect(baselineParsed.data.scoringProvider).toBe('ml');
      expect(baselineParsed.data.degraded).toBe(false);
    }

    // --- Outage: kill the real process, not a mock. -------------------
    stopMlService(mlProcess);
    // A small safety margin for the OS to actually release the listening
    // socket before the next request — confirmed well under this in
    // practice, kept small rather than removed entirely.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Fire enough requests to trip the breaker (threshold consecutive
    // failures) — every one must still succeed with a usable decision,
    // never a 5xx: ADR-005's whole point is that an ML outage degrades,
    // it does not fail the authorization.
    for (let i = 0; i < CIRCUIT_THRESHOLD + 1; i += 1) {
      const response = await inject(buildRequest(freshId()));
      expect(response.statusCode).toBe(200);
      const parsed = scoreResponseSchema.safeParse(response.json());
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.scoringProvider).toBe('rules'); // ML_FALLBACK_PROVIDER
        expect(parsed.data.degraded).toBe(true);
        expect(parsed.data.degradedReason).toBe('ML_UNAVAILABLE');
      }
    }

    // --- Recovery: restart ml-service, wait past the breaker's reset
    // delay, and confirm a half-open probe succeeds and closes it. -----
    mlProcess = startMlService(ML_TEST_PORT);
    const ready = await waitForReady(ML_TEST_PORT, 30_000);
    expect(ready).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, CIRCUIT_RESET_MS + 500));

    const recovered = await inject(buildRequest(freshId()));
    expect(recovered.statusCode).toBe(200);
    const recoveredParsed = scoreResponseSchema.safeParse(recovered.json());
    expect(recoveredParsed.success).toBe(true);
    if (recoveredParsed.success) {
      expect(recoveredParsed.data.scoringProvider).toBe('ml');
      expect(recoveredParsed.data.degraded).toBe(false);
    }
  }, 90_000);
});
