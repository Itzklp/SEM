import type { FeatureVector } from '../entities/feature-vector';
import type { Transaction } from '../entities/transaction';
import type { RuleSeverity } from '../enums';

/**
 * FR-003. The Strategy interface every deterministic rule implements
 * (`VelocityRule`, `AmountDeviationRule`, `DeviceRiskRule`,
 * `GeographicAnomalyRule`, and others added in Phase 5). Implementations
 * are deliberately not in this package yet — Phase 1 defines the contract;
 * Phase 5 implements against it. Adding a new rule must never require a
 * change to this interface or to the engine that runs rules (UT-RULE-031).
 */
export interface FraudRule {
  /** Stable identity for logging, metrics, and the audit trail. */
  readonly name: string;

  /**
   * Pure evaluation — no I/O. `input.features` may have `source: 'unavailable'`
   * (ADR-005 Redis outage); a rule MUST use `featureOrDefault` and never
   * assume presence, or it will throw on exactly the path it is most
   * needed on.
   */
  evaluate(input: RuleInput): RuleResult;
}

export interface RuleInput {
  readonly transaction: Transaction;
  readonly features: FeatureVector;
}

export interface RuleResult {
  readonly ruleName: string;
  readonly triggered: boolean;
  readonly severity: RuleSeverity;
  /** Client-safe explanation, used verbatim in FraudDecision.reasons when triggered (FR-007). Empty when not triggered. */
  readonly reason: string;
  /** Contribution to the combined rule score in [0, 1]. Zero when not triggered. */
  readonly scoreContribution: number;
}
