import type { AppConfig } from '@fraudguard/config';
import {
  AmountDeviationRule,
  combineScores,
  computeBehaviouralScore,
  DeviceRiskRule,
  evaluateRules,
  FailedAttemptRule,
  GeographicAnomalyRule,
  MerchantRiskRule,
  RiskScore,
  RuleBasedScoringProvider,
  StubFraudScoringProvider,
  VelocityRule,
  type FraudRule,
  type FraudScoringProvider,
  type ScoringInput,
  type ScoringResult,
} from '@fraudguard/domain';
import { mlDurationSeconds } from '@fraudguard/observability';
import type { Logger } from 'pino';

interface MlResponse {
  readonly score: number;
  readonly modelVersion: string;
}

type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Calls the isolated Python model service, combines its probability with the
 * same rule and behavioural signals as the rules provider, and falls back to
 * the configured deterministic provider on timeout, service errors, or an
 * open circuit breaker.
 */
export class MLScoringProvider implements FraudScoringProvider {
  readonly name = 'ml' as const;
  private readonly rules: readonly FraudRule[];
  private readonly fallback: FraudScoringProvider;
  private failures = 0;
  private state: CircuitState = 'closed';
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.rules = [
      new VelocityRule(config.rules.velocity),
      new AmountDeviationRule(config.rules.amountDeviation),
      new DeviceRiskRule(config.rules.deviceRisk),
      new GeographicAnomalyRule(config.rules.geographicAnomaly),
      new FailedAttemptRule(config.rules.failedAttempt),
      new MerchantRiskRule(config.rules.merchantRisk),
    ];
    this.fallback =
      config.scoring.fallbackProvider === 'stub'
        ? new StubFraudScoringProvider()
        : new RuleBasedScoringProvider(this.rules, config.policy.weights);
  }

  async score(input: ScoringInput): Promise<ScoringResult> {
    if (!this.beginAttempt()) return this.fallbackScore(input, 'circuit-open');
    const started = performance.now();
    try {
      const response = await this.requestScore(input);
      this.failures = 0;
      this.state = 'closed';
      this.probeInFlight = false;
      mlDurationSeconds.observe({ provider: 'ml' }, (performance.now() - started) / 1000);
      return this.combine(input, response);
    } catch (error) {
      mlDurationSeconds.observe({ provider: 'ml' }, (performance.now() - started) / 1000);
      this.recordFailure(error);
      return this.fallbackScore(input, error instanceof Error ? error.message : 'unknown-error');
    }
  }

  private beginAttempt(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.config.scoring.circuitBreaker.resetMs) return false;
      this.state = 'half-open';
    }
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  private async requestScore(input: ScoringInput): Promise<MlResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.config.scoring.mlTimeoutMs);
    try {
      const response = await fetch(
        `${this.config.scoring.mlServiceUrl.replace(/\/$/, '')}/api/v1/score`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            amountMajorUnits: input.transaction.amount.toMajorUnits(),
            features: input.features.features,
          }),
        },
      );
      if (!response.ok) throw new Error(`ml-service returned HTTP ${response.status}`);
      const body: unknown = await response.json();
      if (!isMlResponse(body)) throw new Error('ml-service returned an invalid response');
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  private combine(input: ScoringInput, response: MlResponse): ScoringResult {
    const ruleResult = evaluateRules(this.rules, input);
    const modelScore = RiskScore.of(response.score);
    const behavioural = RiskScore.of(computeBehaviouralScore(input.features));
    const riskFactors = ruleResult.triggered.map((rule) => ({
      reason: rule.reason,
      internal: { source: rule.ruleName, scoreContribution: rule.scoreContribution },
    }));
    if (response.score >= 0.5) {
      riskFactors.push({
        reason: 'The model identified elevated transaction risk',
        internal: { source: 'ml-model', scoreContribution: response.score },
      });
    }
    return {
      score: combineScores(
        { rules: ruleResult.combinedScore, model: modelScore, behavioural },
        this.config.policy.weights,
      ),
      riskFactors,
      provider: 'ml',
      modelVersion: response.modelVersion,
    };
  }

  private recordFailure(error: unknown): void {
    this.failures += 1;
    this.probeInFlight = false;
    if (
      this.state === 'half-open' ||
      this.failures >= this.config.scoring.circuitBreaker.threshold
    ) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
    this.logger.warn(
      { err: error, failures: this.failures, circuitState: this.state },
      'ML inference unavailable; using configured fallback',
    );
  }

  private async fallbackScore(input: ScoringInput, cause: string): Promise<ScoringResult> {
    this.logger.debug(
      { cause, circuitState: this.state },
      'Returning configured ML fallback score',
    );
    const result = await this.fallback.score(input);
    return { ...result, degradedReason: 'ML_UNAVAILABLE' };
  }
}

function isMlResponse(value: unknown): value is MlResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response['score'] === 'number' &&
    Number.isFinite(response['score']) &&
    response['score'] >= 0 &&
    response['score'] <= 1 &&
    typeof response['modelVersion'] === 'string' &&
    response['modelVersion'].length > 0
  );
}
