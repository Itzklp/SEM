import type { FeatureVector } from '../entities/feature-vector';
import type { RiskFactor } from '../entities/fraud-decision';
import type { Transaction } from '../entities/transaction';
import type { ScoringProviderName } from '../enums';
import type { RiskScore } from '../value-objects/risk-score';

/**
 * The load-bearing abstraction of this project (CON-005, ADR-004). Every
 * consumer of a fraud score depends on this interface alone — Stub, Rules,
 * and MLScoringProvider are interchangeable implementations of it, which is
 * what makes swapping in ML a config change rather than a refactor, and an
 * ML-vs-baseline comparison a controlled experiment.
 *
 * Don't add a method here that only one implementation can satisfy — that
 * leaks an implementation detail into the abstraction (RISK-003).
 */
export interface FraudScoringProvider {
  /** Stable identity for logging, metrics labels, and the audit trail. */
  readonly name: ScoringProviderName;

  /**
   * Produce a risk assessment for one transaction, within the caller's
   * timeout (ADR-003: 15ms for in-process stub/rules; ADR-005: 30ms for
   * ml, behind a circuit breaker). A provider that misses its budget is
   * broken, not slow — there's no "give it more time" on the hot path.
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
  /** e.g. "model-v0-stub", "model-v1-rules", "model-v3-xgboost". Recorded on every FraudDecision — FR-012. */
  readonly modelVersion: string;
  /** Set when this provider had to use its configured safe fallback. */
  readonly degradedReason?: 'ML_UNAVAILABLE';
}
