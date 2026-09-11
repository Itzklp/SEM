import type { AppConfig } from '@fraudguard/config';
import { loadConfig } from '@fraudguard/config';
import type { Provider } from '@nestjs/common';

/** Identical pattern to fraud-api's — "Fail Fast" at Nest bootstrap, not on the first request. */
export const APP_CONFIG = Symbol('APP_CONFIG');

export const configProvider: Provider = {
  provide: APP_CONFIG,
  useValue: loadConfig() satisfies AppConfig,
};
