import type { FeatureVector } from '../entities/feature-vector';
import { createTransaction, type CreateTransactionInput } from '../entities/transaction';
import type { FraudRule } from '../rules/fraud-rule';
import { VelocityRule } from '../rules/velocity-rule';
import { Money } from '../value-objects/money';

import { RuleBasedScoringProvider } from './rule-based-scoring-provider';

const WEIGHTS = { rules: 0.5, model: 0.35, behavioural: 0.15 };

function buildInput(
  features: Partial<FeatureVector['features']> = {},
  amountMinorUnits = 1_000,
  source: FeatureVector['source'] = 'live',
) {
  const transaction = createTransaction({
    transactionId: 'txn_1',
    userId: 'user_1',
    merchantId: 'merchant_1',
    deviceId: 'device_1',
    amount: Money.of(amountMinorUnits, 'USD'),
    ipAddress: '203.0.113.1',
    paymentMethod: 'card_token_1',
    timestamp: new Date('2026-06-01T00:00:00Z'),
  } satisfies CreateTransactionInput);
  return { transaction, features: { userId: 'user_1', computedAt: new Date(), source, features } };
}

describe('RuleBasedScoringProvider', () => {
  const rules: FraudRule[] = [new VelocityRule({ max5m: 10, max1h: 20 })];
  const provider = new RuleBasedScoringProvider(rules, WEIGHTS);

  it('identifies itself as "rules"', () => {
    expect(provider.name).toBe('rules');
  });

  it('scores near zero for a quiet transaction with no history', async () => {
    const result = await provider.score(buildInput({}, 0));
    expect(result.score.value).toBeLessThan(0.1);
  });

  it('produces a materially higher score when a rule triggers', async () => {
    const quiet = await provider.score(buildInput({ transaction_count_5m: 1 }));
    const triggered = await provider.score(buildInput({ transaction_count_5m: 15 }));
    expect(triggered.score.value).toBeGreaterThan(quiet.score.value);
  });

  it("includes the triggered rule's reason in its output", async () => {
    const result = await provider.score(buildInput({ transaction_count_5m: 15 }));
    expect(result.riskFactors.some((f) => f.reason.includes('velocity'))).toBe(true);
  });

  it('still produces a score when features are unavailable (ADR-005) — rules see defaults, never throw', async () => {
    await expect(provider.score(buildInput({}, 1_000, 'unavailable'))).resolves.toBeDefined();
  });

  it('is deterministic for identical input', async () => {
    const a = await provider.score(buildInput({ transaction_count_5m: 12 }, 2_000));
    const b = await provider.score(buildInput({ transaction_count_5m: 12 }, 2_000));
    expect(a.score.value).toBe(b.score.value);
  });

  it('records its own model version, distinct from the stub it delegates to internally', async () => {
    const result = await provider.score(buildInput({}));
    expect(result.modelVersion).toBe('model-v1-rules');
  });

  it('adding a rule to the constructor array changes behaviour with no change to this provider (FR-003)', async () => {
    const withoutExtra = new RuleBasedScoringProvider(
      [new VelocityRule({ max5m: 10, max1h: 20 })],
      WEIGHTS,
    );
    const extraRule: FraudRule = {
      name: 'always-fires-for-this-test',
      evaluate: () => ({
        ruleName: 'always-fires-for-this-test',
        triggered: true,
        severity: 'CRITICAL',
        reason: 'invented for this test',
        scoreContribution: 1,
      }),
    };
    const withExtra = new RuleBasedScoringProvider(
      [new VelocityRule({ max5m: 10, max1h: 20 }), extraRule],
      WEIGHTS,
    );

    const a = await withoutExtra.score(buildInput({}));
    const b = await withExtra.score(buildInput({}));
    expect(b.score.value).toBeGreaterThan(a.score.value);
  });
});
