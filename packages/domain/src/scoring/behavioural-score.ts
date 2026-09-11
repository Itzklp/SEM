import { featureOrDefault, type FeatureVector } from '../entities/feature-vector';

/**
 * FR-005's third signal: a smooth, continuous reading of recent activity,
 * distinct from the rule engine's hard thresholds (`rules/rule-engine.ts`)
 * and from the model signal (`stub-scoring-provider.ts`). Where a rule
 * either fires or doesn't, this produces a gradient — a user sitting just
 * under every rule's threshold on several features at once still reads
 * as somewhat elevated here, which no single threshold rule would catch
 * alone.
 *
 * Deliberately simple: the mean of three features, each independently
 * normalised against an ASSUMED "typical busy" scale and clamped to
 * [0, 1]. Not fitted, not researched — the same honesty as
 * `feature-definitions.ts`'s defaults and `ratio-severity.ts`'s curve.
 * Revisit with measurement once there is real traffic to measure against
 * (Phase 9/11).
 */
const VELOCITY_1H_NORM = 10; // ASSUMED: 10 transactions/hour reads as "fully elevated"
const AMOUNT_SUM_1H_NORM = 2_000; // ASSUMED: $2,000/hour reads as "fully elevated"
const DISTINCT_MERCHANTS_1H_NORM = 5; // ASSUMED: 5 distinct merchants/hour reads as "fully elevated"

export function computeBehaviouralScore(features: FeatureVector): number {
  const velocity = clamp01(
    featureOrDefault(features, 'transaction_count_1h', 0) / VELOCITY_1H_NORM,
  );
  const amount = clamp01(featureOrDefault(features, 'amount_sum_1h', 0) / AMOUNT_SUM_1H_NORM);
  const distinctMerchants = clamp01(
    featureOrDefault(features, 'distinct_merchants_1h', 0) / DISTINCT_MERCHANTS_1H_NORM,
  );

  return (velocity + amount + distinctMerchants) / 3;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
