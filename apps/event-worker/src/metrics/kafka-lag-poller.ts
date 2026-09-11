import type { Admin } from '@fraudguard/messaging';
import { kafkaConsumerLag } from '@fraudguard/observability';
import type { Logger } from 'pino';

export interface LagPollerOptions {
  readonly admin: Admin;
  readonly groupIds: readonly string[];
  readonly intervalMs: number;
  readonly logger: Logger;
}

export interface PollerHandle {
  readonly stop: () => void;
}

/**
 * `kafka_consumer_lag` (NFR-011's golden signals: "consumer lag"). Polled
 * on a timer via the Kafka admin client, not derived from `eachMessage`
 * callbacks — computing lag per message would mean an admin round trip
 * per message, which both defeats the point of a cheap gauge and adds
 * load to the one consumer path (ADR-005: the cold path tolerates lag,
 * it should not itself be the cause of more of it).
 *
 * `fetchOffsets({ groupId })` with no `topics` argument returns committed
 * offsets for every topic the group currently has offsets for — this
 * deliberately does not hardcode each group's topic list a second time
 * (main.ts's `consumeWithDlq` calls are the one place that list lives),
 * which would drift the moment either list changed without the other.
 */
export function startKafkaLagPoller(options: LagPollerOptions): PollerHandle {
  const state: { stopped: boolean; timer: ReturnType<typeof setTimeout> | undefined } = {
    stopped: false,
    timer: undefined,
  };

  async function pollOnce(): Promise<void> {
    for (const groupId of options.groupIds) {
      const offsetsByTopic = await options.admin.fetchOffsets({ groupId });
      for (const { topic, partitions } of offsetsByTopic) {
        const watermarks = await options.admin.fetchTopicOffsets(topic);
        const watermarkByPartition = new Map(
          watermarks.map((w) => [w.partition, Number(w.offset)]),
        );
        let lag = 0;
        for (const partitionOffset of partitions) {
          const committed = Number(partitionOffset.offset);
          if (committed < 0) {
            // No committed offset yet for this partition (group just
            // started, never consumed it) — nothing meaningful to report.
            continue;
          }
          const highWatermark = watermarkByPartition.get(partitionOffset.partition) ?? committed;
          lag += Math.max(0, highWatermark - committed);
        }
        kafkaConsumerLag.set({ group: groupId, topic }, lag);
      }
    }
  }

  async function loop(): Promise<void> {
    if (state.stopped) {
      return;
    }
    try {
      await pollOnce();
    } catch (error) {
      options.logger.warn({ err: error }, 'Kafka lag poll cycle failed — retried next tick');
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- same cross-closure-mutation-across-an-await limitation documented in outbox-relay.ts's identical loop.
    if (!state.stopped) {
      state.timer = setTimeout(() => void loop(), options.intervalMs);
    }
  }

  void loop();

  return {
    stop: () => {
      state.stopped = true;
      if (state.timer) {
        clearTimeout(state.timer);
      }
    },
  };
}
