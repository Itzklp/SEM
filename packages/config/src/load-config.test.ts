import { loadConfig, ConfigValidationError } from './load-config';

/** The minimum set of variables that have no default and must be supplied. */
function requiredEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    POSTGRES_PASSWORD: 'local_dev_only',
    AUTH_JWT_SECRET: 'x'.repeat(48),
    ...overrides,
  };
}

describe('loadConfig', () => {
  // What: a minimal-but-complete environment loads successfully with sane defaults.
  // Why: this is what CI and every developer's first `pnpm dev` depends on.
  it('loads successfully with required variables and default values applied', () => {
    const config = loadConfig(requiredEnv());
    expect(config.env).toBe('development');
    expect(config.postgres.password).toBe('local_dev_only');
    expect(config.ports.fraudApi).toBe(3000);
    expect(config.ports.eventWorkerMetrics).toBe(9100);
    expect(config.kafka.topicReplicationFactor).toBe(1);
  });

  // What: the scoring provider defaults to the real zero-ML scorer.
  // Why: Phase 5's gate is "fully functional... with zero ML code in
  //      existence" — that has to be what a fresh checkout actually runs,
  //      not an opt-in a developer has to discover.
  it('defaults SCORING_PROVIDER to "rules", not "stub" or "ml"', () => {
    expect(loadConfig(requiredEnv()).scoring.provider).toBe('rules');
  });

  // What: every rule threshold loads as data, with defaults, and is
  //       overridable like any other config value.
  // Why: FR-003 — "declared as data/config, not embedded in controllers".
  it('loads rule thresholds with defaults, overridable via env', () => {
    const defaults = loadConfig(requiredEnv());
    expect(defaults.rules.velocity.max5m).toBe(10);
    expect(defaults.rules.merchantRisk.riskThreshold).toBe(0.7);

    const overridden = loadConfig(requiredEnv({ RULE_VELOCITY_MAX_5M: '3' }));
    expect(overridden.rules.velocity.max5m).toBe(3);
  });

  // What: a required variable with no default is missing.
  // Why: "Fail Fast" (Brief §7) — a process must refuse to start rather
  //      than crash unpredictably on the first request that needs it.
  it('throws ConfigValidationError when a required variable is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigValidationError);
  });

  // What: the thrown error names every invalid variable, not just the first.
  // Why: a developer fixing one variable at a time and re-running is far
  //      slower than seeing the whole list once.
  it('aggregates every validation issue into a single error', () => {
    expect.assertions(3);
    try {
      loadConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      const issues = (error as ConfigValidationError).issues;
      expect(issues.some((i) => i.includes('POSTGRES_PASSWORD'))).toBe(true);
      expect(issues.some((i) => i.includes('AUTH_JWT_SECRET'))).toBe(true);
    }
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => loadConfig(requiredEnv({ AUTH_JWT_SECRET: 'too-short' }))).toThrow(
      ConfigValidationError,
    );
  });

  // What: score-combination weights that do not sum to 1.0.
  // Why: FR-005 requires the combined score to be meaningfully normalised —
  //      weights summing to, say, 1.3 would silently inflate every score.
  it('rejects score weights that do not sum to 1.0', () => {
    expect(() =>
      loadConfig(
        requiredEnv({
          SCORE_WEIGHT_RULES: '0.5',
          SCORE_WEIGHT_MODEL: '0.5',
          SCORE_WEIGHT_BEHAVIOURAL: '0.5',
        }),
      ),
    ).toThrow(ConfigValidationError);
  });

  it('accepts score weights within floating-point tolerance of 1.0', () => {
    expect(() =>
      loadConfig(
        requiredEnv({
          SCORE_WEIGHT_RULES: '0.5',
          SCORE_WEIGHT_MODEL: '0.35',
          SCORE_WEIGHT_BEHAVIOURAL: '0.15',
        }),
      ),
    ).not.toThrow();
  });

  // What: a degraded policy configured to be MORE permissive than the healthy one.
  // Why: ADR-005 cautious-open is a security control — this test protects
  //      it from a configuration mistake that would silently invert it
  //      (an outage becoming easier to exploit, not harder).
  it('rejects a degraded policy looser than the healthy policy', () => {
    expect(() =>
      loadConfig(
        requiredEnv({
          POLICY_ALLOW_MAX: '0.4',
          POLICY_BLOCK_MIN: '0.75',
          POLICY_DEGRADED_ALLOW_MAX: '0.6', // looser than healthy allowMax — must be rejected
          POLICY_DEGRADED_BLOCK_MIN: '0.85',
        }),
      ),
    ).toThrow(ConfigValidationError);
  });

  it('rejects a policy with no REVIEW band (allowMax >= blockMin)', () => {
    expect(() =>
      loadConfig(requiredEnv({ POLICY_ALLOW_MAX: '0.8', POLICY_BLOCK_MIN: '0.75' })),
    ).toThrow(ConfigValidationError);
  });

  it('parses a comma-separated Kafka broker list into an array', () => {
    const config = loadConfig(requiredEnv({ KAFKA_BROKERS: 'broker1:9092, broker2:9092' }));
    expect(config.kafka.brokers).toEqual(['broker1:9092', 'broker2:9092']);
  });

  // What: the literal string "false" parses to the boolean false.
  // Why: `z.coerce.boolean()` calls `Boolean(value)`, and `Boolean("false")`
  //      is `true` — every non-empty string is truthy. A .env file with
  //      POSTGRES_SSL=false would silently enable SSL. This bug was caught
  //      live: `pnpm db:migrate` failed against a non-SSL local Postgres
  //      with "The server does not support SSL connections" because
  //      POSTGRES_SSL=false in .env had coerced to true.
  // Catches: any boolean field regressing back to z.coerce.boolean().
  it.each([
    ['POSTGRES_SSL', 'postgres', 'ssl'],
    ['KAFKA_SSL', 'kafka', 'ssl'],
    ['LOG_PRETTY', 'logging', 'pretty'],
    ['METRICS_ENABLED', 'observability', 'metricsEnabled'],
  ] as const)('%s=false parses to false, not true', (envVar, section, field) => {
    const config = loadConfig(requiredEnv({ [envVar]: 'false' }));
    const sectionValue = config[section] as Record<string, unknown>;
    expect(sectionValue[field]).toBe(false);
  });

  it.each(['true', 'TRUE', '1'])('%s parses to true', (value) => {
    const config = loadConfig(requiredEnv({ POSTGRES_SSL: value }));
    expect(config.postgres.ssl).toBe(true);
  });

  it('rejects a boolean env var with a nonsensical value rather than guessing', () => {
    expect(() => loadConfig(requiredEnv({ POSTGRES_SSL: 'maybe' }))).toThrow(ConfigValidationError);
  });
});
