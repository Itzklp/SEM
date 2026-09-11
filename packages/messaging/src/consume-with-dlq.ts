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

/** kafkajs decodes header values as `Buffer | string | (Buffer | string)[] | undefined` — normalised to a plain string map (first value if an array, omitted if absent) so callers (e.g. trace-context extraction) never have to think about the wire representation. */
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

/** kafka-init's naming convention: every catalogue topic has a matching `<topic>.dlq`. Generic enough to hardcode here (not fraud-specific), unlike `@fraudguard/contracts`' event-shape knowledge, which this package deliberately does not depend on. */
function dlqTopicFor(topic: string): string {
  return `${topic}.dlq`;
}

const BACKOFF_BASE_MS = 200; // ASSUMED — no measured SLO to tune this against yet
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
 * The retry+DLQ shape named per-topic in `docs/architecture/kafka-topics.md`
 * ("Retry strategy" / "Dead-letter strategy" rows), implemented once here
 * rather than reinvented per consumer. A malformed payload (fails to
 * parse as JSON) goes straight to the DLQ — no number of retries fixes a
 * message that was never valid JSON. A handler that throws (e.g. a
 * transient DB error) gets `maxAttempts` tries with jittered backoff
 * before the message is DLQ'd with its error attached.
 *
 * Retrying inside `eachMessage` — rather than nacking and relying on
 * Kafka redelivery — blocks this one partition for the duration of the
 * retries. Accepted deliberately: ADR-005 permits cold-path retries
 * (unlike the hot path), and a consumer's job is exactly to make
 * eventual progress through its partition, not to shed load the way
 * `fraud-api` does.
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
