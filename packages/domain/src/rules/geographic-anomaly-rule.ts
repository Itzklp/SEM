import { featureOrDefault } from '../entities/feature-vector';

import type { FraudRule, RuleInput, RuleResult } from './fraud-rule';
import { ratioToSeverity } from './ratio-severity';
import type { GeographicAnomalyThresholds } from './rule-thresholds';

/**
 * FR-003. Flags a user transacting from an unusually high number of
 * distinct locations within 24 hours — the standard "impossible travel"
 * signal. ASSUMED: distinct IP address stands in for "location"
 * (`distinct_locations_24h`, feature-writer.ts) — there is no geo-IP
 * lookup in this system's scope, so this catches "many different IPs",
 * not necessarily "geographically implausible travel" in the strict
 * sense.
 */
export class GeographicAnomalyRule implements FraudRule {
  readonly name = 'geographic-anomaly';

  constructor(private readonly thresholds: GeographicAnomalyThresholds) {}

  evaluate(input: RuleInput): RuleResult {
    const distinctLocations = featureOrDefault(input.features, 'distinct_locations_24h', 0);
    const ratio =
      this.thresholds.maxDistinctLocations24h > 0
        ? distinctLocations / this.thresholds.maxDistinctLocations24h
        : 0;

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
      reason: `Transactions from an unusually high number of distinct locations in the last 24 hours (${distinctLocations})`,
      scoreContribution: contribution,
    };
  }
}
