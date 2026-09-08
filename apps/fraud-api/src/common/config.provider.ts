import type { AppConfig } from '@fraudguard/config';
import { loadConfig } from '@fraudguard/config';
import type { Provider } from '@nestjs/common';

/** DI token for the validated `AppConfig` — loaded once, at module registration, not per-request. */
export const APP_CONFIG = Symbol('APP_CONFIG');

export const configProvider: Provider = {
  provide: APP_CONFIG,
  // "Fail Fast": loadConfig() throws ConfigValidationError synchronously
  // if anything is missing/invalid, which surfaces at Nest bootstrap time
  // — the process never accepts a request with bad configuration.
  useValue: loadConfig() satisfies AppConfig,
};
