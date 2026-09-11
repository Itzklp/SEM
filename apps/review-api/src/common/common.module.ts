import { Global, Module } from '@nestjs/common';

import { configProvider, APP_CONFIG } from './config.provider';
import { loggerProvider, LOGGER } from './logger.provider';
import {
  persistenceProviders,
  CASE_REPOSITORY,
  PERSISTENCE_CONTEXT,
  TRANSACTION_REPOSITORY,
} from './persistence.provider';

@Global()
@Module({
  providers: [configProvider, loggerProvider, ...persistenceProviders],
  exports: [APP_CONFIG, LOGGER, PERSISTENCE_CONTEXT, CASE_REPOSITORY, TRANSACTION_REPOSITORY],
})
export class CommonModule {}
