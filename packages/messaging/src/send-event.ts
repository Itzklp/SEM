import type { Producer } from 'kafkajs';

/**
 * One message, keyed for partition ordering (ADR-006: "events are keyed
 * by the entity whose ordering matters"). `key` is a plain string —
 * kafkajs hashes it to a partition itself; callers never compute a
 * partition number directly.
 *
 * `headers` is a plain string map, not a tracing-specific type — this
 * package stays unaware of what `traceparent` even is (ADR-004 layering:
 * `@fraudguard/messaging` does not depend on `@fraudguard/observability`,
 * the same reasoning as its existing no-dependency-on-`@fraudguard/contracts`).
 * `apps/event-worker`'s relay is the caller that actually knows to pass
 * `{ traceparent: row.traceContext }`.
 */
export async function sendEvent(
  producer: Producer,
  params: {
    readonly topic: string;
    readonly key: string;
    readonly value: unknown;
    readonly headers?: Record<string, string>;
  },
): Promise<void> {
  await producer.send({
    topic: params.topic,
    messages: [
      {
        key: params.key,
        value: JSON.stringify(params.value),
        ...(params.headers ? { headers: params.headers } : {}),
      },
    ],
  });
}
