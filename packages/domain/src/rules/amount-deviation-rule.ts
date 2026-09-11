import { featureOrDefault } from '../entities/feature-vector';

import type { FraudRule, RuleInput, RuleResult } from './fraud-rule';
import { ratioToSeverity } from './ratio-severity';
import type { AmountDeviationThresholds } from './rule-thresholds';

/**
 * FR-003. Flags a transaction far larger than the user's recent average —
 * a sudden high-value purchase is a common account-takeover pattern.
 *
 * ASSUMED: with no spending history (`average_amount_24h` is the declared
 * default, 0 — a brand-new user, or Redis degraded), there is nothing to
 * deviate FROM, so this rule does not trigger. A large first transaction
 * is a legitimate thing to flag, but that is a *different* signal (no
 * history at all) from *this* rule's job (deviation from a known
 * baseline) — conflating them would make this rule's reason misleading.
 */
export class AmountDeviationRule implements FraudRule {
  readonly name = 'amount-deviation';

  constructor(private readonly thresholds: AmountDeviationThresholds) {}

  evaluate(input: RuleInput): RuleResult {
    const average = featureOrDefault(input.features, 'average_amount_24h', 0);
    if (average <= 0) {
      return {
        ruleName: this.name,
        triggered: false,
        severity: 'LOW',
        reason: '',
        scoreContribution: 0,
      };
    }

    const amountMajorUnits = input.transaction.amount.toMajorUnits();
    const ratio = amountMajorUnits / average / this.thresholds.multiplier;

    if (ratio < 1) {
      return {
        ruleName: this.name,
        triggered: false,
        severity: 'LOW',
        reason: '',
        scoreContribution: 0,
      };
    }

    const { severity, contribution } = ratioToSeverity(ratio);
    return {
      ruleName: this.name,
      triggered: true,
      severity,
      reason: `Transaction amount is well above this user's recent average (${(amountMajorUnits / average).toFixed(1)}x the 24-hour average)`,
      scoreContribution: contribution,
    };
  }
}
