import type { FeatureVector } from '../entities/feature-vector';
import type { RiskFactor } from '../entities/fraud-decision';
import type { Transaction } from '../entities/transaction';
import type { ScoringProviderName } from '../enums';
import type { RiskScore } from '../value-objects/risk-score';

/**
 * ============================================================================
 * THE load-bearing abstraction of this project (CON-005, Brief §2, ADR-004).
 * ============================================================================
 *
 * Every consumer of a fraud score — the decision engine, the combiner, the
 * API layer — depends on this interface and nothing else. `Stub`, `Rules`
 * and (from Phase 10) `MLScoringProvider` are three interchangeable
 * implementations of it.
 *
 * This is what makes the following true, and testable:
 *   - The entire system (Phases 3-9) is built and load-tested with ZERO ML
 *     code in existence, using `StubFraudScoringProvider`.
 *   - Introducing ML in Phase 10 is a *configuration change*
 *     (`SCORING_PROVIDER=ml` in .env), not a refactor of the decision path.
 *   - A ML-vs-baseline comparison (Phase 10 exit criterion) is a controlled
 *     experiment, because both run through this identical interface and the
 *     identical decision engine downstream of it.
 *
 * DO NOT add a method here that only one implementation can satisfy — that
 * would leak an implementation detail into the abstraction and defeat the
 * entire point (RISK-003).
 */
export interface FraudScoringProvider {
  /** Stable identity for logging, metrics labels, and the audit trail. */
  readonly name: ScoringProviderName;

  /**
   * Produce a risk assessment for one transaction.
   *
   * Must complete within the caller's timeout (ADR-003: 15ms budget for
   * `stub`/`rules`, which run in-process; ADR-005: 30ms for `ml`, which
   * calls out over HTTP behind a circuit breaker). A provider that cannot
   * meet its budget should be considered broken, not slow — there is no
   * "give it more time" escape hatch on the hot path.
   */
  score(input: ScoringInput): Promise<ScoringResult>;
}

export interface ScoringInput {
  readonly transaction: Transaction;
  readonly features: FeatureVector;
}

export interface ScoringResult {
  readonly score: RiskScore;
  readonly riskFactors: readonly RiskFactor[];
  readonly provider: ScoringProviderName;
  /** e.g. "model-v0-stub", "model-v1-rules", "model-v3-xgboost" (Phase 10). Recorded on every FraudDecision — FR-012. */
  readonly modelVersion: string;
}
