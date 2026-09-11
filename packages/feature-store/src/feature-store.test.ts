import {
  createTransaction,
  Money,
  RiskScore,
  type CreateTransactionInput,
  type FraudDecision,
  type Transaction,
} from '@fraudguard/domain';
import { createInMemoryRedis } from '@fraudguard/testkit';
import type { Redis } from 'ioredis';

import { FEATURE_DEFAULTS, MAX_USER_WINDOW_MS, MS } from './feature-definitions';
import { getFeatureVector } from './feature-reader';
import { recordTransactionFeatures } from './feature-writer';
import { userAmountKey } from './keys';
import { setIpRiskScore, setMerchantRiskScore } from './risk-lookup';

/**
 * Runs entirely against `ioredis-mock` (no Docker) — "deterministic
 * feature-computation tests" + "in-memory feature store for unit tests"
 * (docs/ROADMAP.md, Phase 4). The integration suite
 * (tests/integration/feature-store.integration.test.ts) re-proves the
 * load-bearing properties — windowing, idempotent replay, defaults under
 * a real Redis outage, the p99 budget — against real Redis, because a
 * mock cannot catch a wrong Redis command or a real network's latency.
 */

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0); // fixed instant — every test computes offsets from this, never `Date.now()`

let nextTxnId = 0;

function buildTransaction(overrides: Partial<CreateTransactionInput> = {}): Transaction {
  nextTxnId += 1;
  const input: CreateTransactionInput = {
    transactionId: `txn_${nextTxnId}`,
    userId: 'user_1',
    merchantId: 'merchant_1',
    deviceId: 'device_1',
    amount: Money.of(1000, 'USD'),
    ipAddress: '203.0.113.1',
    paymentMethod: 'card_token_1',
    timestamp: new Date(NOW),
    ...overrides,
  };
  return createTransaction(input);
}

function buildDecision(
  transaction: Transaction,
  overrides: Partial<FraudDecision> = {},
): FraudDecision {
  return {
    transactionId: transaction.transactionId,
    decision: 'ALLOW',
    riskScore: RiskScore.zero(),
    reasons: [],
    policyVersion: 'test-policy-v1',
    modelVersion: 'test-model-v1',
    scoringProvider: 'stub',
    degraded: false,
    degradedReason: 'NONE',
    decidedAt: transaction.timestamp,
    processingTimeMs: 1,
    ...overrides,
  };
}

