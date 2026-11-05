// .env and tracing are loaded via `-r` preloads (package.json's dev/start
// scripts), before this file's imports run — TypeScript's CommonJS output
// hoists them above anything written later here, so setup from inside
// bootstrap() would run too late.
import 'reflect-metadata';

import rateLimit from '@fastify/rate-limit';
import { loadConfig } from '@fraudguard/config';
import { setMerchantRiskScore } from '@fraudguard/feature-store';
import {
  getPreloadedTracingHandle,
  registerDefaultMetrics,
  registerHttpMetrics,
  registerMetricsEndpoint,
} from '@fraudguard/observability';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import pino from 'pino';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { registerLoadShedding } from './common/load-shedding';
import { REDIS_CLIENT } from './common/redis.provider';
import { registerSwagger } from './swagger';

/**
 * Real merchant/IP risk seeding is still an open Phase 5 item
 * (risk-lookup.ts's doc comment) — until then, apps/web's "simulate a
 * suspicious payment" preset needs at least one merchant it can rely on
 * actually being risky. Idempotent (plain SET), cheap, safe to redo on
 * every boot.
 */
export const DEMO_HIGH_RISK_MERCHANT_ID = 'merchant_demo_high_risk';

/**
 * Fail Fast: loadConfig() runs before Nest even starts building the DI
 * graph, so a misconfigured process never gets as far as opening a port.
 */
async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const bootstrapLogger = pino({ level: config.logging.level, base: { service: 'fraud-api' } });

  // tracing-preload.js already started the tracer provider; this just gets
  // the shutdown/forceFlush handle back. FR-013/NFR-010/NFR-011.
  const tracing = getPreloadedTracingHandle();
  registerDefaultMetrics();

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    {
      logger: false, // Pino handles logging for the rest of the app; no need for a second format
    },
  );

  // ADR-005 rate limiting: per-client token bucket, keyed by IP — distinct
  // from registerLoadShedding's concurrency ceiling below.
  await app.register(rateLimit, {
    max: config.security.rateLimit.maxRequests,
    timeWindow: config.security.rateLimit.windowMs,
  });

  app.useGlobalFilters(new HttpExceptionFilter(bootstrapLogger));
  app.enableCors({ origin: config.security.webAppOrigin }); // apps/web is the one browser client allowed to call this directly

  // Registered on the raw Fastify instance, not via app.register(), so these
  // hooks apply outside Nest's own route encapsulation. /metrics has no
  // auth/rate-limit — the caller is Prometheus, not an authenticated client.
  const fastify = app.getHttpAdapter().getInstance();
  if (config.observability.metricsEnabled) {
    registerHttpMetrics(fastify, 'fraud-api');
    registerMetricsEndpoint(fastify, config.observability.metricsPath);
  }
  // After registerHttpMetrics so a shed (429) request still shows up in the
  // request metrics before being short-circuited. ADR-005's overload row.
  registerLoadShedding(fastify, config.security.maxConcurrentRequests);

  await registerSwagger(app, bootstrapLogger);

  await app.listen(config.ports.fraudApi, '0.0.0.0');
  bootstrapLogger.info({ port: config.ports.fraudApi }, 'fraud-api listening');

  // Best-effort: the demo merchant seed must never be able to take the
  // whole service down. The Redis client connects asynchronously, so
  // 'ready' isn't guaranteed yet the instant app.listen() resolves.
  try {
    const redis = app.get<Redis>(REDIS_CLIENT);
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve) => {
        redis.once('ready', () => {
          resolve();
        });
      });
    }
    await setMerchantRiskScore(redis, DEMO_HIGH_RISK_MERCHANT_ID, 0.95);
  } catch (error) {
    bootstrapLogger.warn({ error }, 'could not seed the demo high-risk merchant — apps/web’s "suspicious payment" preset will read as neutral until this succeeds');
  }

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
