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
import type { Logger } from 'pino';

import { MLScoringProvider } from './ml-scoring.provider';

/**
 * CON-005's composition root: the one place that knows how to construct
 * each `FraudScoringProvider`, selected by `SCORING_PROVIDER`
 * (`AppConfig.scoring.provider`). Everything downstream (`ScoringService`)
 * depends only on the `FraudScoringProvider` interface — swapping which
 * branch below runs requires no change to the decision engine or the API
 * contract (FR-004's acceptance criterion, proved by this function being
 * the entire blast radius of a provider change).
 *
 * ML is an explicit selectable provider. Its safe fallback is configured
 * separately and is reported as degraded when the inference dependency fails.
 */
export function createScoringProvider(config: AppConfig, logger: Logger): FraudScoringProvider {
  switch (config.scoring.provider) {
    case 'stub':
      return new StubFraudScoringProvider();
    case 'rules':
      return new RuleBasedScoringProvider(buildRules(config), config.policy.weights);
    case 'ml':
      return new MLScoringProvider(config, logger);
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
