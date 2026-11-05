// .env/tracing preloads — see apps/fraud-api/src/main.ts's doc comment for why.
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

/** No measured SLO yet; matches event-worker's gauge-poller cadence. */
const QUEUE_DEPTH_POLL_INTERVAL_MS = 5_000;

/**
 * The analyst-facing cold path (architecture.md's bulkhead rationale): a
 * separate deployable with its own Postgres pool, so heavy query load here
 * can never starve fraud-api's hot-path connections. No rate limiting —
 * ADR-005's overload-shedding protects an authorization's latency budget,
 * which this app doesn't have.
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
  app.enableCors({ origin: config.security.webAppOrigin }); // apps/web is the one browser client allowed to call this directly

  // Same reasoning as fraud-api's main.ts: unauthenticated, outside Nest's
  // module graph — Prometheus is the caller, not an authenticated analyst.
  const fastify = app.getHttpAdapter().getInstance();
  if (config.observability.metricsEnabled) {
    registerHttpMetrics(fastify, 'review-api');
    registerMetricsEndpoint(fastify, config.observability.metricsPath);
  }

  await registerSwagger(app, bootstrapLogger);

  await app.listen(config.ports.reviewApi, '0.0.0.0');
  bootstrapLogger.info({ port: config.ports.reviewApi }, 'review-api listening');

  // review_queue_depth (ADR-005). Started here rather than via Nest DI since
  // this app otherwise has no background loop.
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
