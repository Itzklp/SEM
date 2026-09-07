import { InvariantViolationError } from '../errors';

import { RiskScore } from './risk-score';

describe('RiskScore', () => {
  // What: boundary validation at 0 and 1.
  // Why: FR-005 requires the combined score to be normalised to [0,1] —
  //      a score outside that range would make policy thresholds meaningless.
  // Catches: a combiner bug that lets a weighted sum drift out of range.
  it('accepts values at the boundaries', () => {
    expect(RiskScore.of(0).value).toBe(0);
    expect(RiskScore.of(1).value).toBe(1);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects out-of-range value %p',
    (v) => {
      expect(() => RiskScore.of(v)).toThrow(InvariantViolationError);
    },
  );

  // What: determinism of combine() for a fixed input.
  // Why: FR-018 / NFR-015 depend on reproducibility — if score combination
  //      were not deterministic, no performance or detection result could
  //      ever be reproduced by a teammate.
  // Catches: any accidental non-determinism (e.g. iteration order dependence,
  //          use of Math.random) introduced into the combiner.
  it('combine() is deterministic for identical input', () => {
    const components = [
      { score: RiskScore.of(0.8), weight: 0.5 },
      { score: RiskScore.of(0.4), weight: 0.35 },
      { score: RiskScore.of(0.2), weight: 0.15 },
    ];
    const first = RiskScore.combine(components).value;
    const second = RiskScore.combine(components).value;
    expect(first).toBe(second);
    expect(first).toBeCloseTo(0.8 * 0.5 + 0.4 * 0.35 + 0.2 * 0.15);
  });

  it('combine() clamps floating-point overshoot at the boundary rather than throwing', () => {
    const components = [
      { score: RiskScore.of(1), weight: 0.6 },
      { score: RiskScore.of(1), weight: 0.4000000001 }, // sums fractionally over 1
    ];
    expect(() => RiskScore.combine(components)).not.toThrow();
    expect(RiskScore.combine(components).value).toBeLessThanOrEqual(1);
  });

  it('combine() of an empty list is zero', () => {
    expect(RiskScore.combine([]).value).toBe(0);
  });

  describe('threshold checks', () => {
    const score = RiskScore.of(0.75);

    it('isAtLeast is inclusive of the boundary', () => {
      expect(score.isAtLeast(0.75)).toBe(true);
      expect(score.isAtLeast(0.76)).toBe(false);
    });

    it('isBelow is exclusive of the boundary', () => {
      expect(score.isBelow(0.75)).toBe(false);
      expect(score.isBelow(0.76)).toBe(true);
    });
  });
});
