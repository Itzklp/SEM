// Plain JS, loaded via `-r` before any other module in each app's
// dev/start script (see each app's own tracing-preload.js and
// docs/adr/ADR-007-observability-stack.md). Must run before Fastify's own
// require('http'), or HttpInstrumentation's patch never takes effect —
// calling tracing setup from inside bootstrap() is too late, since
// TypeScript's CommonJS output hoists main.ts's imports above it.
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} = require('@opentelemetry/sdk-trace-base');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
const { AsyncHooksContextManager } = require('@opentelemetry/context-async-hooks');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');

// Must match `GLOBAL_TRACING_KEY` in src/tracing/tracing.ts exactly —
// this is the one handshake point between this plain-JS preload and the
// TypeScript code that reads the handle back in `bootstrap()`.
const GLOBAL_KEY = '__fraudguardTracingHandle__';

function parseBooleanEnv(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1') {
    return true;
  }
  if (normalised === 'false' || normalised === '0') {
    return false;
  }
  return fallback;
}

/**
 * Called once at the top of each app's dev/start script, before
 * tsconfig-paths/register. Reads OTEL_* straight from process.env rather
 * than @fraudguard/config's loadConfig(), since that TypeScript module
 * isn't resolvable yet at this point in the -r chain.
 */
function start(serviceName) {
  const enabled = parseBooleanEnv(process.env.OTEL_ENABLED, true);
  if (!enabled) {
    global[GLOBAL_KEY] = { shutdown: () => Promise.resolve(), forceFlush: () => Promise.resolve() };
    return;
  }

  const resource = new Resource({ [ATTR_SERVICE_NAME]: serviceName });
  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? '0.1')),
  });
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  const exporter = new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` });
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

  global[GLOBAL_KEY] = {
    shutdown: () => provider.shutdown(),
    forceFlush: () => provider.forceFlush(),
  };
}

module.exports = { start };
