import type { AppConfig } from '@fraudguard/config';
import type { Provider } from '@nestjs/common';
import pino, { type Logger } from 'pino';

import { APP_CONFIG } from './config.provider';

export const LOGGER = Symbol('LOGGER');

export const loggerProvider: Provider = {
  provide: LOGGER,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): Logger =>
    pino({
      level: config.logging.level,
      base: { service: 'review-api' },
      ...(config.logging.pretty ? { transport: { target: 'pino-pretty' } } : {}),
    }),
};
