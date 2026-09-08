import {
  RiskScore,
  type FraudScoringProvider,
  type ScoringInput,
  type ScoringResult,
} from '@fraudguard/domain';

/**
 * PLACEHOLDER — Phase 3 scope only. Proves the `FraudScoringProvider`
 * abstraction (CON-005) is wired end to end — the hot path calls this
 * exactly the way it will call `StubFraudScoringProvider` /
 * `RuleBasedScoringProvider` / `MLScoringProvider` later — before any real
 * fraud logic exists. Always scores zero risk: this is deliberate, not a
 * bug, because there is no rule engine yet to produce anything else.
 *
 * Phase 5 replaces this with the real `StubFraudScoringProvider`
 * (deterministic, in `packages/domain`) without changing anything that
 * calls `FraudScoringProvider` — that substitutability is the entire
 * point of the interface, and this placeholder is the first proof of it.
 */
export class PlaceholderScoringProvider implements FraudScoringProvider {
  readonly name = 'stub' as const;

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async to match real providers (ML calls out over HTTP); this one has nothing to await yet.
  async score(_input: ScoringInput): Promise<ScoringResult> {
    return {
      score: RiskScore.zero(),
      riskFactors: [],
      provider: this.name,
      modelVersion: 'model-v0-placeholder',
    };
  }
}
