import { featureOrDefault } from '../entities/feature-vector';

import type { FraudRule, RuleInput, RuleResult } from './fraud-rule';
import { ratioToSeverity } from './ratio-severity';
import type { VelocityThresholds } from './rule-thresholds';

/**
 * FR-003. Flags a burst of transactions from the same user — the classic
 * card-testing / account-takeover signal. Checks both the 5-minute and
 * 1-hour windows and triggers on whichever is further past its threshold,
 * so a short sharp burst and a sustained elevated rate are both caught.
 */
export class VelocityRule implements FraudRule {
  readonly name = 'velocity';

  constructor(private readonly thresholds: VelocityThresholds) {}

  evaluate(input: RuleInput): RuleResult {
    const count5m = featureOrDefault(input.features, 'transaction_count_5m', 0);
    const count1h = featureOrDefault(input.features, 'transaction_count_1h', 0);

    const ratio5m = this.thresholds.max5m > 0 ? count5m / this.thresholds.max5m : 0;
    const ratio1h = this.thresholds.max1h > 0 ? count1h / this.thresholds.max1h : 0;
    const ratio = Math.max(ratio5m, ratio1h);

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
      reason: `Unusually high transaction velocity (${count5m} in the last 5 minutes, ${count1h} in the last hour)`,
      scoreContribution: contribution,
    };
  }
}
