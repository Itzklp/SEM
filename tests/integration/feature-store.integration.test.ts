import { loadConfig } from '@fraudguard/config';
import { createTransaction, Money, RiskScore, type FraudDecision } from '@fraudguard/domain';
import {
  createRedisClient,
  getFeatureVector,
  recordTransactionFeatures,
} from '@fraudguard/feature-store';
import type { Redis } from 'ioredis';

/**
 * Phase 4 exit criteria (docs/ROADMAP.md), proved against a REAL local
 * Redis (`pnpm docker:up`) rather than `ioredis-mock` — the mock
 * (`packages/feature-store/src/feature-store.test.ts`) proves the
 * aggregation logic is correct; this file proves the same logic also
 * behaves correctly over a real connection, with real command latency.
 *
 * Cleanup is scoped to this package's own `feat:` keyspace, NOT a
 * `flushdb()`. Caught live: Jest runs test *files* as separate worker
 * processes, potentially concurrently with `fraud-api-scoring.integration
 * .test.ts` against the same Redis — a blanket flush from this file
 * intermittently deleted that file's `idem:` idempotency keys mid-test,
 * producing a real, hard-to-reproduce flake. `KEYS`/`DEL` need the literal
 * `REDIS_KEY_PREFIX` handled by hand here: ioredis's `keyPrefix` option
 * prepends to key *arguments* automatically, but `KEYS`'s argument is a
 * pattern, not a key, so it is neither prefixed going out nor stripped
 * coming back — confirmed against the real client, not assumed.
 */
