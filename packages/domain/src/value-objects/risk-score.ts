import { InvariantViolationError } from '../errors';

/**
 * A risk score normalised to [0, 1] (FR-005). Wrapping the bare number in a
 * value object means "is this score valid" is checked exactly once, at
 * construction, rather than re-validated (or forgotten) at every call site
 * that consumes one.
 */
export class RiskScore {
  private constructor(public readonly value: number) {}

  static of(value: number): RiskScore {
    if (!Number.isFinite(value)) {
      throw new InvariantViolationError(
        'value',
        `RiskScore must be a finite number, got ${String(value)}`,
      );
    }
    if (value < 0 || value > 1) {
      throw new InvariantViolationError('value', `RiskScore must be within [0, 1], got ${value}`);
    }
    return new RiskScore(value);
  }

  static zero(): RiskScore {
    return new RiskScore(0);
  }

  /**
   * Weighted combination of component scores (FR-005). Weights are expected
   * to sum to 1.0 — SCORE_WEIGHT_* in .env.example — but this function does
   * not enforce that itself; policy-level validation of the weight set
   * belongs to the caller (the decision engine, in Phase 5), since a
   * value object should not know about configuration.
   */
  static combine(components: readonly { score: RiskScore; weight: number }[]): RiskScore {
    const combined = components.reduce((sum, c) => sum + c.score.value * c.weight, 0);
    // Clamp rather than throw: floating-point summation of values already
    // individually within [0,1] can overshoot by epsilon at the boundary,
    // and that is a rounding artefact, not an invariant violation.
    return RiskScore.of(Math.min(1, Math.max(0, combined)));
  }

  isAtLeast(threshold: number): boolean {
    return this.value >= threshold;
  }

  isBelow(threshold: number): boolean {
    return this.value < threshold;
  }

  toString(): string {
    return this.value.toFixed(4);
  }
}
