import { configuredEnvSchema, type RawEnv } from './env.schema';

/**
 * Thrown by `loadConfig()` on any invalid or missing environment variable.
 * Named and typed (CONTRIBUTING.md: no bare `throw new Error(string)`) so a
 * process bootstrap can catch it specifically and exit with a clear
 * message, rather than crash on the first `undefined.toString()` deep
 * inside a request handler minutes later.
 */
export class ConfigValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * The shape application code actually imports and uses — grouped by
 * concern rather than the flat SCREAMING_SNAKE_CASE env-var shape. Mirrors
 * the section headings in `.env.example` one-to-one, so the two stay easy
 * to keep in sync by inspection.
 */
export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly logging: { readonly level: RawEnv['LOG_LEVEL']; readonly pretty: boolean };

  readonly ports: {
    readonly fraudApi: number;
    readonly reviewApi: number;
    readonly mlService: number;
    readonly eventWorkerMetrics: number;
  };
  readonly maxOldSpaceMb: number;

  readonly postgres: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly ssl: boolean;
    readonly poolHotMax: number;
    readonly poolColdMax: number;
    readonly statementTimeoutMs: number;
  };

  readonly redis: {
    readonly host: string;
    readonly port: number;
    readonly password: string;
    readonly db: number;
    readonly keyPrefix: string;
    readonly timeoutMs: number;
    readonly maxRetries: number;
  };

  readonly kafka: {
    readonly brokers: readonly string[];
    readonly clientId: string;
    readonly consumerGroup: string;
    readonly ssl: boolean;
    readonly sasl: {
      readonly mechanism: string;
      readonly username: string;
      readonly password: string;
    } | null;
    readonly topicPartitions: number;
    /** ADR-001 §"Documented substitutions": 1 locally (single KRaft broker); must be >=3 on any multi-broker deployment. */
    readonly topicReplicationFactor: number;
  };

  readonly outbox: {
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly maxAttempts: number;
    readonly retentionHours: number;
  };

  readonly scoring: {
    readonly provider: RawEnv['SCORING_PROVIDER'];
    readonly mlServiceUrl: string;
    readonly mlTimeoutMs: number;
    readonly circuitBreaker: { readonly threshold: number; readonly resetMs: number };
    readonly fallbackProvider: RawEnv['ML_FALLBACK_PROVIDER'];
  };

  readonly policy: {
    readonly version: string;
    readonly allowMax: number;
    readonly blockMin: number;
    readonly degraded: { readonly allowMax: number; readonly blockMin: number };
    readonly weights: {
      readonly rules: number;
      readonly model: number;
      readonly behavioural: number;
    };
  };

  /** FR-003: every rule's threshold, as data — apps/fraud-api's composition root builds the six `FraudRule` instances from this. */
  readonly rules: {
    readonly velocity: { readonly max5m: number; readonly max1h: number };
    readonly amountDeviation: { readonly multiplier: number };
    readonly deviceRisk: { readonly maxDeviceTransactions: number };
    readonly geographicAnomaly: { readonly maxDistinctLocations24h: number };
    readonly failedAttempt: { readonly maxFailed10m: number };
    readonly merchantRisk: { readonly riskThreshold: number };
  };

  readonly security: {
    readonly jwt: {
      readonly secret: string;
      readonly issuer: string;
      readonly audience: string;
      readonly ttlSeconds: number;
    };
    readonly rateLimit: { readonly windowMs: number; readonly maxRequests: number };
    readonly maxConcurrentRequests: number;
  };

  readonly observability: {
    readonly metricsEnabled: boolean;
    readonly metricsPath: string;
    readonly otel: {
      readonly enabled: boolean;
      readonly serviceName: string;
      readonly otlpEndpoint: string;
      readonly tracesSamplerArg: number;
    };
  };

  readonly generator: {
    readonly seed: number;
    readonly userCount: number;
    readonly merchantCount: number;
    readonly deviceCount: number;
    readonly fraudRate: number;
  };
}