describe('feature-store (integration): real Redis', () => {
  let redis: Redis;
  let keyPrefix: string;

  async function clearFeatureKeys(): Promise<void> {
    const prefixed = await redis.keys(`${keyPrefix}feat:*`);
    const logical = prefixed.map((k) => k.slice(keyPrefix.length));
    if (logical.length > 0) {
      await redis.del(...logical);
    }
  }

  beforeAll(async () => {
    const config = loadConfig();
    keyPrefix = config.redis.keyPrefix;
    redis = createRedisClient(config);
    if (redis.status !== 'ready') {
      await new Promise((resolve) => redis.once('ready', resolve));
    }
    await clearFeatureKeys();
  });

  afterAll(async () => {
    await clearFeatureKeys();
    await redis.quit();
  });

  function buildTransaction(overrides: {
    transactionId: string;
    userId: string;
    merchantId?: string;
    deviceId?: string;
    amountMinorUnits?: number;
    ipAddress?: string;
    timestamp: Date;
  }) {
    return createTransaction({
      transactionId: overrides.transactionId,
      userId: overrides.userId,
      merchantId: overrides.merchantId ?? 'merchant_1',
      deviceId: overrides.deviceId ?? 'device_1',
      amount: Money.of(overrides.amountMinorUnits ?? 1_000, 'USD'),
      ipAddress: overrides.ipAddress ?? '203.0.113.1',
      paymentMethod: 'card_token_1',
      timestamp: overrides.timestamp,
    });
  }

  function buildDecision(transactionId: string, decision: FraudDecision['decision'] = 'ALLOW') {
    const fraudDecision: FraudDecision = {
      transactionId,
      decision,
      riskScore: RiskScore.zero(),
      reasons: [],
      policyVersion: 'it-policy-v1',
      modelVersion: 'it-model-v1',
      scoringProvider: 'stub',
      degraded: false,
      degradedReason: 'NONE',
      decidedAt: new Date(),
      processingTimeMs: 1,
    };
    return fraudDecision;
  }

  // IT-FEAT-001. What: after N seeded transactions for a user, served
  // features reflect all N. Why: this is the Phase 4 exit criterion,
  // verbatim, against real infrastructure rather than a mock.
  it('reflects all N seeded transactions for a user, against a real Redis', async () => {
    const userId = 'it_feat_001';
    const base = Date.UTC(2026, 5, 1, 0, 0, 0);
    const count = 8;
    for (let i = 0; i < count; i += 1) {
      const txn = buildTransaction({
        transactionId: `it_feat_001_${i}`,
        userId,
        timestamp: new Date(base + i * 10_000), // 10s apart — all inside 5m
      });
      await recordTransactionFeatures(redis, txn, buildDecision(txn.transactionId));
    }

    const vector = await getFeatureVector(
      redis,
      { userId, deviceId: 'device_1', merchantId: 'merchant_1', ipAddress: '203.0.113.1' },
      new Date(base + (count - 1) * 10_000),
    );

    expect(vector.source).toBe('live');
    expect(vector.features.transaction_count_5m).toBe(count);
    expect(vector.features.transaction_count_1h).toBe(count);
  });

  // IT-FEAT-002. What: replaying the same (transaction, decision) sequence
  // into a clean keyspace reproduces the exact feature state the live run
  // produced. Why: ADR-002's "that rebuild path must actually be
  // implemented and tested, not assumed" — proved here against the real
  // store, not only the in-memory one.
  it('rebuild-from-replay reproduces the live feature state, against a real Redis', async () => {
    const userId = 'it_feat_002';
    const base = Date.UTC(2026, 5, 2, 0, 0, 0);
    const events = Array.from({ length: 6 }, (_, i) => {
      const txn = buildTransaction({
        transactionId: `it_feat_002_${i}`,
        userId,
        merchantId: i % 2 === 0 ? 'merchant_A' : 'merchant_B',
        amountMinorUnits: 1_000 * (i + 1),
        timestamp: new Date(base + i * 5 * 60_000), // 5 minutes apart
      });
      return {
        transaction: txn,
        decision: buildDecision(txn.transactionId, i === 4 ? 'BLOCK' : 'ALLOW'),
      };
    });
    const asOf = new Date(base + 5 * 5 * 60_000);
    const lookup = {
      userId,
      deviceId: 'device_1',
      merchantId: 'merchant_1',
      ipAddress: '203.0.113.1',
    };

    for (const { transaction, decision } of events) {
      await recordTransactionFeatures(redis, transaction, decision);
    }
    const live = await getFeatureVector(redis, lookup, asOf);

    // Clear only this user's keys — a real rebuild-from-replay in
    // production starts from an empty feature state for the aggregate
    // being rebuilt, not a wiped database.
    await redis.del(
      `feat:user:${userId}:log`,
      `feat:user:${userId}:amount`,
      `feat:user:${userId}:merchant`,
      `feat:user:${userId}:location`,
      `feat:user:${userId}:failed`,
      `feat:account:${userId}:first_seen`,
    );

    for (const { transaction, decision } of events) {
      await recordTransactionFeatures(redis, transaction, decision);
    }
    const replayed = await getFeatureVector(redis, lookup, asOf);

    expect(replayed.features).toEqual(live.features);
  });

  // IT-FEAT-003. What: the hot path's feature-fetch latency, measured
  // (not estimated) against ADR-002's 8ms stage budget. NFR-003.
  //
  // CAVEAT (RISK-001, DEVELOPMENT_ENVIRONMENT.md §5.2): client and server
  // are co-located on the same machine — this is Node's view of its own
  // Redis round trip, not an isolated measurement. A clean number here is
  // expected on this hardware at this (near-zero) load; Phase 9 is where
  // this gets measured properly, under load, with the hardware caveat
  // attached to every figure.
  it('measures feature-fetch p99 latency against the 8ms stage budget', async () => {
    const userId = 'it_feat_003';
    const base = Date.UTC(2026, 5, 3, 0, 0, 0);
    // A moderately "busy" user: enough history that every window and
    // every HMGET this function issues has real work to do, not an
    // empty-window fast path.
    for (let i = 0; i < 50; i += 1) {
      const txn = buildTransaction({
        transactionId: `it_feat_003_${i}`,
        userId,
        merchantId: `merchant_${i % 10}`,
        timestamp: new Date(base + i * 1_000),
      });
      await recordTransactionFeatures(redis, txn, buildDecision(txn.transactionId));
    }
    const asOf = new Date(base + 49_000);
    const lookup = {
      userId,
      deviceId: 'device_1',
      merchantId: 'merchant_1',
      ipAddress: '203.0.113.1',
    };

    const SAMPLES = 200;
    const durationsMs: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const start = process.hrtime.bigint();
      await getFeatureVector(redis, lookup, asOf);
      const end = process.hrtime.bigint();
      durationsMs.push(Number(end - start) / 1_000_000);
    }

    durationsMs.sort((a, b) => a - b);
    const p50 = durationsMs[Math.floor(SAMPLES * 0.5)];
    const p99 = durationsMs[Math.floor(SAMPLES * 0.99)];
    const max = durationsMs[SAMPLES - 1];
    // eslint-disable-next-line no-console -- a measured number, not a silent assertion; this is the report.
    console.log(
      `[IT-FEAT-003] feature-fetch latency over ${SAMPLES} samples: p50=${p50?.toFixed(3)}ms p99=${p99?.toFixed(3)}ms max=${max?.toFixed(3)}ms (MEASURED, co-located — see RISK-001)`,
    );

    expect(p99).toBeLessThan(8);
  });
});
