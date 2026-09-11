import { collectDefaultMetrics, Registry } from 'prom-client';

/**
 * One registry per process, shared by every metric this package defines
 * (`definitions.ts`) and by anything an app registers directly. A second,
 * independent `Registry` per module would silently split `/metrics`'
 * output across two collectors that never see each other — there is
 * exactly one registry, created once, for the same reason there is
 * exactly one `PolicyStore` (`apps/fraud-api/src/common/policy-store.ts`).
 */
export const registry = new Registry();

/**
 * Node process/CPU/memory/event-loop metrics (`process_cpu_seconds_total`,
 * `nodejs_eventloop_lag_seconds`, `process_resident_memory_bytes`, ...) —
 * not named in the roadmap's explicit list, but free, standard, and
 * directly useful on the same dashboards (a degraded-decision spike that
 * lines up with an event-loop lag spike is a real diagnostic signal).
 * Guarded by `registerDefaultMetrics`, called once at process bootstrap —
 * calling `collectDefaultMetrics` twice against the same registry throws.
 */
let defaultMetricsRegistered = false;

export function registerDefaultMetrics(prefix = ''): void {
  if (defaultMetricsRegistered) {
    return;
  }
  collectDefaultMetrics({ register: registry, prefix });
  defaultMetricsRegistered = true;
}
