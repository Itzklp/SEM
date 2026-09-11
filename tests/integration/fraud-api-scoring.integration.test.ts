import { loadConfig } from '@fraudguard/config';
import { scoreResponseSchema } from '@fraudguard/contracts';
import { closePersistenceContext, type PersistenceContext } from '@fraudguard/persistence';
import { generateTransaction, signTestToken } from '@fraudguard/testkit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import pino from 'pino';

import { AppModule } from '../../apps/fraud-api/src/app.module';
import { HttpExceptionFilter } from '../../apps/fraud-api/src/common/http-exception.filter';
import { PERSISTENCE_CONTEXT } from '../../apps/fraud-api/src/common/persistence.provider';
import { REDIS_CLIENT } from '../../apps/fraud-api/src/common/redis.provider';

/**
 * Runs against REAL PostgreSQL and Redis (`pnpm docker:up` / CI service
 * containers) — this is exactly the class of bug a mock cannot catch: a
 * wrong SQL type, a Fastify routing quirk, a JWT claim mismatch between
 * signer and verifier. Requires migrations already applied
 * (`pnpm db:migrate`) — see docs/testing/test-strategy.md §3.2.
 */
describe('fraud-api: POST /api/v1/fraud/score (integration)', () => {
  let app: NestFastifyApplication;
  let persistence: PersistenceContext;
  let redis: Redis;
  let scoreToken: string;
  let wrongPrivilegeToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // main.ts's bootstrap() is what normally registers this — a testing
    // module built directly (bypassing main.ts) has to register it too, or
    // NestJS's default exception body shape is exercised instead of ours.
    // Caught live: every 4xx assertion below failed with "Cannot read
    // properties of undefined (reading 'code')" until this was added.
    app.useGlobalFilters(new HttpExceptionFilter(pino({ level: 'silent' })));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    persistence = app.get<PersistenceContext>(PERSISTENCE_CONTEXT);
    redis = app.get<Redis>(REDIS_CLIENT);
    // The Redis client connects eagerly but asynchronously (redis-client.ts);
    // with enableOfflineQueue:false, a command issued before the connection
    // settles fails immediately (ADR-005's degraded fallback correctly
    // catches this — it's not a test bug), but it would make the very
    // first test in this file incidentally exercise the degraded path
    // instead of the happy path it's meant to test. Waiting here keeps
    // that race out of the test itself; production has no such wait and
    // is expected to tolerate it.
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
    wrongPrivilegeToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['review'], // valid token, wrong privilege for /fraud/score
    });
  });

  afterAll(async () => {
    await redis.quit();
    await closePersistenceContext(persistence);
    await app.close();
  });

  function inject(payload: unknown, token: string | undefined) {
    return app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/fraud/score',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload,
      });
  }

  // IT-API-001. What: a valid, authenticated request produces a decision.
  // Why: this is the entire Phase 3 exit criterion — the pipeline actually
  //      works end to end against real infrastructure, not mocks.
  it('returns a valid ScoreResponse for a well-formed, authenticated request', async () => {
    const txn = generateTransaction({ seed: 3001 }, 0);
    const response = await inject(txn, scoreToken);

    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    const parsed = scoreResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.transactionId).toBe(txn.transactionId);
      // The scoring provider is still Phase 5's stub (always scores 0 ->
      // ALLOW). Features, as of Phase 4, are REAL — and Redis is up and
      // reachable in this suite, so a brand-new generated user legitimately
      // gets a *live* vector full of declared defaults (no history is not
      // the same as "unavailable"; see feature-reader.ts). Updated from
      // Phase 3, where this always read degraded=true because no real
      // feature computation existed yet to be anything else.
      expect(parsed.data.decision).toBe('ALLOW');
      expect(parsed.data.degraded).toBe(false);
      expect(parsed.data.degradedReason).toBe('NONE');
    }

    // The persisted transaction must reflect the lifecycle actually
    // completed (RECEIVED -> ... -> DECIDED), not just its initial status.
    // Caught live: transitionTransaction()'s return value wasn't being
    // captured, so every persisted row stayed at 'RECEIVED' regardless of
    // how far the pipeline got.
    const row = await persistence.hotPool.query<{ status: string }>(
      'SELECT status FROM transactions WHERE transaction_id = $1',
      [txn.transactionId],
    );
    expect(row.rows[0]?.status).toBe('DECIDED');
  });

  // IT-API-002. What: a malformed request is rejected with field-level detail and no side effects.
  // Why: FR-001's acceptance criteria explicitly requires both halves —
  //      catches a validation bug that accepts bad input, and separately
  //      catches a handler that writes before validating.
  it('rejects a malformed request with 400 naming the offending field, with no persisted row', async () => {
    const txn = generateTransaction({ seed: 3002 }, 0);
    const malformed = { ...txn, amount: { minorUnits: 19.99, currency: txn.amount.currency } }; // non-integer minor units

    const response = await inject(malformed, scoreToken);

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; details?: { field: string }[] } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details?.some((d) => d.field.includes('amount'))).toBe(true);

    const row = await persistence.hotPool.query(
      'SELECT 1 FROM transactions WHERE transaction_id = $1',
      [malformed.transactionId],
    );
    expect(row.rowCount).toBe(0);
  });

  // ST-001. What: no Authorization header.
  it('rejects an unauthenticated request with 401', async () => {
    const txn = generateTransaction({ seed: 3003 }, 0);
    const response = await inject(txn, undefined);
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe('AUTH_MISSING_TOKEN');
  });

  // ST-001. What: a syntactically invalid token.
  it('rejects a malformed token with 401', async () => {
    const txn = generateTransaction({ seed: 3004 }, 0);
    const response = await inject(txn, 'not-a-real-jwt');
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe('AUTH_INVALID_TOKEN');
  });

  // ST-005. What: a valid token lacking the required privilege.
  // Why: distinguishes 401 (who are you) from 403 (not allowed to do this) — FR-015.
  it('rejects a validly-authenticated but under-privileged request with 403', async () => {
    const txn = generateTransaction({ seed: 3005 }, 0);
    const response = await inject(txn, wrongPrivilegeToken);
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'INSUFFICIENT_PRIVILEGE',
    );
  });

  // IT-IDEM-001. What: replaying the same transactionId returns the ORIGINAL decision.
  // Why: FR-017 — this is the Redis fast path specifically (RT-DUP-001's
  //      DB-backstop variant needs Redis stopped, which is a Phase 8
  //      resilience scenario, not this test).
  it('returns the original decision for a duplicate transactionId (FR-017)', async () => {
    const txn = generateTransaction({ seed: 3006 }, 0);

    const first = await inject(txn, scoreToken);
    const second = await inject(txn, scoreToken);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
  });

  // RT-005 (Phase 4 exit criterion: "Missing Redis returns declared
  // defaults rather than throwing"). What: with Redis unreachable, a
  // well-formed, authenticated request still gets a 200 decision — using
  // every feature's declared default — rather than an error. Why: this is
  // ADR-005's cautious-open policy for Redis, proved for the first time
  // against a REAL failure (Phase 3 only ever exercised the Phase-3
  // placeholder's permanently-"unavailable" vector, never an actual Redis
  // outage). The full per-dependency resilience suite (every ADR-005 row)
  // is Phase 8's job — this is Phase 4's narrower claim about its own
  // fallback, not a resilience suite.
  it('falls back to degraded, cautious-open features when Redis is unreachable, rather than failing the request', async () => {
    const txn = generateTransaction({ seed: 3007 }, 0);
    redis.disconnect();
    try {
      const response = await inject(txn, scoreToken);
      expect(response.statusCode).toBe(200);
      const body: unknown = response.json();
      const parsed = scoreResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.degraded).toBe(true);
        expect(parsed.data.degradedReason).toBe('FEATURES_UNAVAILABLE');
      }
    } finally {
      redis.connect();
      if (redis.status !== 'ready') {
        await new Promise((resolve) => redis.once('ready', resolve));
      }
    }
  });

  it('GET /api/v1/health reports healthy dependencies without authentication', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('healthy');
    expect(body.dependencies.postgres?.status).toBe('up');
    expect(body.dependencies.redis?.status).toBe('up');
  });
});
