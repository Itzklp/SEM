import { featureOrDefault } from '../entities/feature-vector';

import type { FraudRule, RuleInput, RuleResult } from './fraud-rule';
import type { MerchantRiskThresholds } from './rule-thresholds';

/**
 * FR-003. Flags a transaction at a merchant whose reference-data risk
 * score (`merchant_risk_score`, ADR-002's risk-lookup feature family)
 * meets or exceeds the configured threshold. Phase 4 built the read
 * mechanism and its default-on-miss (0 — neutral, not suspicious);
 * seeding real merchant risk scores is Phase 5's named deliverable
 * (`docs/TEAM_TASK_BREAKDOWN.md`) via `setMerchantRiskScore`.
 *
 * Severity tracks the score itself directly (it is already normalised to
 * [0, 1] by definition — unlike the other rules, there is no "ratio past
 * a threshold" to compute a severity band from a count).
 */
export class MerchantRiskRule implements FraudRule {
  readonly name = 'merchant-risk';

  constructor(private readonly thresholds: MerchantRiskThresholds) {}

  evaluate(input: RuleInput): RuleResult {
    const riskScore = featureOrDefault(input.features, 'merchant_risk_score', 0);

    if (riskScore < this.thresholds.riskThreshold) {
      return {
        ruleName: this.name,
        triggered: false,
        severity: 'LOW',
        reason: '',
        scoreContribution: 0,
      };
    }

    const severity = riskScore >= 0.9 ? 'CRITICAL' : riskScore >= 0.8 ? 'HIGH' : 'MEDIUM';
    return {
      ruleName: this.name,
      triggered: true,
      severity,
      reason: 'This merchant is flagged as elevated risk',
      scoreContribution: riskScore,
    };
  }
}
