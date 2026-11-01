import type { AppConfig } from '@fraudguard/config';
import {
  CaseRepository,
  createPersistenceContext,
  TransactionRepository,
  ModelRegistryRepository,
  type PersistenceContext,
} from '@fraudguard/persistence';
import type { Provider } from '@nestjs/common';

import { APP_CONFIG } from './config.provider';

export const PERSISTENCE_CONTEXT = Symbol('PERSISTENCE_CONTEXT');
export const CASE_REPOSITORY = Symbol('CASE_REPOSITORY');
export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');
export const MODEL_REGISTRY_REPOSITORY = Symbol('MODEL_REGISTRY_REPOSITORY');

/**
 * `coldDb` only — review-api is exactly the "cold path" `createPools`'s
 * doc comment describes: heavy, unbounded analyst queries that must
 * never compete with `fraud-api`'s hot-path connections (ADR-004's
 * bulkhead). This app never touches `hotPool`/`hotDb` at all.
 */
export const persistenceProviders: Provider[] = [
  {
    provide: PERSISTENCE_CONTEXT,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig): PersistenceContext => createPersistenceContext(config),
  },
  {
    provide: CASE_REPOSITORY,
    inject: [PERSISTENCE_CONTEXT],
    useFactory: (ctx: PersistenceContext): CaseRepository => new CaseRepository(ctx.coldDb),
  },
  {
    provide: TRANSACTION_REPOSITORY,
    inject: [PERSISTENCE_CONTEXT],
    useFactory: (ctx: PersistenceContext): TransactionRepository =>
      new TransactionRepository(ctx.coldDb),
  },
  {
    provide: MODEL_REGISTRY_REPOSITORY,
    inject: [PERSISTENCE_CONTEXT],
    useFactory: (ctx: PersistenceContext): ModelRegistryRepository =>
      new ModelRegistryRepository(ctx.coldDb),
  },
];
