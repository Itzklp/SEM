import type { PersistenceContext } from '@fraudguard/persistence';
import { Controller, Get, Inject } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { PERSISTENCE_CONTEXT } from '../common/persistence.provider';
import { REDIS_CLIENT } from '../common/redis.provider';

interface DependencyHealth {
  status: 'up' | 'down' | 'degraded';
  latencyMs: number;
}

/**
 * FR-013. No auth (public — health checks are how orchestrators/monitoring
 * decide whether to route traffic here at all). Reports per-dependency
 * status so degradation (ADR-005) is visible before decisions changing is
 * the first sign anyone notices.
 */
@Controller('api/v1/health')
export class HealthController {
  constructor(
    @Inject(PERSISTENCE_CONTEXT) private readonly persistence: PersistenceContext,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<{
    status: 'healthy' | 'degraded' | 'unhealthy';
    dependencies: Record<string, DependencyHealth>;
  }> {
    const [postgres, redis] = await Promise.all([
      this.checkPostgres(this.persistence.hotPool),
      this.checkRedis(this.redis),
    ]);

    const dependencies = { postgres, redis };
    // Postgres down = unhealthy (ADR-005 fail-closed — the service cannot
    // durably record a decision). Redis down = degraded, not unhealthy —
    // the service still serves requests, in cautious-open mode.
    const status: 'healthy' | 'degraded' | 'unhealthy' =
      postgres.status === 'down' ? 'unhealthy' : redis.status === 'down' ? 'degraded' : 'healthy';

    return { status, dependencies };
  }

  private async checkPostgres(pool: Pool): Promise<DependencyHealth> {
    const start = Date.now();
    try {
      await pool.query('SELECT 1');
      return { status: 'up', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down', latencyMs: Date.now() - start };
    }
  }

  private async checkRedis(redis: Redis): Promise<DependencyHealth> {
    const start = Date.now();
    try {
      await redis.ping();
      return { status: 'up', latencyMs: Date.now() - start };
    } catch {
      return { status: 'down', latencyMs: Date.now() - start };
    }
  }
}
