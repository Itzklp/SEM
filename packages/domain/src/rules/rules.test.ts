import type { FeatureVector } from '../entities/feature-vector';
import {
  createTransaction,
  type Transaction,
  type CreateTransactionInput,
} from '../entities/transaction';
import { Money } from '../value-objects/money';

import { AmountDeviationRule } from './amount-deviation-rule';
import { DeviceRiskRule } from './device-risk-rule';
import { FailedAttemptRule } from './failed-attempt-rule';
import type { RuleInput } from './fraud-rule';
import { GeographicAnomalyRule } from './geographic-anomaly-rule';
import { MerchantRiskRule } from './merchant-risk-rule';
import { VelocityRule } from './velocity-rule';

function buildTransaction(overrides: Partial<CreateTransactionInput> = {}): Transaction {
  return createTransaction({
    transactionId: 'txn_1',
    userId: 'user_1',
    merchantId: 'merchant_1',
    deviceId: 'device_1',
    amount: Money.of(1_000, 'USD'), // $10.00
    ipAddress: '203.0.113.1',
    paymentMethod: 'card_token_1',
    timestamp: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  });
}

function buildVector(features: Partial<FeatureVector['features']> = {}): FeatureVector {
  return { userId: 'user_1', computedAt: new Date(), source: 'live', features };
}

function input(
  features: Partial<FeatureVector['features']> = {},
  overrides: Partial<CreateTransactionInput> = {},
): RuleInput {
  return { transaction: buildTransaction(overrides), features: buildVector(features) };
}

// UT-RULE-001..005. VelocityRule.
describe('VelocityRule', () => {
  const rule = new VelocityRule({ max5m: 10, max1h: 20 });

  it('does not trigger below both thresholds', () => {
    const result = rule.evaluate(input({ transaction_count_5m: 5, transaction_count_1h: 10 }));
    expect(result.triggered).toBe(false);
    expect(result.scoreContribution).toBe(0);
    expect(result.reason).toBe('');
  });

  it('triggers on the 5-minute threshold alone', () => {
    const result = rule.evaluate(input({ transaction_count_5m: 10, transaction_count_1h: 0 }));
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain('velocity');
  });

  it('triggers on the 1-hour threshold alone', () => {
    const result = rule.evaluate(input({ transaction_count_5m: 0, transaction_count_1h: 20 }));
    expect(result.triggered).toBe(true);
  });

  it('scales severity and contribution with how far past threshold', () => {
    const atThreshold = rule.evaluate(input({ transaction_count_5m: 10, transaction_count_1h: 0 }));
    const double = rule.evaluate(input({ transaction_count_5m: 20, transaction_count_1h: 0 }));
    expect(double.scoreContribution).toBeGreaterThan(atThreshold.scoreContribution);
    expect(double.severity).toBe('CRITICAL');
  });

  it('treats a missing feature as its declared default (0), never throwing', () => {
    expect(() => rule.evaluate(input({}))).not.toThrow();
    expect(rule.evaluate(input({})).triggered).toBe(false);
  });
});

// UT-RULE-006..010. AmountDeviationRule.
describe('AmountDeviationRule', () => {
  const rule = new AmountDeviationRule({ multiplier: 5 });

  it('does not trigger with no spending history (average = 0, the declared default)', () => {
    const result = rule.evaluate(
      input({ average_amount_24h: 0 }, { amount: Money.of(100_000, 'USD') }),
    );
    expect(result.triggered).toBe(false);
  });

  it('does not trigger below the multiplier', () => {
    // $10 is only 2x a $5 average; threshold is 5x.
    const result = rule.evaluate(
      input({ average_amount_24h: 5 }, { amount: Money.of(1_000, 'USD') }),
    );
    expect(result.triggered).toBe(false);
  });

  it('triggers at exactly the multiplier', () => {
    // $50 is exactly 5x a $10 average.
    const result = rule.evaluate(
      input({ average_amount_24h: 10 }, { amount: Money.of(5_000, 'USD') }),
    );
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain('average');
  });

  it('triggers more severely the further the deviation', () => {
    const atThreshold = rule.evaluate(
      input({ average_amount_24h: 10 }, { amount: Money.of(5_000, 'USD') }),
    );
    const farBeyond = rule.evaluate(
      input({ average_amount_24h: 10 }, { amount: Money.of(20_000, 'USD') }),
    );
    expect(farBeyond.scoreContribution).toBeGreaterThan(atThreshold.scoreContribution);
  });

  it('is deterministic for identical input', () => {
    const a = rule.evaluate(input({ average_amount_24h: 10 }, { amount: Money.of(5_000, 'USD') }));
    const b = rule.evaluate(input({ average_amount_24h: 10 }, { amount: Money.of(5_000, 'USD') }));
    expect(a).toEqual(b);
  });
});

