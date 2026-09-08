import type { AppConfig } from '@fraudguard/config';
import {
  createPersistenceContext,
  TransactionRepository,
  type PersistenceContext,
} from '@fraudguard/persistence';
import type { Provider } from '@nestjs/common';

import { APP_CONFIG } from './config.provider';

export const PERSISTENCE_CONTEXT = Symbol('PERSISTENCE_CONTEXT');
export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');

export const persistenceProviders: Provider[] = [
  {
    provide: PERSISTENCE_CONTEXT,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): PersistenceContext => createPersistenceContext(config),
  },
  {
    provide: TRANSACTION_REPOSITORY,
    inject: [PERSISTENCE_CONTEXT],
    // hotPool/hotDb only — the bulkhead (ADR-004). fraud-api never touches coldDb.
    useFactory: (ctx: PersistenceContext): TransactionRepository =>
      new TransactionRepository(ctx.hotDb),
  },
];
