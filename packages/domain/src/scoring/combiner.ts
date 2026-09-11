import { RiskScore } from '../value-objects/risk-score';

/** FR-005: "Combination weights are configuration, not code." Sourced from `AppConfig.policy.weights` by the caller — this module never reads config itself (ADR-004: domain stays I/O- and framework-free). */
export interface ScoreWeights {
  readonly rules: number;
  readonly model: number;
  readonly behavioural: number;
}

export interface ScoreComponents {
  readonly rules: RiskScore;
  readonly model: RiskScore;
  readonly behavioural: RiskScore;
}

/**
 * FR-005: combines the rule, model and behavioural signals into one
 * normalised `[0, 1]` score. A thin, named wrapper around
 * `RiskScore.combine()` rather than calling it inline at each use site —
 * `RuleBasedScoringProvider` is the only caller today, but naming this
 * step is what makes it obvious, in any future caller, which three
 * signals FR-005 is actually asking for.
 */
export function combineScores(components: ScoreComponents, weights: ScoreWeights): RiskScore {
  return RiskScore.combine([
    { score: components.rules, weight: weights.rules },
    { score: components.model, weight: weights.model },
    { score: components.behavioural, weight: weights.behavioural },
  ]);
}
