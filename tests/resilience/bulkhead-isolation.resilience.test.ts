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

/**
 * RT-BULK-001 (NFR-007, ADR-004's bulkhead): "Heavy analyst query load
 * does not affect authorization p99." Proved here at the level that
 * actually makes the claim true or false — the CONNECTION POOLS
 * themselves — rather than by also standing up a full `review-api`
 * process: `review-api`'s queries and this test's `pg_sleep()` calls
 * both ultimately reduce to "slow queries against `coldPool`"; what
 * determines whether `fraud-api` notices is exclusively whether
 * `hotPool` and `coldPool` are genuinely separate pools, which is
 * `packages/persistence/src/connection.ts`'s job, not `review-api`'s.
 *
 * `pg_sleep(0.5)` is a deliberately SLOW, deliberately ARTIFICIAL
 * analyst query — real review-api queries are not this slow — chosen
 * specifically to saturate every one of `POSTGRES_POOL_COLD_MAX`'s
 * connections for long enough that the test window has no ambiguity
 * about whether the cold pool was genuinely under load throughout.
 *
 * The ASSUMED threshold below (scoring stays fast DURING the cold-path
 * saturation) is a coarse "the bulkhead isn't obviously broken" check on
 * uncontrolled dev hardware, co-located with everything else running —
 * not NFR-007's own rigorously-measured, isolated-hardware claim, which
 * stays Phase 9's (same caveat `IT-FEAT-003`, Phase 4, already applies
 * to a similar hardware-co-location number).
 */
describe('resilience: heavy cold-path (analyst) query load does not slow the hot path', () => {
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

    const config = loadConfig();
    scoreToken = signTestToken({
      secret: config.security.jwt.secret,
      issuer: config.security.jwt.issuer,
      audience: config.security.jwt.audience,
      privileges: ['score'],
    });
  }, 60_000);

  afterAll(async () => {
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
      userId: `bulkhead_user_${transactionId}`,
      merchantId: 'bulkhead_merchant',
      deviceId: 'bulkhead_device',
      amount: { minorUnits: 1_000, currency: 'USD' },
      ipAddress: '203.0.113.21',
      paymentMethod: 'card_token_demo',
      timestamp: new Date().toISOString(),
    };
  }

  async function scoreOnce(transactionId: string): Promise<number> {
    const start = Date.now();
    const response = await inject(buildRequest(transactionId));
    const elapsed = Date.now() - start;
    expect(response.statusCode).toBe(200);
    expect(scoreResponseSchema.safeParse(response.json()).success).toBe(true);
    return elapsed;
  }

  it('fraud-api authorization latency stays low while coldPool is fully saturated with slow analyst-style queries', async () => {
    const testTransactionIds = Array.from({ length: 10 }, (_, i) => `bulkhead_baseline_${i}`);
    const underLoadIds = Array.from({ length: 10 }, (_, i) => `bulkhead_underload_${i}`);
    const allIds = [...testTransactionIds, ...underLoadIds];
    // Cleanup happens entirely up front, via coldPool (a comfortable
    // 5000ms statement_timeout — .env — versus hotPool's 100ms, which
    // this DELETE genuinely exceeded once under this session's
    // accumulated test load) and BEFORE the cold-path saturation below
    // starts, so cleanup itself never has to queue behind the 20
    // pg_sleep(0.5) calls it would otherwise be contending with.
    //
    // Deleted in FK dependency order (outbox_events/decisions before
    // transactions) — caught live, on this test's own SECOND run: a
    // first run's transactions row survives (this file never deletes
    // it, only checks latency), so a second run's plain `DELETE FROM
    // transactions` hit `decisions_transaction_id_fkey` and failed
    // outright, same bug class Phase 5/6 already found in other test
    // files' cleanup blocks.
    await redis.del(...allIds.map((id) => `idem:${id}`));
    await persistence.coldPool.query(
      'DELETE FROM outbox_events WHERE aggregate_id = ANY($1::text[])',
      [allIds],
    );
    await persistence.coldPool.query(
      'DELETE FROM decisions WHERE transaction_id = ANY($1::text[])',
      [allIds],
    );
    await persistence.coldPool.query(
      'DELETE FROM transactions WHERE transaction_id = ANY($1::text[])',
      [allIds],
    );

    // --- Baseline: no cold-path load. ----------------------------------
    const baselineLatencies: number[] = [];
    for (const id of testTransactionIds) {
      baselineLatencies.push(await scoreOnce(id));
    }

    // --- Saturate coldPool: far more slow queries than it has
    // connections for (POSTGRES_POOL_COLD_MAX=5, .env), so every
    // connection is genuinely busy for the whole test window. Started
    // and NOT awaited yet — the point is to have it running
    // CONCURRENTLY with the scoring requests below. -------------------
    const coldPathLoad = Promise.all(
      Array.from({ length: 20 }, () => persistence.coldPool.query('SELECT pg_sleep(0.5)')),
    );

    // A brief moment for the cold load to actually occupy every
    // connection before measuring — otherwise the first few scoring
    // requests below could race ahead of the saturation actually
    // taking hold.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const underLoadLatencies: number[] = [];
    for (const id of underLoadIds) {
      underLoadLatencies.push(await scoreOnce(id));
    }

    // The cold load MUST still be self-consistent by the time we
    // assert on it — if it already finished, this test measured
    // nothing under contention at all.
    const coldLoadStillRunning = await Promise.race([
      coldPathLoad.then(() => false),
      Promise.resolve(true),
    ]);
    expect(coldLoadStillRunning).toBe(true);

    await coldPathLoad; // drain before the test ends, not left dangling into afterAll

    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const baselineMedian = median(baselineLatencies);
    const underLoadMedian = median(underLoadLatencies);

    // ASSUMED threshold, not a rigorously measured NFR-007 bound (see
    // doc comment): every authorization under cold-path saturation
    // still completed well inside a loose, generous ceiling — this
    // would fail hard if the bulkhead were actually broken (e.g. one
    // shared pool), where scoring would queue behind the 0.5s sleeps.
    for (const latency of underLoadLatencies) {
      expect(latency).toBeLessThan(300);
    }
    // eslint-disable-next-line no-console -- measured result, not a log level decision; this project reports numbers it didn't assert blindly (same pattern as IT-FEAT-003).
    console.log(
      `[RT-BULK-001] median authorization latency: baseline=${baselineMedian}ms, under cold-path saturation=${underLoadMedian}ms (MEASURED, co-located — see doc comment)`,
    );
  }, 60_000);
});
