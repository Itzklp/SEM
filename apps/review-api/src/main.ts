// .env is loaded by preload.js — see apps/fraud-api/src/main.ts's doc
// comment for why that has to happen outside this file's own import
// graph; ./tracing-preload.js is the same fix for OpenTelemetry's HTTP
// instrumentation (packages/observability/preload-tracing.js's doc
// comment has the real bug this caught).
import 'reflect-metadata';

import { loadConfig } from '@fraudguard/config';
import {
  getPreloadedTracingHandle,
  registerDefaultMetrics,
  registerHttpMetrics,
  registerMetricsEndpoint,
} from '@fraudguard/observability';
import type { CaseRepository } from '@fraudguard/persistence';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';

import { AppModule } from './app.module';
import { startQueueDepthPoller } from './cases/queue-depth-poller';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { CASE_REPOSITORY } from './common/persistence.provider';
import { registerSwagger } from './swagger';

/** ASSUMED — no measured SLO to tune this against yet; matches the rough cadence `apps/event-worker`'s gauge pollers use. */
const QUEUE_DEPTH_POLL_INTERVAL_MS = 5_000;

/**
 * The analyst-facing cold path (ARCHITECTURE.md's bulkhead rationale):
 * heavy, unbounded query load that must never be able to starve
 * `fraud-api`'s hot-path connections — which is why this is a wholly
 * separate deployable with its own Postgres pool (`coldPool`), not a
 * module inside `fraud-api`. No rate limiting here (unlike fraud-api) —
 * ADR-005's overload-shedding policy is specifically about protecting
 * the latency budget of a payment authorization; this app has no such
 * budget to protect.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const bootstrapLogger = pino({ level: config.logging.level, base: { service: 'review-api' } });

  const tracing = getPreloadedTracingHandle();
  registerDefaultMetrics();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { logger: false },
  );

  app.useGlobalFilters(new HttpExceptionFilter(bootstrapLogger));
  app.enableCors({ origin: false });

  // Same reasoning as apps/fraud-api/src/main.ts — directly on the
  // underlying Fastify instance, unauthenticated, outside Nest's module
  // graph (Prometheus is the caller, not an authenticated analyst).
  const fastify = app.getHttpAdapter().getInstance();
  if (config.observability.metricsEnabled) {
    registerHttpMetrics(fastify, 'review-api');
    registerMetricsEndpoint(fastify, config.observability.metricsPath);
  }

  await registerSwagger(app, bootstrapLogger);

  await app.listen(config.ports.reviewApi, '0.0.0.0');
  bootstrapLogger.info({ port: config.ports.reviewApi }, 'review-api listening');

  // `review_queue_depth` (ADR-005: "review-queue depth is a monitored,
  // alertable signal") — started from here, not Nest DI, since this app
  // otherwise has no background loop; `app.get()` reaches into the
  // already-built DI graph for the one repository it needs.
  const queueDepthPoller = startQueueDepthPoller({
    caseRepository: app.get<CaseRepository>(CASE_REPOSITORY),
    intervalMs: QUEUE_DEPTH_POLL_INTERVAL_MS,
    logger: bootstrapLogger,
  });

  const shutdown = (signal: string): void => {
    bootstrapLogger.info({ signal }, 'review-api shutting down');
    queueDepthPoller.stop();
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
  console.error('review-api failed to start', error);
  process.exit(1);
});
