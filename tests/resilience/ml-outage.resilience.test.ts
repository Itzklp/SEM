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
 * RT-ML-001 (ADR-005's policy table, row "ML provider"): drives a real
 * `uvicorn` ml-service child process (own test port, not the dev's 8000)
 * through outage and recovery — no mocked HTTP call.
 *
 * Two things worth knowing if this test ever looks broken:
 * - The first request after ml-service starts pays a one-time connection
 *   cost that can exceed the real 30ms ML_TIMEOUT_MS budget, so this test
 *   uses a relaxed 500ms timeout — the real hot-path budget elsewhere is untouched.
 * - `config.provider.ts` reads env once at module load, so AppModule and its
 *   siblings must be `require()`-d inside `beforeAll`, after the env overrides
 *   below are set, not imported statically at the top of this file.
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
    // Warm-up: absorbs the one-time connection cost, not asserted on.
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
