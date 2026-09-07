import { featureOrDefault, type FeatureVector } from './feature-vector';

describe('featureOrDefault', () => {
  // What: a present feature value is returned as-is.
  it('returns the stored value when the feature is present', () => {
    const vector: FeatureVector = {
      userId: 'user_1',
      computedAt: new Date(),
      source: 'live',
      features: { transaction_count_5m: 3 },
    };
    expect(featureOrDefault(vector, 'transaction_count_5m', 0)).toBe(3);
  });

  // What: a missing feature returns the caller-supplied default rather
  //       than throwing or returning undefined.
  // Why: this is the exact mechanism ADR-002 and ADR-005 depend on — when
  //      Redis is unavailable, a rule must still be able to evaluate using
  //      a safe default (FR-016), not crash on a missing key.
  // Catches: a rule written with `vector.features.x` directly, which
  //          `noUncheckedIndexedAccess` would flag but a careless `as`
  //          cast could bypass.
  it('returns the default when the feature is absent', () => {
    const vector: FeatureVector = {
      userId: 'user_1',
      computedAt: new Date(),
      source: 'unavailable',
      features: {},
    };
    expect(featureOrDefault(vector, 'transaction_count_5m', 0)).toBe(0);
    expect(featureOrDefault(vector, 'merchant_risk_score', 0.5)).toBe(0.5);
  });

  it('distinguishes a genuine zero from an absent feature', () => {
    const vector: FeatureVector = {
      userId: 'user_1',
      computedAt: new Date(),
      source: 'live',
      features: { failed_transactions_10m: 0 },
    };
    // A stored 0 must not be confused with "absent" and replaced by the default.
    expect(featureOrDefault(vector, 'failed_transactions_10m', 99)).toBe(0);
  });
});
