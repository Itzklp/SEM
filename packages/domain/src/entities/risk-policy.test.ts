import { isValidRiskPolicy, type RiskPolicy } from './risk-policy';

function basePolicy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    policyVersion: 'policy-v1',
    allowMax: 0.4,
    blockMin: 0.75,
    degraded: { allowMax: 0.25, blockMin: 0.85 },
    ...overrides,
  };
}

describe('isValidRiskPolicy', () => {
  // What: the default prototype policy (.env.example values) is itself valid.
  // Why: this is the policy the whole system boots with — if it failed its
  //      own validation, nothing would ever score.
  it('accepts the baseline policy configuration', () => {
    expect(isValidRiskPolicy(basePolicy())).toBe(true);
  });

  it('rejects a policy where allowMax >= blockMin (no REVIEW band)', () => {
    expect(isValidRiskPolicy(basePolicy({ allowMax: 0.8, blockMin: 0.75 }))).toBe(false);
  });

  // What: the degraded thresholds must be at least as strict as the healthy ones.
  // Why: ADR-005 cautious-open requires degraded mode to WIDEN the REVIEW
  //      band, never narrow it — a misconfigured policy that loosened
  //      thresholds under degradation would be a security regression
  //      exactly when the system is least able to catch it.
  // Catches: an operator typo that sets a looser degraded policy than the
  //          healthy one, silently making outages MORE permissive.
  it('rejects degraded thresholds that are looser than healthy thresholds', () => {
    const looser = basePolicy({ degraded: { allowMax: 0.5, blockMin: 0.6 } });
    expect(isValidRiskPolicy(looser)).toBe(false);
  });

  it('rejects a threshold outside [0, 1]', () => {
    expect(isValidRiskPolicy(basePolicy({ blockMin: 1.5 }))).toBe(false);
  });
});
