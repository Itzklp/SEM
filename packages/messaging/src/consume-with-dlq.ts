import type { Consumer, Producer } from 'kafkajs';
import type { Logger } from 'pino';

import { sendEvent } from './send-event';

export interface ConsumeWithDlqOptions {
  readonly consumer: Consumer;
  /** Used only to publish to the DLQ topic on exhausted retries — this consumer never produces its own domain events. */
  readonly producer: Producer;
  readonly topics: readonly string[];
  readonly maxAttempts: number;
  readonly handler: (
    payload: unknown,
    messageKey: string | null,
    topic: string,
    headers: Record<string, string>,
  ) => Promise<void>;
  readonly logger: Logger;
}

/** Normalises kafkajs's Buffer|string|array|undefined header values to a plain string map. */
function decodeHeaders(
  raw: Record<string, Buffer | string | (Buffer | string)[] | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined) {
      headers[key] = single.toString();
    }
  }
  return headers;
}

/** Every catalogue topic has a matching `<topic>.dlq`, per kafka-init's naming convention. */
function dlqTopicFor(topic: string): string {
  return `${topic}.dlq`;
}

const BACKOFF_BASE_MS = 200; // no measured SLO to tune this against yet
const BACKOFF_MAX_MS = 5_000;

/** Exponential backoff with full jitter (ADR-005's resilience-pattern table: "cold path only... exponential backoff with full jitter"). */
function backoffMs(attempt: number): number {
  const capped = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.random() * capped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The retry+DLQ shape named per-topic in docs/architecture/kafka-topics.md,
 * implemented once here rather than reinvented per consumer. A malformed
 * payload goes straight to the DLQ — no retry fixes invalid JSON. A
 * handler that throws gets maxAttempts tries with jittered backoff first.
 *
 * Retries run inside eachMessage, blocking this partition for their
 * duration rather than nacking for Kafka redelivery — accepted per
 * ADR-005, which permits cold-path retries.
 */
export async function consumeWithDlq(options: ConsumeWithDlqOptions): Promise<void> {
  await options.consumer.subscribe({ topics: [...options.topics], fromBeginning: false });

  await options.consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const key = message.key?.toString() ?? null;
      const raw = message.value?.toString() ?? 'null';
      const headers = decodeHeaders(message.headers ?? {});

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch (parseError) {
        options.logger.error(
          { err: parseError, topic, partition },
          'Malformed message payload — moving straight to DLQ, no retry',
        );
        await sendToDlq(options, topic, key, raw, parseError);
        return;
      }

      let lastError: unknown;
      for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
        try {
          await options.handler(payload, key, topic, headers);
          return;
        } catch (error) {
          lastError = error;
          options.logger.warn(
            { err: error, topic, partition, attempt, maxAttempts: options.maxAttempts },
            'Consumer handler failed',
          );
          if (attempt < options.maxAttempts) {
            await sleep(backoffMs(attempt));
          }
        }
      }

      options.logger.error(
        { err: lastError, topic, partition },
        'Consumer handler exhausted retries — moving to DLQ',
      );
      await sendToDlq(options, topic, key, payload, lastError);
    },
  });
}

async function sendToDlq(
  options: ConsumeWithDlqOptions,
  originalTopic: string,
  key: string | null,
  payload: unknown,
  error: unknown,
): Promise<void> {
  await sendEvent(options.producer, {
    topic: dlqTopicFor(originalTopic),
    key: key ?? 'unknown',
    value: {
      originalTopic,
      payload,
      error: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(),
    },
  });
}
