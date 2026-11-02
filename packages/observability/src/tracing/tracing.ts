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
  /** Forces buffered spans to export immediately, instead of waiting for BatchSpanProcessor's scheduled delay — for tests asserting against a real backend without an arbitrary sleep. */
  readonly forceFlush: () => Promise<void>;
}

const NOOP_HANDLE: TracingHandle = {
  shutdown: () => Promise.resolve(),
  forceFlush: () => Promise.resolve(),
};

/** Must match GLOBAL_KEY in preload-tracing.js exactly. */
const GLOBAL_TRACING_KEY = '__fraudguardTracingHandle__';

/**
 * Reads the tracer-provider handle preload-tracing.js already built and
 * stashed on globalThis — what every real app's bootstrap()/main() calls
 * now, instead of startTracing() below (whose issue was never its logic,
 * only running too late relative to Fastify's own require('http')).
 * Returns the no-op handle if the preload never ran, e.g. under Jest,
 * where startTracing() called directly is still the right tool.
 */
export function getPreloadedTracingHandle(): TracingHandle {
  const stashed = (globalThis as Record<string, unknown>)[GLOBAL_TRACING_KEY];
  return (stashed as TracingHandle | undefined) ?? NOOP_HANDLE;
}

/**
 * Starts this process's tracer provider. No longer what a real app's
 * main.ts calls (see getPreloadedTracingHandle()) — kept for callers that
 * construct a provider mid-process, mainly tests.
 *
 * Registers only HttpInstrumentation, not the pg/ioredis/kafkajs
 * auto-instrumentation packages OpenTelemetry also publishes: every
 * Redis/Postgres/Kafka call already passes through measure(), which wraps
 * it with both a span and the matching Prometheus histogram at the same
 * point — two separate instrumentation mechanisms for the same operation
 * would drift from each other the moment either library's notion of
 * start/end changed. HttpInstrumentation stays because inbound/outbound
 * HTTP isn't wrapped by hand anywhere else.
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
