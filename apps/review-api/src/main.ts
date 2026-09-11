// .env is loaded by preload.js — see apps/fraud-api/src/main.ts's doc
// comment for why that has to happen outside this file's own import graph.
import 'reflect-metadata';

import { loadConfig } from '@fraudguard/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import pino from 'pino';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { registerSwagger } from './swagger';

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

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { logger: false },
  );

  app.useGlobalFilters(new HttpExceptionFilter(bootstrapLogger));
  app.enableCors({ origin: false });

  await registerSwagger(app, bootstrapLogger);

  await app.listen(config.ports.reviewApi, '0.0.0.0');
  bootstrapLogger.info({ port: config.ports.reviewApi }, 'review-api listening');
}

bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- nothing else can log yet if bootstrap itself failed
  console.error('review-api failed to start', error);
  process.exit(1);
});
