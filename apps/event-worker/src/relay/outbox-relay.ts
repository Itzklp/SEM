import { sendEvent, type Producer } from '@fraudguard/messaging';
import type { BatchResult, OutboxRepository } from '@fraudguard/persistence';
import type { Logger } from 'pino';

export interface RunOnceOptions {
  readonly outboxRepository: OutboxRepository;
  readonly producer: Producer;
  readonly logger: Logger;
  readonly batchSize: number;
}

/**
 * One poll cycle — separated from the looping timer below so a test can
 * call this directly without fighting `setTimeout`. `row.payload` is
 * already the full event envelope (`build-outbox-events.ts` in
 * `apps/fraud-api` stores the parsed envelope, not just the inner
 * payload) — this function publishes it byte-for-byte, it does not
 * reconstruct or reinterpret it.
 */
export async function runOutboxRelayOnce(options: RunOnceOptions): Promise<BatchResult> {
  const result = await options.outboxRepository.processUnpublishedBatch(
    options.batchSize,
    async (row) => {
      try {
        await sendEvent(options.producer, {
          topic: row.topic,
          key: row.partitionKey,
          value: row.payload,
        });
        return { ok: true };
      } catch (error) {
        // Connection/broker-level failures (Kafka down) and genuine
        // per-row failures both land here — see OutboxRepository's doc
        // comment for why this always retries rather than dead-lettering:
        // a sustained Kafka outage must drain fully on recovery (Phase 6
        // exit criterion), which a give-up-after-N-attempts policy would
        // violate for exactly the scenario that matters.
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  if (result.publishedCount > 0 || result.failedCount > 0) {
    options.logger.info(
      { published: result.publishedCount, failed: result.failedCount },
      'Outbox relay poll cycle',
    );
  }
  return result;
}

export interface RelayHandle {
  readonly stop: () => void;
}

/** The actual long-running loop — `pnpm --filter event-worker dev`'s main.ts calls this once at startup. */
export function startOutboxRelay(
  options: RunOnceOptions & { readonly pollIntervalMs: number },
): RelayHandle {
  const state: { stopped: boolean; timer: ReturnType<typeof setTimeout> | undefined } = {
    stopped: false,
    timer: undefined,
  };

  async function loop(): Promise<void> {
    if (state.stopped) {
      return;
    }
    try {
      await runOutboxRelayOnce(options);
    } catch (error) {
      // processUnpublishedBatch itself throwing (e.g. the DB connection
      // is down) is a different failure mode than a publish failure
      // inside it — logged and retried next tick either way, since a
      // relay that stops polling because Postgres hiccuped once would
      // need a restart to recover, which defeats the point of polling.
      options.logger.error({ err: error }, 'Outbox relay poll cycle failed unexpectedly');
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a real check, not a false one: `stop()` (below) can flip `state.stopped` to true from outside this function while the `await` above was in flight. The linter's control-flow analysis doesn't model that cross-closure mutation and treats this as unreachably false — confirmed a known limitation (typescript-eslint#8113-class issue), not a bug in this code.
    if (!state.stopped) {
      state.timer = setTimeout(() => void loop(), options.pollIntervalMs);
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
