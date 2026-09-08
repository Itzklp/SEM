import type { AppConfig } from '@fraudguard/config';
import { createRedisClient } from '@fraudguard/feature-store';
import type { Provider } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { APP_CONFIG } from './config.provider';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [APP_CONFIG],
  useFactory: (config: AppConfig): Redis => createRedisClient(config),
};
