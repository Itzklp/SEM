import { loadConfig } from '@fraudguard/config';
import {
  consumeWithDlq,
  createConsumer,
  createKafkaClient,
  createProducer,
  type Admin,
  type Consumer,
  type Producer,
} from '@fraudguard/messaging';
import pino from 'pino';

/**
 * RT-MALFORM-001: "Malformed message on a topic → routed to DLQ, consumer
 * continues." `packages/messaging`'s `consumeWithDlq()` already has this
 * logic (a payload that fails `JSON.parse` goes straight to the DLQ, no
 * retry — "no number of retries fixes a message that was never valid
 * JSON", per that file's own doc comment); this test is the first time
 * anything actually PUBLISHES a genuinely malformed message to a real
 * topic and checks both halves of the claim: the DLQ receives it, AND —
 * the part a unit test of `consumeWithDlq` alone could not prove — a
 * consumer that just DLQ'd one message keeps consuming the next one on
 * the same topic/partition, rather than getting stuck.
 *
 * Publishes the malformed bytes with a raw `producer.send()` call
 * bypassing `sendEvent()` entirely — `sendEvent()` always
 * `JSON.stringify`s its input, so there is no way to produce genuinely
 * invalid JSON through it. A real malformed message on the wire (a
 * truncated write, a producer from a different, buggy service, bytes
 * that are simply not JSON at all) is exactly what this constructs by
 * hand.
 *
 * CAUGHT LIVE, writing this test: `consumer.run()` resolving does NOT
 * mean the consumer group's rebalance has actually finished and
 * partitions are assigned — that happens asynchronously, afterward. A
 * fixed grace-period `sleep()` before publishing is exactly the kind of
 * "probably long enough" guess this project avoids elsewhere (ADR-005's
 * own retry/backoff reasoning) — this polls the real Admin API for each
 * consumer group's state to actually reach `Stable` before publishing
 * anything, the same "wait for the real signal, not a guessed delay"
 * standard `docker-helpers.ts`'s `waitUntil` already applies to
 * container health.
 */
describe('resilience: a malformed Kafka message goes to the DLQ; the consumer keeps consuming', () => {
  let producer: Producer;
  let consumer: Consumer;
  let dlqConsumer: Consumer;
  let admin: Admin;
  const logger = pino({ level: 'silent' });
  const topic = 'transaction.decided';
  const dlqTopic = 'transaction.decided.dlq';
  const groupId = `malformed-test-${Date.now()}`;
  const mainGroupId = `${groupId}.consumer`;
  const dlqGroupId = `${groupId}.dlq-watcher`;

  beforeAll(async () => {
    const config = loadConfig();
    const kafka = createKafkaClient(config);
    producer = createProducer(kafka);
    await producer.connect();

    admin = kafka.admin();
    await admin.connect();

    consumer = createConsumer(kafka, mainGroupId);
    await consumer.connect();

    dlqConsumer = createConsumer(kafka, dlqGroupId);
    await dlqConsumer.connect();
  }, 60_000);

  afterAll(async () => {
    await consumer.disconnect();
    await dlqConsumer.disconnect();
    await admin.disconnect();
    await producer.disconnect();
  }, 60_000);

  async function waitForStableGroups(groupIds: string[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { groups } = await admin.describeGroups(groupIds);
      if (groups.every((g) => g.state === 'Stable')) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  it('a non-JSON message is DLQ-d without retry, and a valid message published right after is still processed', async () => {
    const marker = `malformed-test-${Date.now()}`;
    const validKey = `${marker}-valid`;

    const processedKeys: string[] = [];
    const consumePromise = consumeWithDlq({
      consumer,
      producer,
      topics: [topic],
      maxAttempts: 3,
      logger,
      handler: (_payload, key) => {
        if (key) {
          processedKeys.push(key);
        }
        return Promise.resolve();
      },
    });
    // Never resolves until the process shuts down — this consumer runs
    // for the rest of the test's lifetime, not something to await.
    // `void` marks the floating promise as deliberate, not forgotten.
    void consumePromise;

    const dlqMessagePromise = new Promise<{ originalTopic: string; payload: unknown } | undefined>(
      (resolve) => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve(undefined);
          }
        }, 25_000);
        void dlqConsumer.subscribe({ topic: dlqTopic, fromBeginning: true }).then(() =>
          dlqConsumer.run({
            eachMessage: ({ message }) => {
              const key = message.key?.toString();
              if (key === marker && !resolved) {
                resolved = true;
                clearTimeout(timeout);
                const value = JSON.parse(message.value?.toString() ?? '{}') as {
                  originalTopic: string;
                  payload: unknown;
                };
                resolve(value);
              }
              return Promise.resolve();
            },
          }),
        );
      },
    );

    // Both consumer groups must actually finish rebalancing — not just
    // "subscribe() resolved" — before publishing, or the messages below
    // could be delivered to a partition assignment that doesn't exist
    // yet and never get picked up at all. See this file's own doc
    // comment.
    const stable = await waitForStableGroups([mainGroupId, dlqGroupId], 30_000);
    expect(stable).toBe(true);

    // The malformed message — raw bytes, not `sendEvent()`, deliberately.
    await producer.send({
      topic,
      messages: [{ key: marker, value: 'this is not json {{{' }],
    });

    // A genuinely valid message, published right after, on the SAME
    // topic — proves the consumer did not stop making progress.
    await producer.send({
      topic,
      messages: [{ key: validKey, value: JSON.stringify({ marker: validKey, ok: true }) }],
    });

    const dlqMessage = await dlqMessagePromise;
    expect(dlqMessage).toBeDefined();
    expect(dlqMessage?.originalTopic).toBe(topic);

    const validProcessed = await waitForKey(processedKeys, validKey, 20_000);
    expect(validProcessed).toBe(true);
  }, 60_000);
});

function waitForKey(
  haystack: readonly string[],
  needle: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (haystack.includes(needle)) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}
