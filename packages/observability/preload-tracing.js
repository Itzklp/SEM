// Plain JS (NOT compiled from TypeScript), loaded via `-r` BEFORE any
// other module in each app's dev/start script — see each app's own
// `tracing-preload.js` and docs/adr/ADR-007-observability-stack.md.
//
// Exists as plain JS, not as `startTracing()` in `src/tracing/tracing.ts`
// (which remains the right tool for tests — it runs fine called directly
// from within an already-running process), for exactly the reason
// `apps/fraud-api/preload.js` documents for dotenv: TypeScript's
// CommonJS output hoists every `import` in `main.ts` above any code
// written later in that same file, so calling tracing setup from inside
// `bootstrap()` happens AFTER Fastify/`@nestjs/platform-fastify` (and
// therefore `http`) have already been required.
//
// CAUGHT LIVE, not assumed: a real scored transaction through a real
// running `fraud-api` (not the Nest test harness, which bypasses
// `main.ts` entirely and therefore could never have caught this)
// produced `redis.*`/`db.*`/`score.*` spans in Jaeger — proving the SDK
// pipeline itself (provider, exporter, Jaeger ingestion) worked — but NO
// root HTTP span wrapping them, proving `HttpInstrumentation`'s patch
// never actually took effect for this process's real `http.Server`.
// Moving the instrumentation registration into a `-r` preload — so it
// installs before Fastify's own `require('http')` — fixed it.
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
 * Called once, at the very top of each app's dev/start script, before
 * `tsconfig-paths/register` — see each app's `tracing-preload.js`.
 * Reads OTEL_* directly from `process.env` rather than going through
 * `@fraudguard/config`'s `loadConfig()`: that package is TypeScript
 * source, resolved via `tsconfig-paths`, which has not registered yet at
 * this point in the `-r` chain — the whole reason this file is plain JS.
 * `.env` itself IS already loaded by this point (`preload.js`'s dotenv
 * call precedes this one in every app's script), so `process.env` is
 * complete; only the typed/validated wrapper is unavailable here.
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
