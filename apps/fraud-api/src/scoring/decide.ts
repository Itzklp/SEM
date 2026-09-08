import type { AppConfig } from '@fraudguard/config';
import type { Decision, RiskScore } from '@fraudguard/domain';

/**
 * PLACEHOLDER threshold comparator — Phase 3 scope. Phase 5's "Decision
 * engine" deliverable (docs/ROADMAP.md) is substantially more than this:
 * rule evaluation, score combination across rules/model/behavioural
 * signals, explainability (reasons), and the runtime-configurable
 * `RiskPolicy` record (not just env-var thresholds). What's here is only
 * the mechanical piece needed to prove a decision can flow end to end —
 * three comparisons. It is deliberately NOT written as a permanent
 * `packages/domain` module so Phase 5's real decision engine has no
 * placeholder code to migrate away from.
 *
 * `degraded` selects the ADR-005 cautious-open band — the same policy
 * config the real decision engine will read from `RiskPolicy`.
 */
export function decide(score: RiskScore, policy: AppConfig['policy'], degraded: boolean): Decision {
  const { allowMax, blockMin } = degraded ? policy.degraded : policy;
  if (score.isBelow(allowMax)) {
    return 'ALLOW';
  }
  if (score.isAtLeast(blockMin)) {
    return 'BLOCK';
  }
  return 'REVIEW';
}
