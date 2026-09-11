import { loadConfig } from '@fraudguard/config';
import { createRedisClient } from '@fraudguard/feature-store';
import {
  consumeWithDlq,
  createConsumer,
  createKafkaClient,
  createProducer,
} from '@fraudguard/messaging';
import {
  AuditRepository,
  CaseRepository,
  closePersistenceContext,
  createPersistenceContext,
  OutboxRepository,
} from '@fraudguard/persistence';

import { createLogger } from './common/logger';
import { handleAuditableEvent } from './consumers/audit-consumer';
import { handleTransactionDecidedForCaseCreation } from './consumers/case-creation-consumer';
import { handleTransactionDecided } from './consumers/feature-update-consumer';
import { startOutboxRelay } from './relay/outbox-relay';

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

  const persistence = createPersistenceContext(config);
  const redis = createRedisClient(config);

  const kafka = createKafkaClient(config);
  // One producer, shared by the relay (publishing real events) and every
  // consumer below (publishing to their own DLQ on exhausted retries) —
  // kafkajs producers are safe to reuse across call sites once connected.
  const producer = createProducer(kafka);
  await producer.connect();

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

  const featureUpdateConsumer = createConsumer(
    kafka,
    `${config.kafka.consumerGroup}.feature-update`,
  );
  const caseCreationConsumer = createConsumer(kafka, `${config.kafka.consumerGroup}.case-creation`);
  const auditConsumer = createConsumer(kafka, `${config.kafka.consumerGroup}.audit`);

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
      handler: async (payload) => {
        await handleTransactionDecided(redis, payload);
      },
    }),
    consumeWithDlq({
      consumer: caseCreationConsumer,
      producer,
      topics: ['transaction.decided'],
      maxAttempts: 3,
      logger,
      handler: async (payload) => {
        await handleTransactionDecidedForCaseCreation(caseRepository, payload, logger);
      },
    }),
    consumeWithDlq({
      consumer: auditConsumer,
      producer,
      topics: ['transaction.received', 'transaction.decided', 'review.created', 'review.completed'],
      maxAttempts: 5, // kafka-topics.md: audit's retry budget is higher than other topics' — "an audit write failing is more consequential than a feature update failing"
      logger,
      handler: async (payload, _key, topic) => {
        await handleAuditableEvent(auditRepository, topic, payload);
      },
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
    await Promise.all([
      featureUpdateConsumer.disconnect(),
      caseCreationConsumer.disconnect(),
      auditConsumer.disconnect(),
      producer.disconnect(),
    ]);
    await closePersistenceContext(persistence);
    redis.disconnect();
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
