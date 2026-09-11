import { loadConfig } from '@fraudguard/config';
import { createRedisClient } from '@fraudguard/feature-store';
import {
  consumeWithDlq,
  createConsumer,
  createKafkaClient,
  createProducer,
} from '@fraudguard/messaging';
import {
  getPreloadedTracingHandle,
  registerDefaultMetrics,
  runWithExtractedContext,
  withSpan,
} from '@fraudguard/observability';
import {
  AuditRepository,
  CaseRepository,
  closePersistenceContext,
  createPersistenceContext,
  OutboxRepository,
} from '@fraudguard/persistence';

import { createLogger } from './common/logger';
import { startMetricsServer } from './common/metrics-server';
import { handleAuditableEvent } from './consumers/audit-consumer';
import { handleTransactionDecidedForCaseCreation } from './consumers/case-creation-consumer';
import { handleTransactionDecided } from './consumers/feature-update-consumer';
import { startKafkaLagPoller } from './metrics/kafka-lag-poller';
import { startOutboxGaugePoller } from './metrics/outbox-gauge-poller';
import { startOutboxRelay } from './relay/outbox-relay';

/** ASSUMED — no measured SLO to tune this against yet; matches Prometheus's own 15s scrape_interval (infrastructure/monitoring/prometheus/prometheus.yml), so the gauge is never more than one scrape behind a fresh poll regardless. */
const LAG_POLL_INTERVAL_MS = 15_000;

/**
 * The cold path (ADR-001): the outbox relay plus three independent Kafka
 * consumer groups (feature-update, case-creation, audit) — each its own
 * consumer group (kafka-topics.md: "so one slow or failed consumer never
 * blocks another from processing the same topic"), all in one process
 * for this prototype's scale (ARCHITECTURE.md §12 question 1, resolved
 * here: the relay lives inside event-worker, not a separate process —
 * nothing about this system's current load justifies the extra
 * deployable).
 *
 * Uses `coldDb`/`coldPool` exclusively — never `hotPool` — matching
 * ADR-004's bulkhead: this process's query load must never compete with
 * `fraud-api`'s hot-path connections.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);

  // The tracer provider itself was already started by tracing-preload.js
  // (`-r`'d before this file ever loads) — see that file and
  // packages/observability/preload-tracing.js's doc comments for why.
  const tracing = getPreloadedTracingHandle();
  registerDefaultMetrics();
  const metricsServer = startMetricsServer(config.ports.eventWorkerMetrics);

  const persistence = createPersistenceContext(config);
  const redis = createRedisClient(config);

  const kafka = createKafkaClient(config);
  // One producer, shared by the relay (publishing real events) and every
  // consumer below (publishing to their own DLQ on exhausted retries) —
  // kafkajs producers are safe to reuse across call sites once connected.
  const producer = createProducer(kafka);
  await producer.connect();
  const admin = kafka.admin();
  await admin.connect();

  const outboxRepository = new OutboxRepository(persistence.coldDb);
  const caseRepository = new CaseRepository(persistence.coldDb);
  const auditRepository = new AuditRepository(persistence.coldDb);

  const relay = startOutboxRelay({
    outboxRepository,
    producer,
    logger,
    batchSize: config.outbox.batchSize,
    pollIntervalMs: config.outbox.pollIntervalMs,
  });
  const outboxGaugePoller = startOutboxGaugePoller({
    outboxRepository,
    logger,
    intervalMs: config.outbox.pollIntervalMs,
  });

  const featureUpdateGroup = `${config.kafka.consumerGroup}.feature-update`;
  const caseCreationGroup = `${config.kafka.consumerGroup}.case-creation`;
  const auditGroup = `${config.kafka.consumerGroup}.audit`;

  const featureUpdateConsumer = createConsumer(kafka, featureUpdateGroup);
  const caseCreationConsumer = createConsumer(kafka, caseCreationGroup);
  const auditConsumer = createConsumer(kafka, auditGroup);

  const lagPoller = startKafkaLagPoller({
    admin,
    groupIds: [featureUpdateGroup, caseCreationGroup, auditGroup],
    intervalMs: LAG_POLL_INTERVAL_MS,
    logger,
  });

  await Promise.all([
    featureUpdateConsumer.connect(),
    caseCreationConsumer.connect(),
    auditConsumer.connect(),
  ]);

  await Promise.all([
    consumeWithDlq({
      consumer: featureUpdateConsumer,
      producer,
      topics: ['transaction.decided'],
      maxAttempts: 3, // kafka-topics.md: transaction.decided's per-consumer-group retry budget
      logger,
      // `headers['traceparent']` is the ORIGINAL request's trace — set by
      // the relay from `outbox_events.trace_context` (migration 0003).
      // Extracting it here, before starting this handler's own span,
      // is what keeps feature-update processing part of the SAME trace
      // the original HTTP request started, not a disconnected new one.
      handler: (payload, _key, _topic, headers) =>
        runWithExtractedContext(headers['traceparent'], () =>
          withSpan(
            'kafka.consume.feature_update',
            { 'messaging.destination': 'transaction.decided' },
            () => handleTransactionDecided(redis, payload),
          ),
        ),
    }),
    consumeWithDlq({
      consumer: caseCreationConsumer,
      producer,
      topics: ['transaction.decided'],
      maxAttempts: 3,
      logger,
      handler: (payload, _key, _topic, headers) =>
        runWithExtractedContext(headers['traceparent'], () =>
          withSpan(
            'kafka.consume.case_creation',
            { 'messaging.destination': 'transaction.decided' },
            () => handleTransactionDecidedForCaseCreation(caseRepository, payload, logger),
          ),
        ),
    }),
    consumeWithDlq({
      consumer: auditConsumer,
      producer,
      topics: ['transaction.received', 'transaction.decided', 'review.created', 'review.completed'],
      maxAttempts: 5, // kafka-topics.md: audit's retry budget is higher than other topics' — "an audit write failing is more consequential than a feature update failing"
      logger,
      handler: (payload, _key, topic, headers) =>
        runWithExtractedContext(headers['traceparent'], () =>
          withSpan('kafka.consume.audit', { 'messaging.destination': topic }, () =>
            handleAuditableEvent(auditRepository, topic, payload),
          ),
        ),
    }),
  ]);

  logger.info(
    'event-worker started: outbox relay + 3 consumer groups (feature-update, case-creation, audit)',
  );

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'event-worker shutting down');
    relay.stop();
    outboxGaugePoller.stop();
    lagPoller.stop();
    await Promise.all([
      featureUpdateConsumer.disconnect(),
      caseCreationConsumer.disconnect(),
      auditConsumer.disconnect(),
      admin.disconnect(),
      producer.disconnect(),
    ]);
    await closePersistenceContext(persistence);
    redis.disconnect();
    metricsServer.close();
    await tracing.shutdown();
    process.exit(0);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- startup failure, before the structured logger necessarily exists
  console.error('event-worker failed to start:', error);
  process.exitCode = 1;
});
