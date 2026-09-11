import type { RiskPolicy } from '../entities/risk-policy';
import type { Decision } from '../enums';
import type { RiskScore } from '../value-objects/risk-score';

/**
 * FR-006's real decision engine — a pure function of `(score, policy)`,
 * exactly as `risk-policy.ts`'s doc comment promises: "the behaviour...
 * lives in the decision engine (Phase 5), which is a pure function of
 * (score, policy) -> Decision." Supersedes `apps/fraud-api/src/scoring
 * /decide.ts`, the Phase 3 placeholder that operated on the raw
 * `AppConfig['policy']` shape rather than the real `RiskPolicy` entity —
 * deleted now that this exists, per that file's own doc comment
 * ("Phase 5's real decision engine has no placeholder code to migrate
 * away from").
 *
 * `degraded` selects ADR-005's cautious-open band (`policy.degraded`),
 * which `isValidRiskPolicy` guarantees is never more permissive than the
 * healthy band — this function trusts that invariant rather than
 * re-checking it on every call (the caller validates the policy once, at
 * config load).
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
