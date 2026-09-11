import { Counter, Gauge, Histogram } from 'prom-client';

import { registry } from './registry';

/**
 * The eleven metrics named in `docs/ROADMAP.md`'s Phase 7 deliverable
 * list, defined exactly once here so every app (`fraud-api`, `review-api`,
 * `event-worker`) observes the SAME metric object shape — a histogram
 * redefined per app with different buckets would make cross-service
 * dashboard panels meaningless. `ml_duration_seconds` is defined now,
 * honestly unused until Phase 10 (`MLScoringProvider` does not exist yet,
 * RISK-003) — it appears on `/metrics` with zero observations, which is
 * the correct, visible state for "not wired yet", not a missing metric.
 */

/** Inbound transactions received by `fraud-api`'s `/fraud/score`. `replay` distinguishes a fresh transactionId from an idempotent replay — not asked for by the roadmap's one-line description, but free and load-bearing for "how many of these are actually new work". */
export const transactionsTotal = new Counter({
  name: 'transactions_total',
  help: 'Total transactions received by fraud-api, labelled by whether the idempotency cache recognised it as a replay.',
  labelNames: ['replay'] as const,
  registers: [registry],
});

/** Every decision fraud-api's decision engine reaches. `degraded` is ADR-005's flag — ARCHITECTURE.md §8: "the proportion of degraded decisions is visible on the dashboard and can be alerted on." */
export const fraudDecisionsTotal = new Counter({
  name: 'fraud_decisions_total',
  help: 'Total fraud decisions, labelled by decision outcome and whether the decision was degraded.',
  labelNames: ['decision', 'degraded'] as const,
  registers: [registry],
});

/**
 * Per-stage hot-path timing — ADR-003's enforcement deliverable, folded
 * into this one histogram via the `stage` label rather than five
 * separately-named metrics, so a Grafana panel can show all five stages
 * stacked against the same time axis with one query. Bucket boundaries
 * are sub-millisecond-to-tens-of-milliseconds: ADR-003's hot-path budget
 * is measured in single-digit milliseconds per stage, and Prometheus
 * histogram quantiles are only as precise as the bucket they fall into.
 */
export const fraudScoreDurationSeconds = new Histogram({
  name: 'fraud_score_duration_seconds',
  help: 'Hot-path stage duration in seconds, labelled by stage (idempotency_check, feature_fetch, score, decide, persist).',
  labelNames: ['stage'] as const,
  buckets: [0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.032, 0.064, 0.128, 0.256],
  registers: [registry],
});

/** Golden signal: latency. Every HTTP response from fraud-api/review-api, via the Fastify plugin in `http-metrics.ts`. */
export const requestDurationSeconds = new Histogram({
  name: 'request_duration_seconds',
  help: 'HTTP request duration in seconds, labelled by method, route and status code.',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/** Golden signal: errors. A Counter, not derived from `request_duration_seconds`'s `status_code` label — PromQL *can* compute an error rate from the histogram alone, but a dedicated counter is what the roadmap names and what the alert rule in `alerts.yml` reads most simply. */
export const requestErrorsTotal = new Counter({
  name: 'request_errors_total',
  help: 'Total HTTP responses with a 4xx/5xx status code, labelled by method, route and status code.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

/** `event-worker` only — polled periodically (`kafka-lag-poller.ts`) via the Kafka admin client, not pushed per-message (computing lag per message would mean an admin round trip per message, defeating the point of a cheap gauge). */
export const kafkaConsumerLag = new Gauge({
  name: 'kafka_consumer_lag',
  help: 'Consumer group lag (high watermark minus committed offset, summed across partitions), labelled by consumer group and topic.',
  labelNames: ['group', 'topic'] as const,
  registers: [registry],
});

/** Golden signal: dependency latency (Redis side). `operation` distinguishes the feature-fetch read path from idempotency get/set and the feature-write path, across whichever app calls `@fraudguard/feature-store`. */
export const redisDurationSeconds = new Histogram({
  name: 'redis_duration_seconds',
  help: 'Redis operation duration in seconds, labelled by operation.',
  labelNames: ['operation'] as const,
  buckets: [0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.032, 0.064, 0.128],
  registers: [registry],
});

/** Golden signal: dependency latency (Postgres side). `operation` is the repository method name (e.g. `TransactionRepository.insertScored`) across whichever app calls `@fraudguard/persistence`. */
export const dbDurationSeconds = new Histogram({
  name: 'db_duration_seconds',
  help: 'PostgreSQL operation duration in seconds, labelled by operation.',
  labelNames: ['operation'] as const,
  buckets: [0.0005, 0.001, 0.002, 0.004, 0.008, 0.016, 0.032, 0.064, 0.128, 0.5, 1],
  registers: [registry],
});

/** Not observed anywhere until Phase 10 — see this file's doc comment. `provider` will distinguish the real ML inference call from any future fallback path. */
export const mlDurationSeconds = new Histogram({
  name: 'ml_duration_seconds',
  help: 'ML provider inference duration in seconds, labelled by provider. Unused until Phase 10 (RISK-003) — defined now so the metric contract does not change when MLScoringProvider lands.',
  labelNames: ['provider'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [registry],
});

/** Golden signal: saturation. Incremented on request start, decremented on completion — see `http-metrics.ts`. */
export const activeRequests = new Gauge({
  name: 'active_requests',
  help: 'Requests currently being handled, labelled by service.',
  labelNames: ['service'] as const,
  registers: [registry],
});

/** ADR-006's own words: "backlog depth is a directly measurable health signal." `event-worker` polls `OutboxRepository.countUnpublished()` on a timer (`outbox-gauge-poller.ts`) — this is NOT read on the hot path (ADR-003: fraud-api never queries this). */
export const outboxPendingTotal = new Gauge({
  name: 'outbox_pending_total',
  help: 'Outbox rows not yet published to Kafka.',
  registers: [registry],
});

/**
 * NOT one of the roadmap's eleven named metrics — added because
 * `alerts.yml`'s "review-queue depth" rule (also a named Phase 7
 * deliverable, ADR-005: "review-queue depth is a monitored, alertable
 * signal") has nothing to alert on without it. `review-api` polls
 * `CaseRepository.countByStatus('OPEN')` on a timer
 * (`apps/review-api/src/cases/queue-depth-poller.ts`), the one place that
 * already owns `fraud_cases` query access.
 */
export const reviewQueueDepth = new Gauge({
  name: 'review_queue_depth',
  help: 'Open fraud cases awaiting review.',
  registers: [registry],
});
