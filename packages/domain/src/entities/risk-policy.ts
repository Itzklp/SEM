/**
 * FR-006, ADR-005. The configurable policy mapping a combined risk score to
 * a decision. This is intentionally a plain data shape, not a class with
 * behaviour — the behaviour (applying a policy to a score) lives in the
 * decision engine (Phase 5), which is a pure function of
 * (score, policy) -> Decision. Keeping the policy as data is what makes it
 * safely reloadable at runtime (FR-006 acceptance criteria).
 */
export interface RiskPolicy {
  readonly policyVersion: string;
  /** score < allowMax -> ALLOW */
  readonly allowMax: number;
  /** score >= blockMin -> BLOCK. Between allowMax and blockMin -> REVIEW. */
  readonly blockMin: number;
  /**
   * ADR-005 cautious-open thresholds, applied instead of the pair above
   * when a decision is degraded. Always stricter (lower allowMax, higher
   * blockMin) than the healthy thresholds — ambiguity shifts to REVIEW,
   * never silently to ALLOW.
   */
  readonly degraded: {
    readonly allowMax: number;
    readonly blockMin: number;
  };
}

export function isValidRiskPolicy(policy: RiskPolicy): boolean {
  const healthyOrdered = policy.allowMax < policy.blockMin;
  const degradedOrdered = policy.degraded.allowMax < policy.degraded.blockMin;
  const degradedIsStricter =
    policy.degraded.allowMax <= policy.allowMax && policy.degraded.blockMin >= policy.blockMin;
  const inRange = [
    policy.allowMax,
    policy.blockMin,
    policy.degraded.allowMax,
    policy.degraded.blockMin,
  ].every((v) => v >= 0 && v <= 1);
  return healthyOrdered && degradedOrdered && degradedIsStricter && inRange;
}
