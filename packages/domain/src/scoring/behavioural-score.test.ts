import type { FeatureVector } from '../entities/feature-vector';

import { computeBehaviouralScore } from './behavioural-score';

function vector(features: Partial<FeatureVector['features']> = {}): FeatureVector {
  return { userId: 'user_1', computedAt: new Date(), source: 'live', features };
}

describe('computeBehaviouralScore', () => {
  it('returns zero for an entirely quiet feature vector', () => {
    expect(computeBehaviouralScore(vector({}))).toBe(0);
  });

  it('rises as recent activity features rise', () => {
    const quiet = computeBehaviouralScore(vector({ transaction_count_1h: 1 }));
    const busy = computeBehaviouralScore(vector({ transaction_count_1h: 10 }));
    expect(busy).toBeGreaterThan(quiet);
  });

  it('clamps each normalised component at 1, however far over the norm it goes', () => {
    const atNorm = computeBehaviouralScore(vector({ transaction_count_1h: 10 }));
    const farOver = computeBehaviouralScore(vector({ transaction_count_1h: 1_000 }));
    expect(farOver).toBeCloseTo(atNorm, 5);
  });

  it('stays within [0, 1] even with every feature maxed out', () => {
    const score = computeBehaviouralScore(
      vector({
        transaction_count_1h: 1_000,
        amount_sum_1h: 1_000_000,
        distinct_merchants_1h: 1_000,
      }),
    );
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic for identical input', () => {
    const v = vector({ transaction_count_1h: 4, amount_sum_1h: 250 });
    expect(computeBehaviouralScore(v)).toBe(computeBehaviouralScore(v));
  });
});
