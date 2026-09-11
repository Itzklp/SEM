import { outboxPendingTotal } from '@fraudguard/observability';
import type { OutboxRepository } from '@fraudguard/persistence';
import type { Logger } from 'pino';

export interface PollerHandle {
  readonly stop: () => void;
}

/** `outbox_pending_total` — ADR-006: "backlog depth is a directly measurable health signal." Polled here (cold path, `coldDb`), never from `fraud-api` (ADR-003: the hot path must not add a Postgres read it doesn't already need just to serve a dashboard). */
export function startOutboxGaugePoller(options: {
  readonly outboxRepository: OutboxRepository;
  readonly intervalMs: number;
  readonly logger: Logger;
}): PollerHandle {
  const state: { stopped: boolean; timer: ReturnType<typeof setTimeout> | undefined } = {
    stopped: false,
    timer: undefined,
  };

  async function loop(): Promise<void> {
    if (state.stopped) {
      return;
    }
    try {
      const count = await options.outboxRepository.countUnpublished();
      outboxPendingTotal.set(count);
    } catch (error) {
      options.logger.warn({ err: error }, 'Outbox gauge poll cycle failed — retried next tick');
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
