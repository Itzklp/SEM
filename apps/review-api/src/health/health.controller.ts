import type { PersistenceContext } from '@fraudguard/persistence';
import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from 'pg';

import { PERSISTENCE_CONTEXT } from '../common/persistence.provider';

interface DependencyHealth {
  status: 'up' | 'down';
  latencyMs: number;
}

/**
 * FR-013. No auth. Unlike fraud-api's health check, there is no Redis
 * dependency to report — review-api never touches Redis (it is not part
 * of this app's path at all). Postgres down is the only degradation
 * mode this app has, so "down" maps straight to `unhealthy`, not a
 * softer "degraded" — there is no cautious-open equivalent for an
 * analyst-facing query API the way there is for the hot path (ADR-005
 * is about `fraud-api`'s decision, not this app's queries).
 */
@Controller('api/v1/health')
export class HealthController {
  constructor(@Inject(PERSISTENCE_CONTEXT) private readonly persistence: PersistenceContext) {}

  @Get()
  async check(): Promise<{
    status: 'healthy' | 'unhealthy';
    dependencies: Record<string, DependencyHealth>;
  }> {
    const postgres = await this.checkPostgres(this.persistence.coldPool);
    return {
      status: postgres.status === 'up' ? 'healthy' : 'unhealthy',
      dependencies: { postgres },
    };
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
}
