import { Global, Module } from '@nestjs/common';

import { configProvider, APP_CONFIG } from './config.provider';
import { loggerProvider, LOGGER } from './logger.provider';
import {
  persistenceProviders,
  PERSISTENCE_CONTEXT,
  TRANSACTION_REPOSITORY,
} from './persistence.provider';
import { redisProvider, REDIS_CLIENT } from './redis.provider';

/**
 * Config, logging, Redis and persistence are cross-cutting — every feature
 * module needs at least one of them. `@Global()` means declaring them once
 * here beats redeclaring the same providers per module (which would create
 * a second Redis connection pool, a second Postgres pool, etc. — a subtle
 * and expensive bug).
 */
@Global()
@Module({
  providers: [configProvider, loggerProvider, redisProvider, ...persistenceProviders],
  exports: [APP_CONFIG, LOGGER, REDIS_CLIENT, PERSISTENCE_CONTEXT, TRANSACTION_REPOSITORY],
})
export class CommonModule {}