// UT-RULE-011..015. DeviceRiskRule.
describe('DeviceRiskRule', () => {
  const rule = new DeviceRiskRule({ maxDeviceTransactions: 50 });

  it('does not trigger below the threshold', () => {
    expect(rule.evaluate(input({ device_transaction_count: 49 })).triggered).toBe(false);
  });

  it('triggers at the threshold', () => {
    const result = rule.evaluate(input({ device_transaction_count: 50 }));
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain('device');
  });

  it('uses the declared default (0) when the feature is absent, never throwing', () => {
    expect(() => rule.evaluate(input({}))).not.toThrow();
  });

  it('reports the observed count in its reason', () => {
    const result = rule.evaluate(input({ device_transaction_count: 75 }));
    expect(result.reason).toContain('75');
  });
});

// UT-RULE-016..020. GeographicAnomalyRule.
describe('GeographicAnomalyRule', () => {
  const rule = new GeographicAnomalyRule({ maxDistinctLocations24h: 4 });

  it('does not trigger below the threshold', () => {
    expect(rule.evaluate(input({ distinct_locations_24h: 3 })).triggered).toBe(false);
  });

  it('triggers at the threshold', () => {
    const result = rule.evaluate(input({ distinct_locations_24h: 4 }));
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain('locations');
  });

  it('scales severity with how far past the threshold', () => {
    const result = rule.evaluate(input({ distinct_locations_24h: 8 }));
    expect(result.severity).toBe('CRITICAL');
  });
});

// UT-RULE-021..025. FailedAttemptRule.
describe('FailedAttemptRule', () => {
  const rule = new FailedAttemptRule({ maxFailed10m: 3 });

  it('does not trigger below the threshold', () => {
    expect(rule.evaluate(input({ failed_transactions_10m: 2 })).triggered).toBe(false);
  });

  it('triggers at the threshold', () => {
    const result = rule.evaluate(input({ failed_transactions_10m: 3 }));
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain('blocked');
  });
});

// UT-RULE-026..030. MerchantRiskRule.
describe('MerchantRiskRule', () => {
  const rule = new MerchantRiskRule({ riskThreshold: 0.7 });

  it('does not trigger below the threshold', () => {
    expect(rule.evaluate(input({ merchant_risk_score: 0.69 })).triggered).toBe(false);
  });

  it('triggers at the threshold', () => {
    const result = rule.evaluate(input({ merchant_risk_score: 0.7 }));
    expect(result.triggered).toBe(true);
  });

  it('uses the declared default (0, neutral) when unseeded, never throwing', () => {
    expect(rule.evaluate(input({})).triggered).toBe(false);
  });

  it('escalates severity with the risk score itself, not a computed ratio', () => {
    expect(rule.evaluate(input({ merchant_risk_score: 0.75 })).severity).toBe('MEDIUM');
    expect(rule.evaluate(input({ merchant_risk_score: 0.85 })).severity).toBe('HIGH');
    expect(rule.evaluate(input({ merchant_risk_score: 0.95 })).severity).toBe('CRITICAL');
  });

  it('never leaks the threshold itself into the reason (client-safe, FR-007)', () => {
    const result = rule.evaluate(input({ merchant_risk_score: 0.9 }));
    expect(result.reason).not.toContain('0.7');
    expect(result.reason).not.toContain('0.9');
  });
});