describe('@fraudguard/feature-store: write + read round trip', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = createInMemoryRedis();
  });

  // Phase 4 exit criterion, verbatim: "After N seeded transactions, served
  // features reflect all N."
  it('reflects all N seeded transactions within their window', async () => {
    const timestamps = [0, 60_000, 120_000, 180_000, 240_000].map(
      (offset) => new Date(NOW + offset),
    ); // 4 minutes apart, all inside 5m
    for (const timestamp of timestamps) {
      const txn = buildTransaction({ timestamp });
      await recordTransactionFeatures(redis, txn, buildDecision(txn));
    }

    const vector = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'device_1',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW + 240_000),
    );

    expect(vector.source).toBe('live');
    expect(vector.features.transaction_count_5m).toBe(5);
    expect(vector.features.transaction_count_1h).toBe(5);
  });

  it('excludes transactions outside each feature-specific window (boundary correctness)', async () => {
    // Inside 5m, inside 1h, inside 24h.
    const recent = buildTransaction({ timestamp: new Date(NOW) });
    await recordTransactionFeatures(redis, recent, buildDecision(recent));
    // Outside 5m, inside 1h, inside 24h.
    const withinHour = buildTransaction({ timestamp: new Date(NOW - 10 * MS.MINUTE) });
    await recordTransactionFeatures(redis, withinHour, buildDecision(withinHour));
    // Outside 1h, inside 24h.
    const withinDay = buildTransaction({ timestamp: new Date(NOW - 2 * MS.HOUR) });
    await recordTransactionFeatures(redis, withinDay, buildDecision(withinDay));

    const vector = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'device_1',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW),
    );

    expect(vector.features.transaction_count_5m).toBe(1); // only `recent`
    expect(vector.features.transaction_count_1h).toBe(2); // `recent` + `withinHour`
    // average_amount_24h's window covers all three.
    expect(vector.features.average_amount_24h).toBeCloseTo(10, 5); // $10.00 each, same amount
  });

  it('sums and averages real amounts, across currencies-as-minor-units (no floating point)', async () => {
    const a = buildTransaction({ timestamp: new Date(NOW), amount: Money.of(1_500, 'USD') });
    const b = buildTransaction({ timestamp: new Date(NOW + 1000), amount: Money.of(2_500, 'USD') });
    await recordTransactionFeatures(redis, a, buildDecision(a));
    await recordTransactionFeatures(redis, b, buildDecision(b));

    const vector = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'device_1',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW + 1000),
    );

    expect(vector.features.amount_sum_1h).toBeCloseTo(40, 5); // (1500+2500)/100
    expect(vector.features.average_amount_24h).toBeCloseTo(20, 5);
  });

  it('counts distinct merchants and distinct IPs (the "location" proxy), not raw transaction count', async () => {
    const txns = [
      buildTransaction({
        merchantId: 'merchant_A',
        ipAddress: '10.0.0.1',
        timestamp: new Date(NOW),
      }),
      buildTransaction({
        merchantId: 'merchant_A',
        ipAddress: '10.0.0.1',
        timestamp: new Date(NOW + 1000),
      }), // repeat — must not inflate distinct count
      buildTransaction({
        merchantId: 'merchant_B',
        ipAddress: '10.0.0.2',
        timestamp: new Date(NOW + 2000),
      }),
    ];
    for (const txn of txns) {
      await recordTransactionFeatures(redis, txn, buildDecision(txn));
    }

    const vector = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'device_1',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW + 2000),
    );

    expect(vector.features.distinct_merchants_1h).toBe(2);
    expect(vector.features.distinct_locations_24h).toBe(2);
  });

  // ASSUMED (documented in feature-writer.ts): "failed" = this system's own BLOCK decision.
  it('counts only BLOCKed transactions toward failed_transactions_10m', async () => {
    const blocked = buildTransaction({ timestamp: new Date(NOW) });
    await recordTransactionFeatures(redis, blocked, buildDecision(blocked, { decision: 'BLOCK' }));
    const allowed = buildTransaction({ timestamp: new Date(NOW + 1000) });
    await recordTransactionFeatures(redis, allowed, buildDecision(allowed, { decision: 'ALLOW' }));
    const reviewed = buildTransaction({ timestamp: new Date(NOW + 2000) });
    await recordTransactionFeatures(
      redis,
      reviewed,
      buildDecision(reviewed, { decision: 'REVIEW' }),
    );

    const vector = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'device_1',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW + 2000),
    );

    expect(vector.features.failed_transactions_10m).toBe(1);
  });

  it('counts device activity across different users sharing the same device', async () => {
    const first = buildTransaction({
      userId: 'user_1',
      deviceId: 'shared_device',
      timestamp: new Date(NOW),
    });
    const second = buildTransaction({
      userId: 'user_2',
      deviceId: 'shared_device',
      timestamp: new Date(NOW + 1000),
    });
    await recordTransactionFeatures(redis, first, buildDecision(first));
    await recordTransactionFeatures(redis, second, buildDecision(second));

    const vector = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'shared_device',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW + 1000),
    );

    expect(vector.features.device_transaction_count).toBe(2);
  });

  it("sets a user's account_age_days from the first transaction ever seen, and grows it over time", async () => {
    const first = buildTransaction({ userId: 'brand_new_user', timestamp: new Date(NOW) });
    await recordTransactionFeatures(redis, first, buildDecision(first));

    const immediately = await getFeatureVector(
      redis,
      {
        userId: 'brand_new_user',
        deviceId: 'device_1',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW),
    );
    expect(immediately.features.account_age_days).toBeCloseTo(0, 5);

    const tenDaysLater = await getFeatureVector(
      redis,
      {
        userId: 'brand_new_user',
        deviceId: 'device_1',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW + 10 * MS.DAY),
    );
    expect(tenDaysLater.features.account_age_days).toBeCloseTo(10, 5);
  });

  it('replaying the identical event twice does not double-count it (idempotent aggregation)', async () => {
    const txn = buildTransaction({ timestamp: new Date(NOW) });
    const decision = buildDecision(txn);
    await recordTransactionFeatures(redis, txn, decision);
    await recordTransactionFeatures(redis, txn, decision); // duplicate delivery

    const vector = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'device_1',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW),
    );

    expect(vector.features.transaction_count_5m).toBe(1);
    expect(vector.features.amount_sum_1h).toBeCloseTo(10, 5);
  });

  // FR-002's acceptance criterion: "Feature computation is deterministic
  // for a given event sequence." This is the rebuild-from-replay exit
  // criterion (docs/ROADMAP.md Phase 4) — no Kafka/event-worker exists
  // yet (that is Phase 6's job), so "replay" here means what it will mean
  // once Phase 6 wires a real consumer onto this same function: re-apply
  // the durable, ordered event sequence (Postgres is the durable record —
  // ADR-006) and arrive at the same state.
  it('rebuild-from-replay reproduces the same feature state as the original live run', async () => {
    const events = [0, 30_000, 90_000, 300_000, 3_700_000].map((offset, i) => {
      const txn = buildTransaction({
        userId: 'replay_user',
        merchantId: i % 2 === 0 ? 'merchant_A' : 'merchant_B',
        amount: Money.of(1_000 * (i + 1), 'USD'),
        timestamp: new Date(NOW + offset),
      });
      return {
        transaction: txn,
        decision: buildDecision(txn, { decision: i === 2 ? 'BLOCK' : 'ALLOW' }),
      };
    });
    const asOf = new Date(NOW + 3_700_000);
    const lookup = {
      userId: 'replay_user',
      deviceId: 'device_1',
      merchantId: 'merchant_1',
      ipAddress: '203.0.113.1',
    };

    for (const { transaction, decision } of events) {
      await recordTransactionFeatures(redis, transaction, decision);
    }
    const live = await getFeatureVector(redis, lookup, asOf);

    const fresh = createInMemoryRedis();
    for (const { transaction, decision } of events) {
      await recordTransactionFeatures(fresh, transaction, decision);
    }
    const replayed = await getFeatureVector(fresh, lookup, asOf);

    expect(replayed.features).toEqual(live.features);
  });

  it('trims event-log entries (and their parallel hash fields) older than the longest window', async () => {
    const stale = buildTransaction({ timestamp: new Date(NOW - MAX_USER_WINDOW_MS - MS.HOUR) });
    await recordTransactionFeatures(redis, stale, buildDecision(stale));
    // A later write is what triggers the trim (feature-writer.ts trims on every write).
    const recent = buildTransaction({ timestamp: new Date(NOW) });
    await recordTransactionFeatures(redis, recent, buildDecision(recent));

    const amountField = await redis.hget(userAmountKey('user_1'), stale.transactionId);
    expect(amountField).toBeNull(); // the hash field was actually deleted, not just excluded by the read window

    const vector = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'device_1',
        merchantId: 'merchant_1',
        ipAddress: '203.0.113.1',
      },
      new Date(NOW),
    );
    expect(vector.features.average_amount_24h).toBeCloseTo(10, 5); // only `recent`, not `stale`
  });
});

