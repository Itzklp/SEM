import type { FeatureVector } from '@fraudguard/domain';

/**
 * PLACEHOLDER — Phase 3 scope only. Real behavioural feature computation
 * (windowed counters, pipelined Redis fetch, per-feature defaults) is
 * Phase 4's deliverable (docs/ROADMAP.md). This function exists so
 * `fraud-api`'s hot path can legitimately reach `FEATURES_LOADED` in the
 * transaction lifecycle now, without inventing a second code path for
 * Phase 4 to later delete.
 *
 * The signature is what Phase 4 must preserve — everything calling this
 * function keeps working unmodified once the body is replaced with a real
 * pipelined Redis read. Note the returned shape is deliberately identical
 * to ADR-005's Redis-down degraded fallback: a placeholder "no real
 * features yet" and a genuine "Redis is down" are, correctly, the same
 * shape to every consumer downstream.
 */
export function getPlaceholderFeatureVector(userId: string): FeatureVector {
  return {
    userId,
    computedAt: new Date(),
    source: 'unavailable',
    features: {},
  };
}
