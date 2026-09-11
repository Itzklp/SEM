import { z } from 'zod';

/**
 * `z.coerce.boolean()` is a trap for env vars: it just calls `Boolean(value)`,
 * and `Boolean("false")` is `true` — every non-empty string is truthy. An
 * env var explicitly set to `"false"` would silently coerce to `true`. This
 * preprocesses the actual string content instead, case-insensitively, so
 * `"false"`/`"FALSE"`/`"0"` all mean false and anything else falls through
 * to the (real, non-string) boolean schema for a clear validation error
 * rather than a silent wrong answer.
 */
function booleanEnv(defaultValue: boolean) {
  return z
    .preprocess((val) => {
      if (typeof val !== 'string') return val;
      const normalised = val.trim().toLowerCase();
      if (normalised === 'true' || normalised === '1') return true;
      if (normalised === 'false' || normalised === '0') return false;
      return val;
    }, z.boolean())
    .default(defaultValue);
}

/**
 * Schema over the RAW process.env shape. Every variable here must also
 * appear in `.env.example` — that file is the human-facing reference, this
 * schema is what's actually enforced at process startup.
 *
 * Fail Fast principle: an app that starts with a missing or malformed
 * variable is worse than one that refuses to start, because the failure
 * then surfaces later, mid-request, as a much harder to diagnose bug (e.g.
 * `NaN` silently propagating into a Redis TTL). `loadConfig()` in
 * `load-config.ts` is what turns a schema failure into a clear startup
 * error naming every offending variable at once.
 */
export const rawEnvSchema = z.object({
  // --- Runtime -------------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanEnv(false),

  // --- Services --------------------------------------------------------------
  FRAUD_API_PORT: z.coerce.number().int().positive().default(3000),
  REVIEW_API_PORT: z.coerce.number().int().positive().default(3001),
  ML_SERVICE_PORT: z.coerce.number().int().positive().default(8000),
  NODE_MAX_OLD_SPACE_MB: z.coerce.number().int().positive().default(512),

  // --- PostgreSQL (ADR-003: never read on the hot path) ---------------------
  POSTGRES_HOST: z.string().min(1).default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().min(1).default('fraudguard'),
  POSTGRES_USER: z.string().min(1).default('fraudguard'),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_SSL: booleanEnv(false),
  POSTGRES_POOL_HOT_MAX: z.coerce.number().int().positive().default(10),
  POSTGRES_POOL_COLD_MAX: z.coerce.number().int().positive().default(5),
  POSTGRES_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(100),

  // --- Redis (ADR-002: sole hot-path feature store) --------------------------
  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().default(''),
  REDIS_DB: z.coerce.number().int().nonnegative().default(0),
  REDIS_KEY_PREFIX: z.string().default('fg:'),
  REDIS_TIMEOUT_MS: z.coerce.number().int().positive().default(20),
  REDIS_MAX_RETRIES: z.coerce.number().int().nonnegative().default(0),

  // --- Kafka (ADR-001: cold path only) ---------------------------------------
  KAFKA_BROKERS: z.string().min(1).default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().min(1).default('fraudguard'),
  KAFKA_CONSUMER_GROUP: z.string().min(1).default('fraudguard-workers'),
  KAFKA_SSL: booleanEnv(false),
  KAFKA_SASL_MECHANISM: z.string().default(''),
  KAFKA_SASL_USERNAME: z.string().default(''),
  KAFKA_SASL_PASSWORD: z.string().default(''),
  KAFKA_TOPIC_PARTITIONS: z.coerce.number().int().positive().default(3),
  KAFKA_TOPIC_REPLICATION_FACTOR: z.coerce.number().int().positive().default(1),

  // --- Outbox relay (ADR-006) -------------------------------------------------
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  OUTBOX_RETENTION_HOURS: z.coerce.number().int().positive().default(24),

  // --- Scoring provider (CON-005) --------------------------------------------
  // Default is 'rules' as of Phase 5: RuleBasedScoringProvider is the
  // system's real, demonstrable, zero-ML scorer (docs/ROADMAP.md Phase 5
  // gate). 'stub' remains available and meaningful on its own — a
  // genuinely simpler deterministic baseline, not a discarded Phase 3
  // leftover — but it is no longer the intended default now that a
  // complete scorer exists. 'ml' is not yet implemented (Phase 10) and
  // will fail at provider construction if selected — see
  // scoring-provider.factory.ts in apps/fraud-api.
  SCORING_PROVIDER: z.enum(['stub', 'rules', 'ml']).default('rules'),
  ML_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  ML_TIMEOUT_MS: z.coerce.number().int().positive().default(30),
  ML_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  ML_CIRCUIT_BREAKER_RESET_MS: z.coerce.number().int().positive().default(10_000),
  ML_FALLBACK_PROVIDER: z.enum(['stub', 'rules']).default('rules'),

  // --- Risk policy (initial prototype values — ADR-005) ----------------------
  POLICY_VERSION: z.string().min(1).default('policy-v1'),
  POLICY_ALLOW_MAX: z.coerce.number().min(0).max(1).default(0.4),
  POLICY_BLOCK_MIN: z.coerce.number().min(0).max(1).default(0.75),
  POLICY_DEGRADED_ALLOW_MAX: z.coerce.number().min(0).max(1).default(0.25),
  POLICY_DEGRADED_BLOCK_MIN: z.coerce.number().min(0).max(1).default(0.85),
  SCORE_WEIGHT_RULES: z.coerce.number().min(0).max(1).default(0.5),
  SCORE_WEIGHT_MODEL: z.coerce.number().min(0).max(1).default(0.35),
  SCORE_WEIGHT_BEHAVIOURAL: z.coerce.number().min(0).max(1).default(0.15),

  // --- Rule thresholds (FR-003) — "declared as data/config, not embedded
  // in controllers". Every default here is an explicit, documented
  // ASSUMPTION (@fraudguard/domain's rule files carry the same note) —
  // there is no labelled fraud dataset in this project's scope to tune
  // against. Revisit with measurement once demo/load traffic exists.
  RULE_VELOCITY_MAX_5M: z.coerce.number().positive().default(10),
  RULE_VELOCITY_MAX_1H: z.coerce.number().positive().default(20),
  RULE_AMOUNT_DEVIATION_MULTIPLIER: z.coerce.number().positive().default(5),
  RULE_DEVICE_MAX_TRANSACTIONS: z.coerce.number().positive().default(50),
  RULE_GEO_MAX_DISTINCT_LOCATIONS_24H: z.coerce.number().positive().default(4),
  RULE_FAILED_MAX_10M: z.coerce.number().positive().default(3),
  RULE_MERCHANT_RISK_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),

  // --- Security ---------------------------------------------------------------
  AUTH_JWT_SECRET: z.string().min(32, 'AUTH_JWT_SECRET must be at least 32 characters'),
  AUTH_JWT_ISSUER: z.string().min(1).default('fraudguard'),
  AUTH_JWT_AUDIENCE: z.string().min(1).default('fraudguard-api'),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(1000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  MAX_CONCURRENT_REQUESTS: z.coerce.number().int().positive().default(500),

  // --- Observability ------------------------------------------------------------
  METRICS_ENABLED: booleanEnv(true),
  METRICS_PATH: z.string().min(1).default('/metrics'),
  OTEL_ENABLED: booleanEnv(true),
  OTEL_SERVICE_NAME: z.string().min(1).default('fraud-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://localhost:4318'),
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(0.1),

  // --- Synthetic data generator (FR-018) ----------------------------------------
  SEED: z.coerce.number().int().default(42),
  GENERATOR_USER_COUNT: z.coerce.number().int().positive().default(10_000),
  GENERATOR_MERCHANT_COUNT: z.coerce.number().int().positive().default(500),
  GENERATOR_DEVICE_COUNT: z.coerce.number().int().positive().default(15_000),
  GENERATOR_FRAUD_RATE: z.coerce.number().min(0).max(1).default(0.02),
});

