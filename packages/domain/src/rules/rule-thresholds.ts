/**
 * FR-003: "Rules are declared as data/config, not embedded in
 * controllers." Every threshold a rule compares against arrives through
 * one of these plain data shapes, constructed by the caller (`fraud-api`'s
 * composition root) from `AppConfig` — never hardcoded inside a rule.
 * Changing a number here never requires touching `rule-engine.ts` or any
 * other rule (UT-RULE-031).
 *
 * Every default below is an explicit, documented ASSUMPTION, not a
 * measured or researched fraud-industry figure — there is no labelled
 * fraud dataset in this project's scope (that is Phase 10's, and even
 * there, FR-018's synthetic generator, not real history). Phase 9/11 is
 * where these get revisited against actual demo/load behaviour.
 */

export interface VelocityThresholds {
  /** transaction_count_5m at or above this triggers the rule. */
  readonly max5m: number;
  /** transaction_count_1h at or above this triggers the rule. */
  readonly max1h: number;
}

export interface AmountDeviationThresholds {
  /** Triggers when the transaction amount is at least this many times the user's average_amount_24h. */
  readonly multiplier: number;
}

export interface DeviceRiskThresholds {
  /** device_transaction_count at or above this triggers the rule. ASSUMED proxy for a shared/bot/card-testing device — there is no distinct-user-per-device feature in the Phase 4 catalogue. */
  readonly maxDeviceTransactions: number;
}

export interface GeographicAnomalyThresholds {
  /** distinct_locations_24h at or above this triggers the rule. ASSUMED: distinct IP is the available proxy for "location" (Phase 4, no geo-IP lookup in scope). */
  readonly maxDistinctLocations24h: number;
}

export interface FailedAttemptThresholds {
  /** failed_transactions_10m at or above this triggers the rule. */
  readonly maxFailed10m: number;
}

export interface MerchantRiskThresholds {
  /** merchant_risk_score at or above this triggers the rule. */
  readonly riskThreshold: number;
}

export interface RuleThresholds {
  readonly velocity: VelocityThresholds;
  readonly amountDeviation: AmountDeviationThresholds;
  readonly deviceRisk: DeviceRiskThresholds;
  readonly geographicAnomaly: GeographicAnomalyThresholds;
  readonly failedAttempt: FailedAttemptThresholds;
  readonly merchantRisk: MerchantRiskThresholds;
}
