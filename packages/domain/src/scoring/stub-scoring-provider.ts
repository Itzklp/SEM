import { RiskScore } from '../value-objects/risk-score';

import type { FraudScoringProvider, ScoringInput, ScoringResult } from './fraud-scoring-provider';

/**
 * FR-004's simplest real provider — "fully deterministic", per
 * docs/ROADMAP.md, and deliberately NOT the rule engine: it reads only
 * the transaction itself, not the feature vector, so it produces a score
 * even when Redis is fully down (ADR-005's all-defaults feature vector
 * changes nothing about this provider's output — a property worth having
 * in at least one provider, for exactly that scenario).
 *
 * Two roles, not one:
 *  1. A selectable top-level provider in its own right (`SCORING_PROVIDER=stub`)
 *     — the simplest possible "something is actually scoring transactions"
 *     baseline, useful for a demo that wants the decision pipeline
 *     without the rule engine's complexity.
 *  2. `RuleBasedScoringProvider`'s internal stand-in for "the model
 *     signal" (FR-005) until Phase 10 has a real `MLScoringProvider` to
 *     put there instead — composition, not duplication.
 *
 * Deliberately simple and named as such: a capped-linear function of the
 * transaction amount. This is not a fraud heuristic worth defending on
 * its own merits — it is a stand-in for "a model exists here", replaced
 * wholesale by real ML in Phase 10 without any caller needing to change
 * (CON-005, RISK-003).
 */
const AMOUNT_SCALE_MAJOR_UNITS = 2_000; // ASSUMED: $2,000 maps to a score of 1.0
/**
 * ASSUMED: below this contribution, the amount isn't a meaningfully
 * "contributing" factor worth surfacing — only that it's nonzero, which
 * is true of almost every transaction and would make `riskFactors`
 * non-empty (and therefore this reason visible) on nearly every ALLOW
 * decision too. FR-007 requires a reason on every non-ALLOW decision; it
 * does not ask for noise on routine ones.
 */
const MIN_CONTRIBUTION_TO_REPORT = 0.5;

export class StubFraudScoringProvider implements FraudScoringProvider {
  readonly name = 'stub' as const;

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async to match providers that call out over HTTP (ML); this one has nothing to await.
  async score(input: ScoringInput): Promise<ScoringResult> {
    const amountMajorUnits = input.transaction.amount.toMajorUnits();
    const value = Math.min(1, amountMajorUnits / AMOUNT_SCALE_MAJOR_UNITS);
    const score = RiskScore.of(value);

    return {
      score,
      riskFactors:
        value >= MIN_CONTRIBUTION_TO_REPORT
          ? [
              {
                reason: 'Transaction amount is a contributing risk factor',
                internal: { source: this.name, scoreContribution: value },
              },
            ]
          : [],
      provider: this.name,
      modelVersion: 'model-v1-stub',
    };
  }
}