describe('@fraudguard/feature-store: defaults on miss (ADR-002, FR-016)', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = createInMemoryRedis();
  });

  it('returns every declared default for a user/device/merchant/IP Redis has never seen', async () => {
    const vector = await getFeatureVector(
      redis,
      {
        userId: 'never_seen',
        deviceId: 'never_seen',
        merchantId: 'never_seen',
        ipAddress: '0.0.0.0',
      },
      new Date(NOW),
    );

    expect(vector.source).toBe('live'); // Redis answered — it simply has no data
    expect(vector.features).toEqual(FEATURE_DEFAULTS);
  });
});

describe('@fraudguard/feature-store: risk lookups (read mechanism is Phase 4; seeding real data is Phase 5)', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = createInMemoryRedis();
  });

  it('reads back a seeded merchant/IP risk score, and defaults an unseeded one', async () => {
    await setMerchantRiskScore(redis, 'risky_merchant', 0.87);
    await setIpRiskScore(redis, '198.51.100.7', 0.42);

    const seeded = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'device_1',
        merchantId: 'risky_merchant',
        ipAddress: '198.51.100.7',
      },
      new Date(NOW),
    );
    expect(seeded.features.merchant_risk_score).toBeCloseTo(0.87, 5);
    expect(seeded.features.ip_risk_score).toBeCloseTo(0.42, 5);

    const unseeded = await getFeatureVector(
      redis,
      {
        userId: 'user_1',
        deviceId: 'device_1',
        merchantId: 'unknown_merchant',
        ipAddress: '203.0.113.99',
      },
      new Date(NOW),
    );
    expect(unseeded.features.merchant_risk_score).toBe(FEATURE_DEFAULTS.merchant_risk_score);
    expect(unseeded.features.ip_risk_score).toBe(FEATURE_DEFAULTS.ip_risk_score);
  });
});
