import type { RiskPolicy } from '../entities/risk-policy';
import type { Decision } from '../enums';
import type { RiskScore } from '../value-objects/risk-score';

/**
 * FR-006's decision engine — a pure function of (score, policy).
 * `degraded` selects ADR-005's cautious-open band; isValidRiskPolicy
 * guarantees that band is never more permissive than the healthy one, so
 * this function trusts the invariant rather than re-checking it per call.
 */
export function decide(score: RiskScore, policy: RiskPolicy, degraded: boolean): Decision {
  const { allowMax, blockMin } = degraded ? policy.degraded : policy;
  if (score.isBelow(allowMax)) {
    return 'ALLOW';
  }
  if (score.isAtLeast(blockMin)) {
    return 'BLOCK';
  }
  return 'REVIEW';
}
