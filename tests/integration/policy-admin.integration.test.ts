import { loadConfig } from '@fraudguard/config';
import { scoreResponseSchema, type PolicyResponse, type ScoreRequest } from '@fraudguard/contracts';
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
 * FR-006: "Thresholds are configurable at runtime without redeployment.
 * The active policy version is recorded on every decision." Proved
 * against the real, running app — a runtime PUT actually changes what
 * the very next `/fraud/score` call decides, with no restart in between.
 */
describe('admin: runtime policy configuration (FR-006)', () => {
  let app: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let adminToken: string;
  let scoreOnlyToken: string;

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

    const config = loadConfig();
    adminToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['admin'],
    });
    scoreOnlyToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['score'],
    });
    // outbox_events too — a deterministic `event_id` (ADR-006) from a
    // stale prior run collides with a fresh insert for the same
    // transactionId otherwise. See demo-scenarios.integration.test.ts's
    // identical fix for the failure this produces if skipped.
    const policyAdminTransactionIds = ['policy_admin_demo', 'policy_admin_demo_2'];
    await redis.del(...policyAdminTransactionIds.map((id) => `idem:${id}`));
    await persistence.hotPool.query('DELETE FROM outbox_events WHERE aggregate_id = ANY($1)', [
      policyAdminTransactionIds,
    ]);
    await persistence.hotPool.query('DELETE FROM decisions WHERE transaction_id = ANY($1)', [
      policyAdminTransactionIds,
    ]);
    await persistence.hotPool.query('DELETE FROM transactions WHERE transaction_id = ANY($1)', [
      policyAdminTransactionIds,
    ]);
  });

  afterAll(async () => {
    await redis.quit();
    await closePersistenceContext(persistence);
    await app.close();
  });

  function inject(method: 'GET' | 'PUT', payload: unknown, token: string) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url: '/api/v1/admin/policy',
        headers: { authorization: `Bearer ${token}` },
        ...(payload !== undefined ? { payload } : {}),
      });
  }

  function scoreRequest(): ScoreRequest {
    return {
      transactionId: 'policy_admin_demo',
      userId: 'policy_admin_user',
      merchantId: 'policy_admin_merchant',
      deviceId: 'policy_admin_device',
      amount: { minorUnits: 3_000, currency: 'USD' }, // $30
      ipAddress: '203.0.113.1',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
    };
  }

  function scoreInject() {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/fraud/score',
        headers: { authorization: `Bearer ${scoreOnlyToken}` },
        payload: scoreRequest(),
      });
  }

  it('GET returns the policy loaded from configuration at boot', async () => {
    const response = await inject('GET', undefined, adminToken);
    expect(response.statusCode).toBe(200);
    const body = response.json() as PolicyResponse;
    expect(body.policyVersion).toBeTruthy();
    expect(body.allowMax).toBeLessThan(body.blockMin);
  });

  it('rejects a score-only token — admin is a distinct privilege (FR-015)', async () => {
    const response = await inject('GET', undefined, scoreOnlyToken);
    expect(response.statusCode).toBe(403);
  });

  it('rejects an invalid policy (no REVIEW band) and leaves the stored policy unchanged', async () => {
    const before = (await inject('GET', undefined, adminToken)).json() as PolicyResponse;

    const response = await inject(
      'PUT',
      {
        policyVersion: 'bad-policy',
        allowMax: 0.8,
        blockMin: 0.2,
        degraded: { allowMax: 0.1, blockMin: 0.9 },
      },
      adminToken,
    );
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('INVALID_POLICY');

    const after = (await inject('GET', undefined, adminToken)).json() as PolicyResponse;
    expect(after).toEqual(before);
  });

  // The actual FR-006 claim: a runtime change changes the NEXT decision,
  // with no restart. $30 against the default policy (allowMax 0.4) is a
  // clean ALLOW; tightening allowMax to below the model component's
  // contribution for $30 (StubFraudScoringProvider: 30/2000 = 0.015,
  // weighted 0.015*0.35 ≈ 0.00525) flips it to REVIEW.
  it('changes the decision for an identical request, immediately, with no restart', async () => {
    const originalPolicy = (await inject('GET', undefined, adminToken)).json() as PolicyResponse;

    const before = await scoreInject();
    const beforeBody = scoreResponseSchema.parse(before.json());
    expect(beforeBody.decision).toBe('ALLOW');

    const tightened = await inject(
      'PUT',
      {
        ...originalPolicy,
        allowMax: 0.001,
        // isValidRiskPolicy requires degraded.allowMax <= allowMax
        // (ADR-005) even though this request's features are healthy and
        // never consult the degraded band — the submitted policy still
        // has to be structurally valid as a whole.
        degraded: { ...originalPolicy.degraded, allowMax: 0.0005 },
      },
      adminToken,
    );
    expect(tightened.statusCode).toBe(200);

    // A fresh transactionId — the first request's idempotency cache must
    // not mask whether the NEW policy actually ran.
    const secondRequest = { ...scoreRequest(), transactionId: 'policy_admin_demo_2' };
    const after = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/fraud/score',
        headers: { authorization: `Bearer ${scoreOnlyToken}` },
        payload: secondRequest,
      });
    const afterBody = scoreResponseSchema.parse(after.json());
    expect(afterBody.decision).not.toBe('ALLOW');
    expect(afterBody.policyVersion).toBe(originalPolicy.policyVersion); // version unchanged in this test's PUT

    // Restore, so later test files (and a re-run of this one) are not
    // left with a tightened policy — PolicyStore's state otherwise
    // outlives this single test.
    await inject('PUT', originalPolicy, adminToken);
    await persistence.hotPool.query('DELETE FROM decisions WHERE transaction_id = $1', [
      'policy_admin_demo_2',
    ]);
    await persistence.hotPool.query('DELETE FROM transactions WHERE transaction_id = $1', [
      'policy_admin_demo_2',
    ]);
    await redis.del('idem:policy_admin_demo_2');
  });
});
