import { featureOrDefault } from '../entities/feature-vector';

import type { FraudRule, RuleInput, RuleResult } from './fraud-rule';
import { ratioToSeverity } from './ratio-severity';
import type { FailedAttemptThresholds } from './rule-thresholds';

/**
 * FR-003. Flags a user with an unusually high number of this system's own
 * BLOCK decisions in the last 10 minutes — repeated rejection is itself a
 * signal, independent of what each individual rejection was for. ASSUMED
 * (inherited from feature-writer.ts): "failed" means BLOCKed by
 * FraudGuard, not a payment-gateway decline — this system has no concept
 * of the latter.
 */
export class FailedAttemptRule implements FraudRule {
  readonly name = 'failed-attempt';

  constructor(private readonly thresholds: FailedAttemptThresholds) {}

  evaluate(input: RuleInput): RuleResult {
    const failedCount = featureOrDefault(input.features, 'failed_transactions_10m', 0);
    const ratio = this.thresholds.maxFailed10m > 0 ? failedCount / this.thresholds.maxFailed10m : 0;

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
      reason: `${failedCount} blocked transactions for this user in the last 10 minutes`,
      scoreContribution: contribution,
    };
  }
}
