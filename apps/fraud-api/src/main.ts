// .env is loaded by preload.js (`-r ./preload.js`, see package.json's dev/
// start scripts) — BEFORE this file's own imports run. It has to happen
// there, not here: TypeScript's CommonJS output hoists every `import`
// below (including the AppModule chain, which calls loadConfig() at
// module-load time) above any statement written later in this file,
// regardless of source order. `./tracing-preload.js` (also `-r`'d, right
// after `./preload.js`) is the SAME fix applied to OpenTelemetry's HTTP
// instrumentation — see that file's doc comment for the real bug this
// caught: `registerHttpMetrics`/`registerMetricsEndpoint` were never the
// actual cause of what that file fixes, `startTracing()` being called
// from inside `bootstrap()` (i.e. here, too late) was.
import 'reflect-metadata';

import rateLimit from '@fastify/rate-limit';
import { loadConfig } from '@fraudguard/config';
import {
  getPreloadedTracingHandle,
  registerDefaultMetrics,
  registerHttpMetrics,
  registerMetricsEndpoint,
} from '@fraudguard/observability';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { registerSwagger } from './swagger';

/**
 * Fail Fast: loadConfig() runs before Nest even starts building the DI
 * graph, so a misconfigured process never gets as far as opening a port.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const bootstrapLogger = pino({ level: config.logging.level, base: { service: 'fraud-api' } });

  // The tracer provider itself was already started by tracing-preload.js,
  // before Fastify (and therefore `http`) was ever required — this just
  // retrieves the shutdown/forceFlush handle. FR-013/NFR-010/NFR-011, Phase 7.
  const tracing = getPreloadedTracingHandle();
  registerDefaultMetrics();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    {
      // Nest's own logger is disabled in favour of the Pino instance the
      // rest of the app uses (packages/observability tech choice) — one
      // structured JSON log format, not two.
      logger: false,
    },
  );

  // ADR-005 overload policy: shed load with 429 above a concurrency
  // ceiling rather than letting a queue grow past the latency budget.
  await app.register(rateLimit, {
    max: config.security.rateLimit.maxRequests,
    timeWindow: config.security.rateLimit.windowMs,
  });

  app.useGlobalFilters(new HttpExceptionFilter(bootstrapLogger));
  app.enableCors({ origin: false }); // no browser client exists yet; explicit opt-in later rather than an open default

  // Added directly on the underlying Fastify instance, not via
  // `app.register()` — see `registerHttpMetrics`'s doc comment for why
  // (Nest's own routes would otherwise fall outside these hooks'
  // encapsulation scope). `/metrics` is deliberately outside Nest's
  // module graph too — no auth guard, no rate limit — since the caller
  // is Prometheus, not an authenticated client (metrics-route.ts's doc
  // comment on why that's scoped to this local/Docker-internal setup).
  const fastify = app.getHttpAdapter().getInstance();
  if (config.observability.metricsEnabled) {
    registerHttpMetrics(fastify, 'fraud-api');
    registerMetricsEndpoint(fastify, config.observability.metricsPath);
  }

  await registerSwagger(app, bootstrapLogger);

  await app.listen(config.ports.fraudApi, '0.0.0.0');
  bootstrapLogger.info({ port: config.ports.fraudApi }, 'fraud-api listening');

  const shutdown = (signal: string): void => {
    bootstrapLogger.info({ signal }, 'fraud-api shutting down');
    void app
      .close()
      .then(() => tracing.shutdown())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- nothing else can log yet if bootstrap itself failed
  console.error('fraud-api failed to start', error);
  process.exit(1);
});
