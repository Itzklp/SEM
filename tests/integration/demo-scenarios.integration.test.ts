import { loadConfig } from '@fraudguard/config';
import { scoreResponseSchema, type ScoreRequest } from '@fraudguard/contracts';
import { createTransaction, Money, RiskScore, type FraudDecision } from '@fraudguard/domain';
import { recordTransactionFeatures, setMerchantRiskScore } from '@fraudguard/feature-store';
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

/**
 * Phase 5's exit criterion, verbatim (docs/ROADMAP.md): "A demo
 * transaction of each class produces ALLOW, REVIEW, BLOCK respectively."
 * Runs the REAL `RuleBasedScoringProvider` through the REAL live app
 * (real Postgres, real Redis) — not a unit test constructing a provider
 * directly. Each scenario seeds exactly the feature state needed to
 * produce its decision deterministically, then asks the actual
 * `POST /api/v1/fraud/score` endpoint, so this is the same claim a demo
 * operator could reproduce by hand.
 */
describe('demo: ALLOW / REVIEW / BLOCK, one transaction of each class (Phase 5 gate)', () => {
  let app: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let scoreToken: string;

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

    // This file uses fixed, readable transactionIds (a demo script reads
    // better that way) rather than the generator's random ones — which
    // means a second local run, without a fresh database, would hit
    // FR-017's idempotency fast path and replay a STALE decision instead
    // of actually re-scoring. Caught live: changing the BLOCK scenario's
    // amount had no effect until this cleanup was added, because the
    // previous run's cached "REVIEW" kept winning. CI always starts from
    // a fresh database, so this only matters for local reruns — but a
    // test that silently passes on stale data either way is worse than
    // one that requires a clean slate and says so.
    const demoTransactionIds = ['demo_allow_001', 'demo_review_001', 'demo_block_001'];
    await persistence.hotPool.query('DELETE FROM decisions WHERE transaction_id = ANY($1)', [
      demoTransactionIds,
    ]);
    await persistence.hotPool.query('DELETE FROM transactions WHERE transaction_id = ANY($1)', [
      demoTransactionIds,
    ]);
    await redis.del(...demoTransactionIds.map((id) => `idem:${id}`));

    const config = loadConfig();
    scoreToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['score'],
    });
  });

  afterAll(async () => {
    await redis.quit();
    await closePersistenceContext(persistence);
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
      transactionId: 'demo_default',
      userId: 'demo_user_default',
      merchantId: 'demo_merchant_default',
      deviceId: 'demo_device_default',
      amount: { minorUnits: 2_000, currency: 'USD' }, // $20 — unremarkable
      ipAddress: '203.0.113.1',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  // Seeds enough recent transactions for a user that VelocityRule fires
  // CRITICAL (ratio >= 2 against the default RULE_VELOCITY_MAX_5M=10).
  async function seedHighVelocity(userId: string, deviceId: string, count: number): Promise<void> {
    const now = Date.now();
    for (let i = 0; i < count; i += 1) {
      const transaction = createTransaction({
        transactionId: `demo_velocity_seed_${userId}_${i}`,
        userId,
        merchantId: 'demo_merchant_seed',
        deviceId,
        amount: Money.of(1_000, 'USD'),
        ipAddress: '203.0.113.1',
        paymentMethod: 'card_token_demo',
        timestamp: new Date(now - i * 1_000), // 1 second apart, well inside 5 minutes
      });
      const decision: FraudDecision = {
        transactionId: transaction.transactionId,
        decision: 'ALLOW',
        riskScore: RiskScore.zero(),
        reasons: [],
        policyVersion: 'demo-seed',
        modelVersion: 'demo-seed',
        scoringProvider: 'stub',
        degraded: false,
        degradedReason: 'NONE',
        decidedAt: new Date(),
        processingTimeMs: 1,
      };
      await recordTransactionFeatures(redis, transaction, decision);
    }
  }

  // DEMO-001. The ALLOW class: a normal, unremarkable transaction from a
  // user with no concerning history.
  it('ALLOW: a normal transaction with no risk signal', async () => {
    const request = buildRequest({
      transactionId: 'demo_allow_001',
      userId: 'demo_allow_user',
      merchantId: 'demo_allow_merchant',
      deviceId: 'demo_allow_device',
      amount: { minorUnits: 1_500, currency: 'USD' }, // $15
    });

    const response = await inject(request);
    expect(response.statusCode).toBe(200);
    const parsed = scoreResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.decision).toBe('ALLOW');
    }
  });

  // DEMO-002. The REVIEW class: a single HIGH-severity merchant-risk
  // signal, strong enough to cross allowMax (0.4) but not blockMin (0.75).
  it('REVIEW: a single elevated-risk signal, not severe enough to auto-block', async () => {
    const merchantId = 'demo_review_merchant';
    await setMerchantRiskScore(redis, merchantId, 0.85); // HIGH severity — see MerchantRiskRule

    const request = buildRequest({
      transactionId: 'demo_review_001',
      userId: 'demo_review_user',
      merchantId,
      deviceId: 'demo_review_device',
      amount: { minorUnits: 1_000, currency: 'USD' }, // $10 — keep the model component negligible
    });

    const response = await inject(request);
    expect(response.statusCode).toBe(200);
    const parsed = scoreResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.decision).toBe('REVIEW');
      expect(parsed.data.reasons.length).toBeGreaterThan(0); // FR-007
    }
  });

  // DEMO-003. The BLOCK class: two independently severe signals at once
  // (a velocity burst and a near-maximal merchant risk score).
  it('BLOCK: multiple severe, independent risk signals at once', async () => {
    const userId = 'demo_block_user';
    const deviceId = 'demo_block_device';
    const merchantId = 'demo_block_merchant';
    await seedHighVelocity(userId, deviceId, 25); // well past RULE_VELOCITY_MAX_5M=10
    await setMerchantRiskScore(redis, merchantId, 0.95); // CRITICAL severity

    const request = buildRequest({
      transactionId: 'demo_block_001',
      userId,
      merchantId,
      deviceId,
      // Large enough that the model component alone (amount/$2,000,
      // stub-scoring-provider.ts) adds materially on top of the rules
      // component maxing out at 1.0*SCORE_WEIGHT_RULES=0.5 — needed to
      // clear blockMin (0.75). A smaller amount (tried first: $50)
      // landed at REVIEW (~0.58), not BLOCK — caught by this test, not
      // asserted from arithmetic alone.
      amount: { minorUnits: 190_000, currency: 'USD' }, // $1,900
    });

    const response = await inject(request);
    expect(response.statusCode).toBe(200);
    const parsed = scoreResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.decision).toBe('BLOCK');
      expect(parsed.data.reasons.length).toBeGreaterThan(0); // FR-007
    }

    // The persisted row must reflect the same decision — the demo claim
    // is about the whole pipeline, not just the HTTP response shape.
    const row = await persistence.hotPool.query<{ decision: string }>(
      'SELECT decision FROM decisions WHERE transaction_id = $1',
      [request.transactionId],
    );
    expect(row.rows[0]?.decision).toBe('BLOCK');
  });
});
