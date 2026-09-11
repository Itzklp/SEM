import type { RiskPolicy } from '../entities/risk-policy';
import { RiskScore } from '../value-objects/risk-score';

import { decide } from './decision-engine';

const POLICY: RiskPolicy = {
  policyVersion: 'test-policy-v1',
  allowMax: 0.4,
  blockMin: 0.75,
  degraded: { allowMax: 0.25, blockMin: 0.85 },
};

// UT-DEC-001..015.
describe('decide', () => {
  it('classifies a low score as ALLOW', () => {
    expect(decide(RiskScore.of(0.1), POLICY, false)).toBe('ALLOW');
  });

  it('classifies a mid-range score as REVIEW', () => {
    expect(decide(RiskScore.of(0.5), POLICY, false)).toBe('REVIEW');
  });

  it('classifies a high score as BLOCK', () => {
    expect(decide(RiskScore.of(0.9), POLICY, false)).toBe('BLOCK');
  });

  it('treats allowMax as exclusive (score === allowMax is not ALLOW)', () => {
    expect(decide(RiskScore.of(0.4), POLICY, false)).toBe('REVIEW');
  });

  it('treats blockMin as inclusive (score === blockMin is BLOCK)', () => {
    expect(decide(RiskScore.of(0.75), POLICY, false)).toBe('BLOCK');
  });

  it('applies the stricter degraded band when degraded=true', () => {
    // 0.3 is ALLOW under the healthy band (< 0.4) but REVIEW under the
    // degraded band (>= 0.25) — this is ADR-005's cautious-open in
    // practice: the exact same score lands differently depending on
    // whether the system had full signal.
    expect(decide(RiskScore.of(0.3), POLICY, false)).toBe('ALLOW');
    expect(decide(RiskScore.of(0.3), POLICY, true)).toBe('REVIEW');
  });

  it('never ALLOWs under degraded a score that would not have been ALLOW when healthy', () => {
    // The actual cautious-open guarantee (ADR-005, isValidRiskPolicy):
    // degraded.allowMax <= allowMax. It is NOT "degraded is always at
    // least as severe as healthy" in a blanket sense — see the next test.
    for (const raw of [0, 0.2, 0.25, 0.3, 0.4, 0.6, 0.8, 1]) {
      const score = RiskScore.of(raw);
      if (decide(score, POLICY, true) === 'ALLOW') {
        expect(decide(score, POLICY, false)).toBe('ALLOW');
      }
    }
  });

  it('can relax a healthy BLOCK to a degraded REVIEW — deliberately, not a bug', () => {
    // 0.8 is BLOCK when healthy (>= 0.75) but only REVIEW when degraded
    // (< 0.85's degraded blockMin). This is intentional: a low-confidence
    // (degraded) signal should route an ambiguous-looking score to a
    // human reviewer rather than auto-BLOCK on weaker evidence — ADR-005's
    // "cautious-open" pulls BOTH extremes toward REVIEW, it does not
    // monotonically escalate severity.
    expect(decide(RiskScore.of(0.8), POLICY, false)).toBe('BLOCK');
    expect(decide(RiskScore.of(0.8), POLICY, true)).toBe('REVIEW');
  });

  it('is deterministic for identical input', () => {
    const score = RiskScore.of(0.55);
    expect(decide(score, POLICY, false)).toBe(decide(score, POLICY, false));
  });

  it('classifies the boundary at zero as ALLOW', () => {
    expect(decide(RiskScore.zero(), POLICY, false)).toBe('ALLOW');
  });

  it('classifies the boundary at one as BLOCK', () => {
    expect(decide(RiskScore.of(1), POLICY, false)).toBe('BLOCK');
  });
});
