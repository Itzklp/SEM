import { FEATURE_NAMES, type FeatureName } from '@fraudguard/domain';

/**
 * FR-002, ADR-002: "a feature's key layout, window and default are defined
 * in exactly one place." This file is that place — `feature-writer.ts` and
 * `feature-reader.ts` both import from here rather than repeating a window
 * length or a default value.
 *
 * Milliseconds throughout (Redis scores and JS `Date.now()` are both
 * epoch-ms), to avoid a unit-conversion bug at every call site.
 */

export const MS = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
} as const;

/**
 * Per-feature window, in the sense of "how far back does this feature
 * look". `null` for the two risk-lookup features (reference data, not a
 * rolling window) and for `account_age_days` (computed from a fixed point,
 * not a window).
 */
export const FEATURE_WINDOWS_MS: Record<FeatureName, number | null> = {
  transaction_count_5m: 5 * MS.MINUTE,
  transaction_count_1h: MS.HOUR,
  amount_sum_1h: MS.HOUR,
  average_amount_24h: MS.DAY,
  distinct_merchants_1h: MS.HOUR,
  distinct_locations_24h: MS.DAY,
  failed_transactions_10m: 10 * MS.MINUTE,
  device_transaction_count: null,
  account_age_days: null,
  merchant_risk_score: null,
  ip_risk_score: null,
};

/**
 * ADR-002: "every feature declares a default used on miss or failure" —
 * this is what makes degraded mode (ADR-005, FR-016) a real fallback
 * rather than an aspiration. Zero for every count/sum/average is the
 * cautious-open choice: an unknown history is treated as "no history
 * observed", not as "assume the worst" (which would unfairly bias a
 * brand-new user or a Redis outage toward BLOCK) and not as "assume the
 * best" either (0 genuinely is what "no data" means for a counter).
 * Same reasoning for the two risk-lookup features: an unscored
 * merchant/IP defaults to neutral (0), not to maximum suspicion.
 */
export const FEATURE_DEFAULTS: Record<FeatureName, number> = {
  transaction_count_5m: 0,
  transaction_count_1h: 0,
  amount_sum_1h: 0,
  average_amount_24h: 0,
  distinct_merchants_1h: 0,
  distinct_locations_24h: 0,
  failed_transactions_10m: 0,
  device_transaction_count: 0,
  account_age_days: 0,
  merchant_risk_score: 0,
  ip_risk_score: 0,
};

/**
 * `device_transaction_count` has no natural window in the feature
 * catalogue (brief §11 lists it unwindowed) but an event log retained
 * forever is an unbounded memory leak (ADR-002's "bounded by TTLs"
 * consequence). ASSUMED: a 90-day retention is a reasonable proxy for
 * "this device's activity, for practical purposes" — not specified by any
 * requirement, so tracked here as a named, changeable constant rather
 * than a magic number buried in `feature-writer.ts`.
 */
export const DEVICE_RETENTION_MS = 90 * MS.DAY;

/**
 * The longest feature window in the catalogue. Every write trims the
 * per-user event log to this horizon — nothing further back is ever read,
 * so nothing further back needs to be kept (ADR-002: "memory grows with
 * tracked entities... bounded by TTLs").
 */
export const MAX_USER_WINDOW_MS = MS.DAY;

// Re-exported so call sites that only need the catalogue don't have to
// reach into `@fraudguard/domain` separately.
export { FEATURE_NAMES };
export type { FeatureName };
