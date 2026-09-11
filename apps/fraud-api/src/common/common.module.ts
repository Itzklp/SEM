import { Global, Module } from '@nestjs/common';

import { configProvider, APP_CONFIG } from './config.provider';
import { loggerProvider, LOGGER } from './logger.provider';
import {
  persistenceProviders,
  PERSISTENCE_CONTEXT,
  TRANSACTION_REPOSITORY,
} from './persistence.provider';
import { policyStoreProvider, POLICY_STORE } from './policy-store';
import { redisProvider, REDIS_CLIENT } from './redis.provider';

/**
 * Config, logging, Redis, persistence and the runtime policy store are
 * cross-cutting — every feature module needs at least one of them.
 * `@Global()` means declaring them once here beats redeclaring the same
 * providers per module (which would create a second Redis connection
 * pool, a second Postgres pool, or — for `PolicyStore` — a second,
 * independently-mutable "current policy" that silently disagrees with
 * the first).
 */
@Global()
@Module({
  providers: [
    configProvider,
    loggerProvider,
    redisProvider,
    policyStoreProvider,
    ...persistenceProviders,
  ],
  exports: [
    APP_CONFIG,
    LOGGER,
    REDIS_CLIENT,
    POLICY_STORE,
    PERSISTENCE_CONTEXT,
    TRANSACTION_REPOSITORY,
  ],
})
export class CommonModule {}
