import { RiskScore } from '../value-objects/risk-score';

import type { FraudRule, RuleInput, RuleResult } from './fraud-rule';

export interface RuleEngineResult {
  /** Every rule's result, triggered or not — the full audit trail of what was checked. */
  readonly results: readonly RuleResult[];
  /** Only the rules that fired — what a decision's explanation is built from (FR-007). */
  readonly triggered: readonly RuleResult[];
  /** The combined "rules" signal, in [0, 1] — see below for why MAX, not an average. */
  readonly combinedScore: RiskScore;
}

/**
 * FR-003's engine: runs every given rule against the same input and
 * combines the result. Deliberately knows nothing about any specific
 * rule — it iterates `FraudRule[]`, nothing more — which is the whole
 * mechanism behind "adding a rule requires no change to the decision
 * engine" (UT-RULE-031): a caller passes a longer array, and everything
 * below keeps working unmodified.
 *
 * Combination is MAX across triggered rules' `scoreContribution`, not an
 * average. An average across N rules dilutes a single severe signal
 * (e.g. one CRITICAL velocity hit scoring 1.0 would average to ~0.17
 * across six rules, most of which are healthily at 0) — exactly the
 * wrong direction for a system meant to catch the worst thing currently
 * true about a transaction, not its average rule performance.
 */
export function evaluateRules(rules: readonly FraudRule[], input: RuleInput): RuleEngineResult {
  const results = rules.map((rule) => rule.evaluate(input));
  const triggered = results.filter((r) => r.triggered);
  const combinedScore =
    triggered.length > 0
      ? RiskScore.of(Math.max(...triggered.map((r) => r.scoreContribution)))
      : RiskScore.zero();

  return { results, triggered, combinedScore };
}
