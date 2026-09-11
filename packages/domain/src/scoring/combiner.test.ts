import { RiskScore } from '../value-objects/risk-score';

import { combineScores } from './combiner';

// UT-COMB-001..010.
describe('combineScores', () => {
  it('weights each component according to its configured weight', () => {
    const result = combineScores(
      { rules: RiskScore.of(1), model: RiskScore.zero(), behavioural: RiskScore.zero() },
      { rules: 0.5, model: 0.35, behavioural: 0.15 },
    );
    expect(result.value).toBeCloseTo(0.5, 5);
  });

  it('returns zero when every component is zero', () => {
    const result = combineScores(
      { rules: RiskScore.zero(), model: RiskScore.zero(), behavioural: RiskScore.zero() },
      { rules: 0.5, model: 0.35, behavioural: 0.15 },
    );
    expect(result.value).toBe(0);
  });

  it('returns one when every component is one and weights sum to one', () => {
    const result = combineScores(
      { rules: RiskScore.of(1), model: RiskScore.of(1), behavioural: RiskScore.of(1) },
      { rules: 0.5, model: 0.35, behavioural: 0.15 },
    );
    expect(result.value).toBeCloseTo(1, 5);
  });

  it('stays within [0, 1] bounds regardless of component mix', () => {
    const result = combineScores(
      { rules: RiskScore.of(0.3), model: RiskScore.of(0.9), behavioural: RiskScore.of(0.1) },
      { rules: 0.5, model: 0.35, behavioural: 0.15 },
    );
    expect(result.value).toBeGreaterThanOrEqual(0);
    expect(result.value).toBeLessThanOrEqual(1);
  });

  it('is deterministic for identical input', () => {
    const components = {
      rules: RiskScore.of(0.4),
      model: RiskScore.of(0.6),
      behavioural: RiskScore.of(0.2),
    };
    const weights = { rules: 0.5, model: 0.35, behavioural: 0.15 };
    expect(combineScores(components, weights).value).toBe(combineScores(components, weights).value);
  });
});
