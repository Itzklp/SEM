import type { AppConfig } from '@fraudguard/config';
import pino, { type Logger } from 'pino';

/** Same reasoning as apps/fraud-api/src/common/logger.provider.ts — no NestJS DI here, so a plain factory rather than a `Provider` object. */
export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.logging.level,
    base: { service: 'event-worker' },
    ...(config.logging.pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
