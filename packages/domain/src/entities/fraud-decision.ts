import type { Decision, DegradedReason, ScoringProviderName } from '../enums';
import type { RiskScore } from '../value-objects/risk-score';

/**
 * A single risk factor contributing to a decision — the unit that
 * FR-007 (explainability) is built from. `internal` fields exist so the
 * decision engine can carry debugging detail (e.g. the exact rule
 * threshold) that must be stripped before the decision reaches a client —
 * UT-EXPL-002 in the traceability matrix exists specifically to verify
 * that stripping happens.
 */
export interface RiskFactor {
  /** Human-readable, client-safe explanation. e.g. "Transaction velocity is unusually high". */
  readonly reason: string;
  /** Internal-only detail: which rule/component produced this, and its raw contribution. Never serialised to a client response. */
  readonly internal: {
    readonly source: string;
    readonly scoreContribution: number;
  };
}

/**
 * The outcome of scoring and deciding on one transaction. FR-006, FR-007,
 * FR-012. Immutable once produced — a decision is never edited, only
 * superseded by a new transaction (e.g. a review outcome creates a
 * `FraudCase` state change, not a new `FraudDecision`).
 */
export interface FraudDecision {
  readonly transactionId: string;
  readonly decision: Decision;
  readonly riskScore: RiskScore;
  readonly reasons: readonly RiskFactor[];
  readonly policyVersion: string;
  readonly modelVersion: string;
  readonly scoringProvider: ScoringProviderName;
  readonly degraded: boolean;
  readonly degradedReason: DegradedReason;
  readonly decidedAt: Date;
  readonly processingTimeMs: number;
}

/**
 * Strips internal detail for anything crossing the trust boundary to a
 * client (NFR-008, threat-model.md §3.1 info-disclosure mitigation).
 * This function, not developer discipline, is what UT-EXPL-002 pins down.
 */
export function toClientSafeReasons(reasons: readonly RiskFactor[]): readonly { reason: string }[] {
  return reasons.map((r) => ({ reason: r.reason }));
}