const WEIGHT_SUM_TOLERANCE = 1e-6;

/**
 * Cross-field invariants that a per-field schema cannot express alone.
 * These mirror the checks in `@fraudguard/domain`'s `isValidRiskPolicy`
 * (score-weight-sum and degraded-strictness), duplicated deliberately
 * rather than imported: `packages/config` has no workspace dependencies by
 * design, so it can be loaded standalone, as early in a process's startup
 * as possible, before anything else has resolved.
 */
export const configuredEnvSchema = rawEnvSchema.superRefine((env, ctx) => {
  const weightSum = env.SCORE_WEIGHT_RULES + env.SCORE_WEIGHT_MODEL + env.SCORE_WEIGHT_BEHAVIOURAL;
  if (Math.abs(weightSum - 1) > WEIGHT_SUM_TOLERANCE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SCORE_WEIGHT_RULES'],
      message: `SCORE_WEIGHT_RULES + SCORE_WEIGHT_MODEL + SCORE_WEIGHT_BEHAVIOURAL must sum to 1.0 (got ${weightSum})`,
    });
  }

  if (env.POLICY_ALLOW_MAX >= env.POLICY_BLOCK_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['POLICY_ALLOW_MAX'],
      message:
        'POLICY_ALLOW_MAX must be strictly less than POLICY_BLOCK_MIN (there must be a REVIEW band)',
    });
  }

  // ADR-005: degraded mode must be at least as strict as healthy mode —
  // an outage must never make the policy MORE permissive.
  if (env.POLICY_DEGRADED_ALLOW_MAX > env.POLICY_ALLOW_MAX) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['POLICY_DEGRADED_ALLOW_MAX'],
      message:
        'POLICY_DEGRADED_ALLOW_MAX must not exceed POLICY_ALLOW_MAX (ADR-005: degraded mode must not be more permissive)',
    });
  }
  if (env.POLICY_DEGRADED_BLOCK_MIN < env.POLICY_BLOCK_MIN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['POLICY_DEGRADED_BLOCK_MIN'],
      message:
        'POLICY_DEGRADED_BLOCK_MIN must not be below POLICY_BLOCK_MIN (ADR-005: degraded mode must not be more permissive)',
    });
  }
});

export type RawEnv = z.infer<typeof rawEnvSchema>;
