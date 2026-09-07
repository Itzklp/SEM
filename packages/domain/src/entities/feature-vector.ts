/**
 * FR-002, ADR-002. The behavioural feature vector served from Redis for one
 * transaction's scoring. Declared here — in the I/O-free domain package —
 * because rules and scoring (Phase 5) consume this shape without knowing or
 * caring that it came from Redis; `packages/feature-store` (Phase 4) is
 * responsible for producing it.
 *
 * `Partial` deliberately: ADR-002 requires every feature to have a declared
 * default used on miss or Redis failure (FR-016). A feature absent from
 * this object is a "miss", not an error — the consumer (a rule, a
 * combiner) is the one that knows the safe default for its own use, via
 * `featureOrDefault` below. This is also what
 * `noUncheckedIndexedAccess` in tsconfig.base.json makes the compiler
 * enforce: reading a missing key yields `undefined`, not a silent zero.
 */
export interface FeatureVector {
  readonly userId: string;
  readonly computedAt: Date;
  /** Whether this vector is real (Redis reachable) or the all-defaults fallback (ADR-005 FEATURES_UNAVAILABLE). */
  readonly source: 'live' | 'unavailable';
  readonly features: Partial<Record<FeatureName, number>>;
}

/**
 * The feature catalogue named in the brief (§11). Declaring it as a union
 * here — rather than a free-form string key — means an unrecognised
 * feature name is a compile error at every call site, not a silent typo
 * that always misses.
 */
export const FEATURE_NAMES = [
  'transaction_count_5m',
  'transaction_count_1h',
  'amount_sum_1h',
  'average_amount_24h',
  'distinct_merchants_1h',
  'distinct_locations_24h',
  'failed_transactions_10m',
  'device_transaction_count',
  'account_age_days',
  'merchant_risk_score',
  'ip_risk_score',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export function featureOrDefault(
  vector: FeatureVector,
  name: FeatureName,
  fallback: number,
): number {
  return vector.features[name] ?? fallback;
}
