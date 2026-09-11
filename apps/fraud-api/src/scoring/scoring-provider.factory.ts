import type { AppConfig } from '@fraudguard/config';
import {
  AmountDeviationRule,
  DeviceRiskRule,
  FailedAttemptRule,
  GeographicAnomalyRule,
  MerchantRiskRule,
  RuleBasedScoringProvider,
  StubFraudScoringProvider,
  VelocityRule,
  type FraudRule,
  type FraudScoringProvider,
} from '@fraudguard/domain';

/**
 * CON-005's composition root: the one place that knows how to construct
 * each `FraudScoringProvider`, selected by `SCORING_PROVIDER`
 * (`AppConfig.scoring.provider`). Everything downstream (`ScoringService`)
 * depends only on the `FraudScoringProvider` interface — swapping which
 * branch below runs requires no change to the decision engine or the API
 * contract (FR-004's acceptance criterion, proved by this function being
 * the entire blast radius of a provider change).
 *
 * `'ml'` is not a configuration error at the Zod-schema level (Phase 10
 * will add it there too, legitimately), but it IS one here, today: there
 * is no `MLScoringProvider` yet (RISK-003 — it is not written before
 * Phase 10), so selecting it must fail loudly at startup, not silently
 * fall back to something else.
 */
export function createScoringProvider(config: AppConfig): FraudScoringProvider {
  switch (config.scoring.provider) {
    case 'stub':
      return new StubFraudScoringProvider();
    case 'rules':
      return new RuleBasedScoringProvider(buildRules(config), config.policy.weights);
    case 'ml':
      throw new Error(
        "SCORING_PROVIDER=ml is not yet implemented — MLScoringProvider is a Phase 10 deliverable (RISK-003: written deliberately late). Use 'stub' or 'rules'.",
      );
  }
}

function buildRules(config: AppConfig): FraudRule[] {
  return [
    new VelocityRule(config.rules.velocity),
    new AmountDeviationRule(config.rules.amountDeviation),
    new DeviceRiskRule(config.rules.deviceRisk),
    new GeographicAnomalyRule(config.rules.geographicAnomaly),
    new FailedAttemptRule(config.rules.failedAttempt),
    new MerchantRiskRule(config.rules.merchantRisk),
  ];
}
