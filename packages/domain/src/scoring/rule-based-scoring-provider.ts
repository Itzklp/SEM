import type { FraudRule } from '../rules/fraud-rule';
import { evaluateRules } from '../rules/rule-engine';
import { RiskScore } from '../value-objects/risk-score';

import { computeBehaviouralScore } from './behavioural-score';
import { combineScores, type ScoreWeights } from './combiner';
import type { FraudScoringProvider, ScoringInput, ScoringResult } from './fraud-scoring-provider';
import { StubFraudScoringProvider } from './stub-scoring-provider';

/**
 * FR-003/FR-004/FR-005's complete, zero-ML scorer — the provider this
 * entire phase is built around. `ADR-005`: "Rules are a complete scorer,
 * so signal is reduced, not absent" when this stands in for
 * `MLScoringProvider` during a Phase 10 circuit-breaker fallback — which
 * is exactly what happens below: the "model" component is
 * `StubFraudScoringProvider`'s deterministic amount-based score (the best
 * deterministic substitute available without a real model), not a
 * missing value.
 *
 * Three signals combined (FR-005), each independent of the others:
 *  1. `rules`       — `evaluateRules()` over every given `FraudRule`
 *  2. `model`        — delegated to `StubFraudScoringProvider` (composition,
 *                      not duplication — see that file's doc comment)
 *  3. `behavioural`  — `computeBehaviouralScore()`, a continuous reading
 *                      independent of any rule's hard threshold
 *
 * `rules` is constructor-injected (FR-003: "adding a rule requires no
 * change to the decision engine" — nor to this provider; a longer array
 * from the caller is the entire change).
 */
export class RuleBasedScoringProvider implements FraudScoringProvider {
  readonly name = 'rules' as const;

  private readonly modelProvider = new StubFraudScoringProvider();

  constructor(
    private readonly rules: readonly FraudRule[],
    private readonly weights: ScoreWeights,
  ) {}

  async score(input: ScoringInput): Promise<ScoringResult> {
    const ruleEngineResult = evaluateRules(this.rules, input);
    const modelResult = await this.modelProvider.score(input);
    const behaviouralScore = RiskScore.of(computeBehaviouralScore(input.features));

    const combined = combineScores(
      {
        rules: ruleEngineResult.combinedScore,
        model: modelResult.score,
        behavioural: behaviouralScore,
      },
      this.weights,
    );

    const riskFactors = ruleEngineResult.triggered.map((result) => ({
      reason: result.reason,
      internal: { source: result.ruleName, scoreContribution: result.scoreContribution },
    }));
    // The model component's own reason (StubFraudScoringProvider's) rides
    // along too — it is a real contributing signal to this provider's
    // output, not an internal implementation detail to hide.
    riskFactors.push(...modelResult.riskFactors);

    return {
      score: combined,
      riskFactors,
      provider: this.name,
      modelVersion: 'model-v1-rules',
    };
  }
}
