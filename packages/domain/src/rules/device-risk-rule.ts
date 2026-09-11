import { featureOrDefault } from '../entities/feature-vector';

import type { FraudRule, RuleInput, RuleResult } from './fraud-rule';
import { ratioToSeverity } from './ratio-severity';
import type { DeviceRiskThresholds } from './rule-thresholds';

/**
 * FR-003. Flags a device that has been used in an unusually high number
 * of transactions. ASSUMED proxy for a shared, bot-driven, or
 * card-testing device — the Phase 4 feature catalogue has no
 * distinct-users-per-device count, which would be the more direct
 * signal; `device_transaction_count` (unwindowed — feature-definitions.ts)
 * is what exists, and high unwindowed activity on one device is still a
 * meaningful, if coarser, risk signal.
 */
export class DeviceRiskRule implements FraudRule {
  readonly name = 'device-risk';

  constructor(private readonly thresholds: DeviceRiskThresholds) {}

  evaluate(input: RuleInput): RuleResult {
    const count = featureOrDefault(input.features, 'device_transaction_count', 0);
    const ratio =
      this.thresholds.maxDeviceTransactions > 0 ? count / this.thresholds.maxDeviceTransactions : 0;

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
      reason: `This device has been used in an unusually high number of transactions (${count})`,
      scoreContribution: contribution,
    };
  }
}