function toAppConfig(env: RawEnv): AppConfig {
  return {
    env: env.NODE_ENV,
    logging: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },
    ports: {
      fraudApi: env.FRAUD_API_PORT,
      reviewApi: env.REVIEW_API_PORT,
      mlService: env.ML_SERVICE_PORT,
      eventWorkerMetrics: env.EVENT_WORKER_METRICS_PORT,
    },
    maxOldSpaceMb: env.NODE_MAX_OLD_SPACE_MB,
    postgres: {
      host: env.POSTGRES_HOST,
      port: env.POSTGRES_PORT,
      database: env.POSTGRES_DB,
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      ssl: env.POSTGRES_SSL,
      poolHotMax: env.POSTGRES_POOL_HOT_MAX,
      poolColdMax: env.POSTGRES_POOL_COLD_MAX,
      statementTimeoutMs: env.POSTGRES_STATEMENT_TIMEOUT_MS,
    },
    redis: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      db: env.REDIS_DB,
      keyPrefix: env.REDIS_KEY_PREFIX,
      timeoutMs: env.REDIS_TIMEOUT_MS,
      maxRetries: env.REDIS_MAX_RETRIES,
    },
    kafka: {
      brokers: env.KAFKA_BROKERS.split(',').map((b) => b.trim()),
      clientId: env.KAFKA_CLIENT_ID,
      consumerGroup: env.KAFKA_CONSUMER_GROUP,
      ssl: env.KAFKA_SSL,
      sasl: env.KAFKA_SASL_MECHANISM
        ? {
            mechanism: env.KAFKA_SASL_MECHANISM,
            username: env.KAFKA_SASL_USERNAME,
            password: env.KAFKA_SASL_PASSWORD,
          }
        : null,
      topicPartitions: env.KAFKA_TOPIC_PARTITIONS,
      topicReplicationFactor: env.KAFKA_TOPIC_REPLICATION_FACTOR,
    },
    outbox: {
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
      retentionHours: env.OUTBOX_RETENTION_HOURS,
    },
    scoring: {
      provider: env.SCORING_PROVIDER,
      mlServiceUrl: env.ML_SERVICE_URL,
      mlTimeoutMs: env.ML_TIMEOUT_MS,
      circuitBreaker: {
        threshold: env.ML_CIRCUIT_BREAKER_THRESHOLD,
        resetMs: env.ML_CIRCUIT_BREAKER_RESET_MS,
      },
      fallbackProvider: env.ML_FALLBACK_PROVIDER,
    },
    policy: {
      version: env.POLICY_VERSION,
      allowMax: env.POLICY_ALLOW_MAX,
      blockMin: env.POLICY_BLOCK_MIN,
      degraded: {
        allowMax: env.POLICY_DEGRADED_ALLOW_MAX,
        blockMin: env.POLICY_DEGRADED_BLOCK_MIN,
      },
      weights: {
        rules: env.SCORE_WEIGHT_RULES,
        model: env.SCORE_WEIGHT_MODEL,
        behavioural: env.SCORE_WEIGHT_BEHAVIOURAL,
      },
    },
    rules: {
      velocity: { max5m: env.RULE_VELOCITY_MAX_5M, max1h: env.RULE_VELOCITY_MAX_1H },
      amountDeviation: { multiplier: env.RULE_AMOUNT_DEVIATION_MULTIPLIER },
      deviceRisk: { maxDeviceTransactions: env.RULE_DEVICE_MAX_TRANSACTIONS },
      geographicAnomaly: { maxDistinctLocations24h: env.RULE_GEO_MAX_DISTINCT_LOCATIONS_24H },
      failedAttempt: { maxFailed10m: env.RULE_FAILED_MAX_10M },
      merchantRisk: { riskThreshold: env.RULE_MERCHANT_RISK_THRESHOLD },
    },
    security: {
      jwt: {
        secret: env.AUTH_JWT_SECRET,
        issuer: env.AUTH_JWT_ISSUER,
        audience: env.AUTH_JWT_AUDIENCE,
        ttlSeconds: env.AUTH_TOKEN_TTL_SECONDS,
      },
      rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, maxRequests: env.RATE_LIMIT_MAX_REQUESTS },
      maxConcurrentRequests: env.MAX_CONCURRENT_REQUESTS,
    },
    observability: {
      metricsEnabled: env.METRICS_ENABLED,
      metricsPath: env.METRICS_PATH,
      otel: {
        enabled: env.OTEL_ENABLED,
        serviceName: env.OTEL_SERVICE_NAME,
        otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
        tracesSamplerArg: env.OTEL_TRACES_SAMPLER_ARG,
      },
    },
    generator: {
      seed: env.SEED,
      userCount: env.GENERATOR_USER_COUNT,
      merchantCount: env.GENERATOR_MERCHANT_COUNT,
      deviceCount: env.GENERATOR_DEVICE_COUNT,
      fraudRate: env.GENERATOR_FRAUD_RATE,
    },
  };
}

/**
 * Parses `process.env` (or a supplied source, for testing) into a validated
 * `AppConfig`. Call this once, at process startup, before anything else —
 * "Fail Fast": a misconfigured process should refuse to accept its first
 * request rather than fail unpredictably on some later one.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configuredEnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigValidationError(issues);
  }
  return toAppConfig(result.data);
}
