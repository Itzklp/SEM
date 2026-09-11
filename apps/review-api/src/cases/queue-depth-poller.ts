import { reviewQueueDepth } from '@fraudguard/observability';
import type { CaseRepository } from '@fraudguard/persistence';
import type { Logger } from 'pino';

export interface PollerHandle {
  readonly stop: () => void;
}

/** `review_queue_depth` — ADR-005: "review-queue depth is a monitored, alertable signal." Same poller shape as `apps/event-worker/src/metrics/outbox-gauge-poller.ts`; review-api is a plain request/response NestJS app with no other background loop, so this one is started directly from `main.ts`, not through Nest's DI. */
export function startQueueDepthPoller(options: {
  readonly caseRepository: CaseRepository;
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
      const count = await options.caseRepository.countByStatus('OPEN');
      reviewQueueDepth.set(count);
    } catch (error) {
      options.logger.warn(
        { err: error },
        'Review queue depth poll cycle failed — retried next tick',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- same cross-closure-mutation-across-an-await limitation documented in apps/event-worker/src/relay/outbox-relay.ts's identical loop.
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
