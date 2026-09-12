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
 * RT-REDIS-001 (ADR-005's policy table, row "Redis"): "Score using
 * transaction-intrinsic rules only... Widen the REVIEW band by lowering
 * the BLOCK threshold and the ALLOW ceiling. Flag degraded, reason
 * FEATURES_UNAVAILABLE."
 *
 * `tests/integration/fraud-api-scoring.integration.test.ts` already
 * proves the narrower Phase 4 claim — a real Redis outage still returns
 * `200` with `degraded: true` — and its own doc comment says so
 * explicitly: "The full per-dependency resilience suite (every ADR-005
 * row) is Phase 8's job." This file is that job for Redis specifically:
 * the WIDENED REVIEW band (the actual policy mechanism, not just the
 * flag), and recovery.
 *
 * With every feature at its degraded default (all rules, all
 * behavioural-score inputs, trigger on NOTHING at zero — see
 * `amount-deviation-rule.ts`/`behavioural-score.ts`'s own doc comments),
 * the combined score reduces to `SCORE_WEIGHT_MODEL *
 * min(1, amount/2000)` — purely a function of the transaction amount.
 * A $2,500 transaction's model component saturates at `1.0`, giving a
 * combined score of exactly `0.35` (`SCORE_WEIGHT_MODEL=0.35`, .env) —
 * comfortably inside `[POLICY_ALLOW_MAX=0.40` healthy`, but ALSO inside
 * `POLICY_DEGRADED_ALLOW_MAX=0.25, POLICY_DEGRADED_BLOCK_MIN=0.85)`
 * degraded. The SAME amount, scored twice — once with Redis up, once
 * down — is what actually demonstrates the band widening, not just two
 * different transactions that happen to land differently.
 */
describe('resilience: Redis outage widens the REVIEW band (ADR-005 cautious-open), then recovers', () => {
  let app: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let scoreToken: string;

  const isRedisHealthy = (): boolean => isServiceHealthy('redis');

  function buildRequest(transactionId: string): ScoreRequest {
    return {
      transactionId,
      // A fresh identity every time — this test's whole point is "no
      // behavioural history at all", which a reused userId across test
      // runs would quietly stop being true.
      userId: `redis_outage_user_${transactionId}`,
      merchantId: 'redis_outage_merchant',
      deviceId: 'redis_outage_device',
      amount: { minorUnits: 250_000, currency: 'USD' }, // $2,500 — see doc comment for why this exact amount
      ipAddress: '203.0.113.9',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
    };
  }

  const TRANSACTION_IDS = [
    'redis_outage_baseline',
    'redis_outage_degraded',
    'redis_outage_recovered',
  ];

  beforeAll(async () => {
    await ensureServiceHealthy('redis');
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

    await redis.del(...TRANSACTION_IDS.map((id) => `idem:${id}`));
    await persistence.hotPool.query(
      'DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])',
      [TRANSACTION_IDS],
    );
    await persistence.hotPool.query(
      'DELETE FROM decisions WHERE transaction_id = ANY($1::text[])',
      [TRANSACTION_IDS],
    );
    await persistence.hotPool.query(
      'DELETE FROM transactions WHERE transaction_id = ANY($1::text[])',
      [TRANSACTION_IDS],
    );
  }, 120_000);

  afterAll(async () => {
    await ensureServiceHealthy('redis');
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

  it('the identical transaction ALLOWs with Redis healthy, lands in REVIEW once Redis is down, and ALLOWs again once Redis recovers', async () => {
    // --- Baseline: Redis healthy. -------------------------------------
    const baseline = await inject(buildRequest('redis_outage_baseline'));
    expect(baseline.statusCode).toBe(200);
    const baselineParsed = scoreResponseSchema.safeParse(baseline.json());
    expect(baselineParsed.success).toBe(true);
    if (baselineParsed.success) {
      expect(baselineParsed.data.degraded).toBe(false);
      expect(baselineParsed.data.decision).toBe('ALLOW');
    }

    // --- Redis down: the SAME amount now lands in REVIEW. ------------
    dockerCompose('stop redis');
    try {
      const degraded = await inject(buildRequest('redis_outage_degraded'));
      expect(degraded.statusCode).toBe(200); // cautious-open, not a failure
      const degradedParsed = scoreResponseSchema.safeParse(degraded.json());
      expect(degradedParsed.success).toBe(true);
      if (degradedParsed.success) {
        expect(degradedParsed.data.degraded).toBe(true);
        expect(degradedParsed.data.degradedReason).toBe('FEATURES_UNAVAILABLE');
        // The actual policy mechanism, not just the flag: the widened
        // band is what turned an otherwise-ALLOW amount into a REVIEW.
        expect(degradedParsed.data.decision).toBe('REVIEW');
      }
    } finally {
      dockerCompose('start redis');
    }

    const recovered = await waitUntil(isRedisHealthy, 90_000);
    expect(recovered).toBe(true);
    // No explicit redis.connect() here: the container restart, not a
    // deliberate client-side redis.disconnect(), is what severed the
    // connection — ioredis's own default retryStrategy reconnects
    // automatically once the server is reachable again. Calling
    // .connect() on a client that is already mid-reconnect throws
    // ("Redis is already connecting/connected").
    if (redis.status !== 'ready') {
      await waitUntil(() => redis.status === 'ready', 30_000, 500);
    }

    // --- Recovery: the identical amount ALLOWs again. -----------------
    const recoveredResponse = await inject(buildRequest('redis_outage_recovered'));
    expect(recoveredResponse.statusCode).toBe(200);
    const recoveredParsed = scoreResponseSchema.safeParse(recoveredResponse.json());
    expect(recoveredParsed.success).toBe(true);
    if (recoveredParsed.success) {
      expect(recoveredParsed.data.degraded).toBe(false);
      expect(recoveredParsed.data.decision).toBe('ALLOW');
    }
  }, 150_000);
});
