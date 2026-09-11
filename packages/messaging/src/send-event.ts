import type { Producer } from 'kafkajs';

/**
 * One message, keyed for partition ordering (ADR-006: "events are keyed
 * by the entity whose ordering matters"). `key` is a plain string —
 * kafkajs hashes it to a partition itself; callers never compute a
 * partition number directly.
 */
export async function sendEvent(
  producer: Producer,
  params: { readonly topic: string; readonly key: string; readonly value: unknown },
): Promise<void> {
  await producer.send({
    topic: params.topic,
    messages: [{ key: params.key, value: JSON.stringify(params.value) }],
  });
}
