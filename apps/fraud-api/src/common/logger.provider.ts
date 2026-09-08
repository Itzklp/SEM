import type { AppConfig } from '@fraudguard/config';
import type { Provider } from '@nestjs/common';
import pino, { type Logger } from 'pino';

import { APP_CONFIG } from './config.provider';

/**
 * Structured JSON logging (NFR-010) via Pino — chosen for low overhead on
 * the hot path over more feature-rich loggers (ARCHITECTURE.md tech
 * table). `LOG_PRETTY` must be false under load: pretty-printing is a
 * synchronous transform on every log line, and that cost is exactly what
 * ADR-003's budget has no room for.
 */
export const LOGGER = Symbol('LOGGER');

export const loggerProvider: Provider = {
  provide: LOGGER,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): Logger =>
    // exactOptionalPropertyTypes forbids `transport: undefined` — the key
    // must be absent, not present-with-undefined. Spread it in only when needed.
    pino({
      level: config.logging.level,
      base: { service: 'fraud-api' },
      ...(config.logging.pretty ? { transport: { target: 'pino-pretty' } } : {}),
    }),
};
