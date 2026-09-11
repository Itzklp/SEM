import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { Resource } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TracingOptions {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly otlpEndpoint: string;
  readonly tracesSamplerArg: number;
}

export interface TracingHandle {
  readonly shutdown: () => Promise<void>;
  /** Forces buffered spans to export immediately rather than waiting for `BatchSpanProcessor`'s scheduled delay — exists for tests that need to assert against a real backend (Jaeger) without an arbitrary sleep. */
  readonly forceFlush: () => Promise<void>;
}

const NOOP_HANDLE: TracingHandle = {
  shutdown: () => Promise.resolve(),
  forceFlush: () => Promise.resolve(),
};

/**
 * Must match `GLOBAL_KEY` in `packages/observability/preload-tracing.js`
 * exactly — see `getPreloadedTracingHandle()`'s doc comment.
 */
const GLOBAL_TRACING_KEY = '__fraudguardTracingHandle__';

/**
 * Reads the tracer-provider handle `preload-tracing.js` already built
 * and stashed on `globalThis` — what every real app (`fraud-api`,
 * `review-api`, `event-worker`) calls from `bootstrap()`/`main()` now,
 * instead of `startTracing()` below. `startTracing()` itself still
 * builds a provider correctly; the problem was never its logic, only
 * WHEN it ran relative to Fastify's own `require('http')` — see
 * `preload-tracing.js`'s doc comment for the real bug this fixed
 * (caught against a live running process, not a test: the Nest test
 * harness used by every `*.integration.test.ts` file bypasses `main.ts`
 * entirely, so no automated test could have caught a main.ts-bootstrap-
 * ORDER bug). Returns the no-op handle if the preload never ran — e.g.
 * under Jest, where `startTracing()` (called directly, as
 * `tests/integration/observability.integration.test.ts` does) is still
 * the right tool, since a test file importing this module dynamically at
 * test time has no "first thing the process does" moment to protect.
 */
export function getPreloadedTracingHandle(): TracingHandle {
  const stashed = (globalThis as Record<string, unknown>)[GLOBAL_TRACING_KEY];
  return (stashed as TracingHandle | undefined) ?? NOOP_HANDLE;
}

/**
 * Starts this process's tracer provider — call once, as early as possible
 * in `bootstrap()` (after `loadConfig()`, before `NestFactory.create()` /
 * before any Kafka client connects), per app. Returns a `shutdown()` to
 * call on SIGTERM/SIGINT so buffered spans flush before the process exits
 * rather than being silently dropped.
 *
 * NOT what a real app's `main.ts` calls any more — see
 * `getPreloadedTracingHandle()`'s doc comment. Kept for callers that
 * construct a tracer provider mid-process, after other modules (Fastify
 * included) are already loaded — tests, mainly, where the "before the
 * first `require('http')`" timing this whole preload exists for does not
 * apply the same way.
 *
 * Deliberately registers ONLY `HttpInstrumentation` here, not the
 * `pg`/`ioredis`/`kafkajs` auto-instrumentation packages OpenTelemetry
 * also publishes. Every Redis/Postgres/Kafka call this system makes
 * already passes through one of `@fraudguard/feature-store`,
 * `@fraudguard/persistence` or `@fraudguard/messaging` — three small,
 * already-enumerable sets of call sites — and `measure.ts`'s `measure()`
 * wraps each one with BOTH a span and the matching Prometheus histogram
 * observation, at the exact same point, using the exact same label. Two
 * separate instrumentation mechanisms measuring the same operation
 * (auto-instrumentation's span timing vs. this package's histogram
 * timing) would drift out of agreement the first time either library
 * changes what it considers the operation's start/end; one mechanism
 * producing both numbers cannot drift from itself. `HttpInstrumentation`
 * is kept because it is the one thing this system does NOT otherwise
 * wrap by hand — the inbound request itself, and outbound calls this
 * system does not already instrument (none exist yet, but a future
 * outbound HTTP call — e.g. Phase 10's `ml-service` client — gets a span
 * for free rather than silently going dark).
 */
export function startTracing(options: TracingOptions): TracingHandle {
  if (!options.enabled) {
    return NOOP_HANDLE;
  }

  const resource = new Resource({ [ATTR_SERVICE_NAME]: options.serviceName });
  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(options.tracesSamplerArg),
  });
  const exporter = new OTLPTraceExporter({ url: `${options.otlpEndpoint}/v1/traces` });
  // `spanProcessors` in the constructor, not the deprecated
  // `addSpanProcessor()` call after construction — same span processor,
  // just the API the installed SDK version asks for it through now.
  const provider = new NodeTracerProvider({
    resource,
    sampler,
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  provider.register({
    contextManager: new AsyncHooksContextManager().enable(),
    propagator: new W3CTraceContextPropagator(),
  });

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [new HttpInstrumentation()],
  });

  return {
    shutdown: async () => {
      await provider.shutdown();
    },
    forceFlush: async () => {
      await provider.forceFlush();
    },
  };
}
