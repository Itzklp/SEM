import type { FeatureVector } from '../entities/feature-vector';
import { createTransaction, type CreateTransactionInput } from '../entities/transaction';
import { Money } from '../value-objects/money';

import { StubFraudScoringProvider } from './stub-scoring-provider';

function buildInput(amountMinorUnits: number): {
  transaction: CreateTransactionInput;
  features: FeatureVector;
} {
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
  return {
    transaction,
    features: { userId: 'user_1', computedAt: new Date(), source: 'live', features: {} },
  };
}

// UT-SCORE-001..008.
describe('StubFraudScoringProvider', () => {
  const provider = new StubFraudScoringProvider();

  it('identifies itself as "stub"', () => {
    expect(provider.name).toBe('stub');
  });

  it('stays within [0, 1] for a small amount', async () => {
    const result = await provider.score(buildInput(1_000));
    expect(result.score.value).toBeGreaterThanOrEqual(0);
    expect(result.score.value).toBeLessThanOrEqual(1);
  });

  it('caps at 1 for an amount at or beyond the scale, never throwing or exceeding bounds', async () => {
    const result = await provider.score(buildInput(10_000_000)); // $100,000
    expect(result.score.value).toBe(1);
  });

  it('scores higher for a larger amount', async () => {
    const small = await provider.score(buildInput(1_000));
    const large = await provider.score(buildInput(100_000));
    expect(large.score.value).toBeGreaterThan(small.score.value);
  });

  it('is deterministic for identical input', async () => {
    const a = await provider.score(buildInput(5_000));
    const b = await provider.score(buildInput(5_000));
    expect(a.score.value).toBe(b.score.value);
  });

  it('ignores the feature vector entirely — still scores when features are unavailable', async () => {
    const input = buildInput(5_000);
    const degraded = {
      ...input,
      features: { ...input.features, source: 'unavailable' as const, features: {} },
    };
    const result = await provider.score(degraded);
    expect(result.score.value).toBeGreaterThan(0);
  });

  it('records its own model version', async () => {
    const result = await provider.score(buildInput(1_000));
    expect(result.modelVersion).toBe('model-v1-stub');
  });

  it('omits a reason for a small amount — nonzero is not the same as "contributing"', async () => {
    const result = await provider.score(buildInput(1_000)); // $10 — value 0.005
    expect(result.riskFactors).toEqual([]);
  });

  it('includes a reason once the amount is a material contributor', async () => {
    const result = await provider.score(buildInput(150_000)); // $1,500 — value 0.75
    expect(result.riskFactors.length).toBeGreaterThan(0);
    expect(result.riskFactors[0]?.reason).toBeTruthy();
  });
});
