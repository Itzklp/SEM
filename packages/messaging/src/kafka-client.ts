import type { AppConfig } from '@fraudguard/config';
import { Kafka, logLevel, type Producer, type Consumer } from 'kafkajs';

// Re-exported so callers (apps/event-worker) only ever need to depend on
// this package, never on `kafkajs` directly — one fewer place the exact
// client library is named outside this package's own boundary.
export type { Producer, Consumer };

/**
 * ADR-001: Kafka is cold-path only — nothing in `apps/fraud-api`'s hot
 * path imports this package (enforced by `tests/architecture/hot-path
 * .test.ts`'s import scan). Only `apps/event-worker` does.
 */
export function createKafkaClient(config: AppConfig): Kafka {
  return new Kafka({
    clientId: config.kafka.clientId,
    brokers: [...config.kafka.brokers],
    ssl: config.kafka.ssl,
    // `exactOptionalPropertyTypes` means `sasl: undefined` is not the
    // same as omitting `sasl` — spread conditionally rather than
    // assigning undefined, so the property is genuinely absent when
    // there's no SASL config, not present-with-an-undefined-value.
    ...(config.kafka.sasl !== null
      ? {
          sasl: {
            mechanism: config.kafka.sasl.mechanism as 'plain',
            username: config.kafka.sasl.username,
            password: config.kafka.sasl.password,
          },
        }
      : {}),
    // kafkajs is chatty at its default log level; the cold path already
    // has its own structured logging (pino, in event-worker) for what
    // actually matters — this just keeps stdout readable.
    logLevel: logLevel.WARN,
  });
}

export function createProducer(kafka: Kafka): Producer {
  // No idempotent-producer / exactly-once config here — ADR-006 is
  // explicit that this system claims at-least-once delivery, not
  // exactly-once, and configuring the wire-level idempotent producer
  // flag without also implementing transactional consumer offsets would
  // be exactly the "claiming a guarantee without building it" this
  // project forbids (Brief §19, §45).
  return kafka.producer();
}

export function createConsumer(kafka: Kafka, groupId: string): Consumer {
  return kafka.consumer({ groupId });
}
